import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStreamableHttp2025Guard, defineAlexaMcpAppTool, loadAgentSkillManifest,
  parseAgentSkillMarkdown, runMcp2025ComplianceAudit, MCP_2025_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION } from '../src/index.js';
import { startReferenceServer } from '../src/reference-server.js';

const rpc = (id: number, method: string, params: object = {}) => ({ jsonrpc: '2.0', id, method, params });
const init = rpc(1, 'initialize', { protocolVersion: MCP_2025_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'tests', version: '1' } });
const post = (url: string, body: object, headers: Record<string, string> = {}) => fetch(url, {
  method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

describe('MCP 2025-11-25 reference endpoint', () => {
  let reference: Awaited<ReturnType<typeof startReferenceServer>>;
  beforeAll(async () => { reference = await startReferenceServer(); });
  afterAll(async () => { await reference.close(); });
  async function session() {
    const response = await post(reference.url, init);
    const id = response.headers.get('mcp-session-id')!;
    expect(response.status).toBe(200);
    expect(id).toBeTruthy();
    return id;
  }
  it('1. blocks disallowed or maliciously suffixed Origins before dispatch with JSON-RPC id null', async () => {
    for (const origin of ['https://untrusted.invalid', 'https://preview.e2b.app.attacker.invalid', 'null']) {
      const res = await post(reference.url, init, { Origin: origin });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { message: 'Forbidden Origin' } });
    }
  });
  it('2. negotiates protocol 2025-11-25 during initialize', async () => {
    const res = await post(reference.url, init);
    expect((await res.json()).result.protocolVersion).toBe(MCP_2025_PROTOCOL_VERSION);
  });
  it('3. issues visible ASCII UUID sessions and rejects absent IDs', async () => {
    const id = await session();
    expect(id).toMatch(/^[\x21-\x7e]+$/);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect((await post(reference.url, rpc(2, 'ping'))).status).toBe(400);
  });
  it('4. rejects invalid version header and accepts omitted legacy version', async () => {
    const id = await session();
    expect((await post(reference.url, rpc(2, 'ping'), { 'MCP-Session-Id': id, 'MCP-Protocol-Version': 'garbage' })).status).toBe(400);
    expect((await post(reference.url, rpc(2, 'ping'), { 'MCP-Session-Id': id })).status).toBe(200);
    expect(LEGACY_PROTOCOL_VERSION).toBe('2025-03-26');
  });
  it('5. returns empty 202 for notifications and client responses', async () => {
    const id = await session();
    for (const body of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 99, result: {} }]) {
      const res = await post(reference.url, body, { 'MCP-Session-Id': id });
      expect(res.status).toBe(202);
      expect(await res.text()).toBe('');
    }
  });
  it('6. advertises usable ui:// tool and resource metadata', async () => {
    const id = await session();
    const headers = { 'MCP-Session-Id': id, 'MCP-Protocol-Version': MCP_2025_PROTOCOL_VERSION };
    const tools = await (await post(reference.url, rpc(3, 'tools/list'), headers)).json();
    expect(tools.result.tools[0]._meta.ui.resourceUri).toBe('ui://status/card');
    const resource = await (await post(reference.url, rpc(4, 'resources/read', { uri: 'ui://status/card' }), headers)).json();
    expect(resource.result.contents[0].mimeType).toBe('text/html');
    const called = await (await post(reference.url, rpc(5, 'tools/call', { name: 'show_status', arguments: { label: 'ready' } }), headers)).json();
    expect(called.result.content[0].text).toBe('Status: ready');
  });
  it('7. GET SSE primes and reconnects using Last-Event-ID', async () => {
    const id = await session();
    const headers = { Accept: 'text/event-stream', 'MCP-Session-Id': id };
    const first = await fetch(reference.url, { headers });
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    const reader = first.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    const eventId = /id: ([^\n]+)/.exec(initial)?.[1];
    expect(eventId).toMatch(/:[0-9]+$/);
    await reader.cancel();
    const resumed = await fetch(reference.url, { headers: { ...headers, 'Last-Event-ID': eventId! } });
    expect(resumed.status).toBe(200);
    expect(resumed.headers.get('content-type')).toContain('text/event-stream');
    await resumed.body!.cancel();
  });
  it('8. DELETE terminates and future requests receive 404', async () => {
    const id = await session();
    const res = await fetch(reference.url, { method: 'DELETE', headers: { 'MCP-Session-Id': id } });
    expect(res.status).toBe(204);
    expect((await post(reference.url, rpc(6, 'ping'), { 'MCP-Session-Id': id })).status).toBe(404);
  });
  it('the live auditor reports eight passing checks', async () => {
    const report = await runMcp2025ComplianceAudit(reference.url);
    expect(report.checks).toHaveLength(8);
    expect(report.checks.every(check => check.passed)).toBe(true);
    expect(report.score).toBe('8/8 (100%)');
  });
});

describe('CLI', () => {
  it('runs an ephemeral 8/8 selftest, prints scorecard and JSON, and exits zero', () => {
    const result = spawnSync(process.execPath, ['dist/cli.js', 'selftest'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Score: 8/8 (100%)');
    expect(result.stdout).toContain('JSON report:');
    expect(result.stdout).toContain('"overallPassed": true');
  });
});

describe('API helpers', () => {
  it('replays recorded events with sequential per-stream IDs and terminates sessions', () => {
    const guard = createStreamableHttp2025Guard();
    const id = guard.createSession();
    const one = guard.recordSseEvent(id, 'message', { jsonrpc: '2.0', id: 1, result: {} });
    const two = guard.recordSseEvent(id, 'message', { jsonrpc: '2.0', id: 2, result: {} });
    expect(one.id.split(':')[0]).toBe(two.id.split(':')[0]);
    expect(Number(two.id.split(':')[1])).toBe(Number(one.id.split(':')[1]) + 1);
    expect(guard.getEventsAfter(id, one.id)).toEqual([two.formatted]);
    expect(guard.terminateSession(id)).toBe(true);
    expect(guard.hasSession(id)).toBe(false);
  });
  it('preserves generic input/output handler and rejects invalid UI metadata', async () => {
    const tool = defineAlexaMcpAppTool<{ label: string }, string>({
      name: 'hello', description: 'Say hello', inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
      uiResource: { uri: 'ui://hello/card', title: 'Hello', description: 'Card' }, handler: async args => args.label
    });
    expect(await tool.handler({ label: 'hi' }, { sessionId: 's', protocolVersion: MCP_2025_PROTOCOL_VERSION })).toBe('hi');
    expect(() => defineAlexaMcpAppTool({ ...tool, uiResource: { ...tool.uiResource, uri: 'http://invalid' as `ui://${string}` } })).toThrow();
  });
  it('parses and loads SKILL.md with strict frontmatter', () => {
    const markdown = `---\nname: example\ndescription: A skill\nversion: 1.0.0\nmcpSpecVersion: '2025-11-25'\ntriggers: [start]\ntools: [hello]\nuiResources: [ui://hello/card]\n---\n# Instructions\nUse hello.\n`;
    expect(parseAgentSkillMarkdown(markdown).tools).toEqual(['hello']);
    const directory = mkdtempSync(join(tmpdir(), 'alexa-kit-'));
    try { const file = join(directory, 'SKILL.md'); writeFileSync(file, markdown); expect(loadAgentSkillManifest(file).rawMarkdown).toBe(markdown); }
    finally { rmSync(directory, { recursive: true, force: true }); }
    expect(() => parseAgentSkillMarkdown(markdown.replace('ui://hello/card', 'not-a-ui'))).toThrow();
  });
});
