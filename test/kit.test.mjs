import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  createStreamableHttp2025Guard, defineAlexaMcpAppTool, parseAgentSkillMarkdown,
  runMcp2025ComplianceAudit, MCP_2025_PROTOCOL_VERSION
} from '../dist/index.js';

const skill = `---
name: example-skill
description: Shows the example UI
version: 1.0.0
mcpSpecVersion: '2025-11-25'
triggers:
  - show example
tools:
  - example
uiResources:
  - ui://example/view
---
# Instructions
Use the example tool.
`;
test('Agent Skill YAML validation and exact manifest', () => {
  const result = parseAgentSkillMarkdown(skill);
  assert.equal(result.name, 'example-skill');
  assert.equal(result.rawMarkdown, skill);
  assert.throws(() => parseAgentSkillMarkdown(skill.replace('ui://example/view', 'https://elsewhere')));
  assert.throws(() => parseAgentSkillMarkdown('---\nname: x\n---\n'));
});
test('tool helper validates ui resources without changing generic handler', async () => {
  const definition = { name: 'example', description: 'Example', inputSchema: { type: 'object', properties: {} },
    uiResource: { uri: 'ui://example/view', title: 'Example', description: 'Example UI' }, handler: async args => args };
  assert.equal(defineAlexaMcpAppTool(definition), definition);
  assert.rejects(Promise.resolve().then(() => defineAlexaMcpAppTool({ ...definition, uiResource: { ...definition.uiResource, uri: 'http://bad' } })));
});
async function fixture() {
  const guard = createStreamableHttp2025Guard();
  const server = createServer(async (req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method === 'POST') {
      let text = '';
      for await (const chunk of req) text += chunk;
      try { req.body = JSON.parse(text); } catch { res.writeHead(400).end(); return; }
    }
    guard.middleware(req, res, () => {
      res.setHeader('Content-Type', 'application/json');
      const { method, id } = req.body;
      const result = method === 'initialize'
        ? { protocolVersion: MCP_2025_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
        : method === 'tools/list' ? { tools: [{ name: 'example', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { resourceUri: 'ui://example/view' } } }] }
          : {};
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, guard, url: `http://127.0.0.1:${server.address().port}/mcp` };
}
test('guard and live audit: handshake, security, SSE replay, termination', async () => {
  const { server, guard, url } = await fixture();
  try {
    const report = await runMcp2025ComplianceAudit(url);
    assert.equal(report.score, '8/8 (100%)', JSON.stringify(report.checks));
    const init = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_2025_PROTOCOL_VERSION } }) });
    const id = init.headers.get('mcp-session-id');
    assert.ok(guard.hasSession(id));
    const event1 = guard.recordSseEvent(id, 'message', { jsonrpc: '2.0', method: 'notifications/progress' });
    const event2 = guard.recordSseEvent(id, 'message', { jsonrpc: '2.0', method: 'notifications/next' });
    assert.match(event1.id, /:1$/);
    assert.deepEqual(guard.getEventsAfter(id, event1.id), [event2.formatted]);
    const replay = await fetch(url, { headers: { Accept: 'text/event-stream', 'MCP-Session-Id': id, 'Last-Event-ID': event1.id } });
    const chunk = await replay.body.getReader().read();
    assert.match(new TextDecoder().decode(chunk.value), /notifications\/next/);
    await replay.body.cancel().catch(() => {});
    assert.equal(guard.terminateSession(id), true);
    assert.equal(guard.hasSession(id), false);
    const attack = await fetch(url, { headers: { Origin: 'https://evil.e2b.app.attacker.test', Accept: 'text/event-stream' } });
    assert.equal(attack.status, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
