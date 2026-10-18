import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

export const MCP_2025_PROTOCOL_VERSION = '2025-11-25';
export const LEGACY_PROTOCOL_VERSION = '2025-03-26';

export interface StreamableHttp2025Options {
  allowedOrigins?: (string | RegExp)[];
  requireSessionId?: boolean;
  supportedVersions?: string[];
  enableSseResumption?: boolean;
}
export interface AlexaMcpUiResourceMeta {
  uri: `ui://${string}`;
  title: string;
  description: string;
  mimeType?: string;
  aspectRatio?: '16:9' | '4:3' | '1:1' | 'auto';
}
export interface AlexaMcpToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  uiResource: AlexaMcpUiResourceMeta;
  handler: (args: TInput, context: { sessionId: string; protocolVersion: string }) => Promise<TOutput>;
}
export interface AgentSkillManifest {
  name: string;
  description: string;
  version: string;
  mcpSpecVersion: string;
  triggers: string[];
  tools: string[];
  uiResources: string[];
  rawMarkdown: string;
}
export interface ComplianceCheckItem {
  id: string;
  name: string;
  specSection: string;
  passed: boolean;
  statusCode?: number;
  latencyMs: number;
  details: string;
}
export interface ComplianceAuditReport {
  targetUrl: string;
  timestamp: string;
  protocolVersion: string;
  overallPassed: boolean;
  score: string;
  totalLatencyMs: number;
  checks: ComplianceCheckItem[];
}

type Session = { streamId: string; nextSequence: number; events: { id: string; formatted: string }[]; clients: Set<any> };
const jsonError = (res: any, status: number, message: string): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: status === 403 ? -32000 : -32600, message } }));
};
const originAllowed = (origin: string, patterns: (string | RegExp)[]): boolean => {
  let url: URL;
  try {
    url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) return false;
  } catch { return false; }
  return patterns.some(pattern => {
    if (pattern instanceof RegExp) { pattern.lastIndex = 0; return pattern.test(origin); }
    if (pattern === '*.e2b.app') return url.hostname.endsWith('.e2b.app') && url.hostname !== '.e2b.app';
    if (pattern.includes('://')) return origin === pattern;
    return url.hostname.toLowerCase() === pattern.toLowerCase();
  });
};

/** Mount on /mcp after express.json(). The application remains responsible for JSON-RPC request dispatch. */
export function createStreamableHttp2025Guard(options: StreamableHttp2025Options = {}): {
  middleware: (req: any, res: any, next: () => void) => void;
  createSession: () => string;
  hasSession: (sessionId: string) => boolean;
  terminateSession: (sessionId: string) => boolean;
  recordSseEvent: (sessionId: string, eventName: string, payload: unknown) => { id: string; formatted: string };
  getEventsAfter: (sessionId: string, lastEventId: string) => string[];
} {
  const sessions = new Map<string, Session>();
  const allowed = options.allowedOrigins ?? ['localhost', '127.0.0.1', '*.e2b.app'];
  const supported = options.supportedVersions ?? [MCP_2025_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];
  const createSession = (): string => {
    const id = randomUUID();
    sessions.set(id, { streamId: randomUUID(), nextSequence: 1, events: [], clients: new Set() });
    return id;
  };
  const terminateSession = (id: string): boolean => {
    const session = sessions.get(id);
    if (!session) return false;
    for (const client of session.clients) client.end();
    return sessions.delete(id);
  };
  const recordSseEvent = (id: string, eventName: string, payload: unknown) => {
    const session = sessions.get(id);
    if (!session) throw new Error('Unknown or terminated MCP session');
    if (!/^[^\r\n:]*$/.test(eventName)) throw new Error('Invalid SSE event name');
    const eventId = `${session.streamId}:${session.nextSequence++}`;
    const data = JSON.stringify(payload);
    if (data === undefined) throw new Error('SSE payload must be JSON serializable');
    const formatted = `id: ${eventId}\nevent: ${eventName}\ndata: ${data}\n\n`;
    session.events.push({ id: eventId, formatted });
    // Bound in-memory history; replay is available for the most recent 1000 events.
    if (session.events.length > 1000) session.events.shift();
    for (const client of session.clients) client.write(formatted);
    return { id: eventId, formatted };
  };
  const getEventsAfter = (id: string, lastEventId: string): string[] => {
    const session = sessions.get(id);
    if (!session) return [];
    const index = session.events.findIndex(event => event.id === lastEventId);
    return index < 0 ? [] : session.events.slice(index + 1).map(event => event.formatted);
  };
  const middleware = (req: any, res: any, next: () => void): void => {
    const origin = req.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || !originAllowed(origin, allowed))) {
      jsonError(res, 403, 'Forbidden Origin'); return;
    }
    const method = req.method;
    if (!['POST', 'GET', 'DELETE'].includes(method)) { res.setHeader('Allow', 'POST, GET, DELETE'); jsonError(res, 405, 'Method not allowed'); return; }
    const isInitialize = method === 'POST' && req.body?.method === 'initialize';
    const version = req.headers['mcp-protocol-version'] ?? LEGACY_PROTOCOL_VERSION;
    if (typeof version !== 'string' || !supported.includes(version)) { jsonError(res, 400, 'Unsupported MCP-Protocol-Version'); return; }
    const sessionId = req.headers['mcp-session-id'];
    if (isInitialize) {
      // A session is reserved for the initialize response. Applications should only send a
      // successful InitializeResult with this header; discard the session on error.
      const id = createSession();
      req.mcpSessionId = id;
      req.mcpProtocolVersion = version;
      res.setHeader('MCP-Session-Id', id);
      const originalEnd = res.end;
      res.end = function (chunk: any, ...args: any[]) {
        let successful = res.statusCode < 400;
        if (chunk && typeof chunk === 'string' && !res.headersSent) {
          try { successful = successful && !!JSON.parse(chunk)?.result?.protocolVersion; }
          catch { successful = false; }
        }
        if (!successful) {
          if (!res.headersSent) res.removeHeader('MCP-Session-Id');
          terminateSession(id);
        }
        return originalEnd.call(this, chunk, ...args);
      };
      next(); return;
    }
    if (options.requireSessionId !== false) {
      if (typeof sessionId !== 'string' || !sessionId) { jsonError(res, 400, 'MCP-Session-Id required'); return; }
      if (!sessions.has(sessionId)) { jsonError(res, 404, 'MCP session not found'); return; }
    } else if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessions.has(sessionId))) {
      jsonError(res, 404, 'MCP session not found'); return;
    }
    req.mcpSessionId = sessionId ?? '';
    req.mcpProtocolVersion = version;
    if (method === 'DELETE') {
      if (typeof sessionId !== 'string' || !terminateSession(sessionId)) { jsonError(res, 404, 'MCP session not found'); return; }
      res.statusCode = 204; res.end(); return;
    }
    if (method === 'GET') {
      if (!req.headers.accept?.includes('text/event-stream')) { jsonError(res, 406, 'Accept: text/event-stream required'); return; }
      if (!sessionId || options.enableSseResumption === false) { jsonError(res, 405, 'SSE not available'); return; }
      const session = sessions.get(sessionId)!;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const last = req.headers['last-event-id'];
      if (typeof last === 'string') for (const event of getEventsAfter(sessionId, last)) res.write(event);
      const id = `${session.streamId}:${session.nextSequence++}`;
      const formatted = `id: ${id}\ndata:\n\n`;
      session.events.push({ id, formatted });
      if (session.events.length > 1000) session.events.shift();
      res.write(formatted);
      session.clients.add(res);
      res.once('close', () => session.clients.delete(res));
      return;
    }
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) &&
      req.body.jsonrpc === '2.0' &&
      ((typeof req.body.method === 'string' && req.body.id === undefined) ||
        (req.body.method === undefined && req.body.id !== undefined &&
          (req.body.result !== undefined || req.body.error !== undefined)))) {
      res.statusCode = 202; res.end(); return;
    }
    next();
  };
  return { middleware, createSession, hasSession: id => sessions.has(id), terminateSession, recordSseEvent, getEventsAfter };
}

export function defineAlexaMcpAppTool<TInput = Record<string, unknown>, TOutput = unknown>(
  definition: AlexaMcpToolDefinition<TInput, TOutput>
): AlexaMcpToolDefinition<TInput, TOutput> {
  if (!definition.name?.trim() || !definition.description?.trim() || definition.inputSchema?.type !== 'object' ||
    !definition.inputSchema.properties || typeof definition.inputSchema.properties !== 'object' ||
    !definition.uiResource?.uri?.startsWith('ui://') || definition.uiResource.uri.length <= 5 ||
    !definition.uiResource.title?.trim() || !definition.uiResource.description?.trim() ||
    typeof definition.handler !== 'function') throw new Error('Invalid Alexa MCP App tool definition');
  return definition;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`SKILL.md: ${name} must be a non-empty string`);
  return value;
}
function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim()))
    throw new Error(`SKILL.md: ${name} must be a list of non-empty strings`);
  return value;
}
export function parseAgentSkillMarkdown(markdownContent: string): AgentSkillManifest {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/.exec(markdownContent);
  if (!match) throw new Error('SKILL.md: YAML frontmatter delimited by --- is required');
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error(`SKILL.md: invalid YAML: ${document.errors[0].message}`);
  const data = document.toJS();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('SKILL.md: frontmatter must be a mapping');
  if (!match[2].trim()) throw new Error('SKILL.md: Markdown instructions are required');
  const manifest: AgentSkillManifest = {
    name: stringField(data.name, 'name'), description: stringField(data.description, 'description'),
    version: stringField(data.version, 'version'), mcpSpecVersion: stringField(data.mcpSpecVersion, 'mcpSpecVersion'),
    triggers: stringList(data.triggers, 'triggers'), tools: stringList(data.tools, 'tools'),
    uiResources: stringList(data.uiResources, 'uiResources'), rawMarkdown: markdownContent
  };
  if (manifest.mcpSpecVersion !== MCP_2025_PROTOCOL_VERSION) throw new Error('SKILL.md: unsupported mcpSpecVersion');
  if (manifest.uiResources.some(uri => !uri.startsWith('ui://') || uri.length <= 5)) throw new Error('SKILL.md: invalid ui:// resource');
  return manifest;
}
export function loadAgentSkillManifest(filePath: string): AgentSkillManifest {
  return parseAgentSkillMarkdown(readFileSync(filePath, 'utf8'));
}

/** Probe a live MCP endpoint. Failed network checks are reported, not thrown. */
export async function runMcp2025ComplianceAudit(targetUrl: string): Promise<ComplianceAuditReport> {
  const target = new URL(targetUrl);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Audit target must be an HTTP(S) URL');
  const started = Date.now();
  const checks: ComplianceCheckItem[] = [];
  let sessionId = '';
  const common = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(target, { method, headers: { ...common, ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  async function check(id: string, name: string, specSection: string, fn: () => Promise<{ passed: boolean; statusCode?: number; details: string }>) {
    const begin = performance.now();
    try { checks.push({ id, name, specSection, ...await fn(), latencyMs: Math.round(performance.now() - begin) }); }
    catch (error) { checks.push({ id, name, specSection, passed: false, latencyMs: Math.round(performance.now() - begin), details: error instanceof Error ? error.message : String(error) }); }
  }
  const headers = () => ({ 'MCP-Protocol-Version': MCP_2025_PROTOCOL_VERSION, ...(sessionId ? { 'MCP-Session-Id': sessionId } : {}) });
  await check('origin', 'Origin Security Guard', 'Streamable HTTP / Security Warning', async () => {
    const res = await request('POST', rpc(1, 'ping'), { Origin: 'https://untrusted.invalid' });
    const body = await res.json().catch(() => null);
    return { passed: res.status === 403 && body?.id === null && !!body?.error, statusCode: res.status, details: `Untrusted origin returned ${res.status}` };
  });
  await check('initialize', 'Initialize Handshake & 2025-11-25 Negotiation', 'Lifecycle / Initialization', async () => {
    const res = await request('POST', rpc(2, 'initialize', { protocolVersion: MCP_2025_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'alexa-mcp-2025-kit-auditor', version: '0.1.0' } }));
    sessionId = res.headers.get('mcp-session-id') ?? '';
    const body = await res.json();
    return { passed: res.ok && body?.jsonrpc === '2.0' && body?.id === 2 && body?.result?.protocolVersion === MCP_2025_PROTOCOL_VERSION,
      statusCode: res.status, details: `Negotiated ${body?.result?.protocolVersion ?? 'none'}; session ${sessionId ? 'issued' : 'not issued'}` };
  });
  await check('session', 'MCP-Session-Id Issuance & ASCII Validation', 'Streamable HTTP / Session Management', async () => ({
    passed: /^[\x21-\x7e]+$/.test(sessionId) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId),
    details: sessionId ? 'Session header present; checked visible ASCII and UUID shape' : 'No session header in initialize response'
  }));
  await check('version', 'Invalid MCP-Protocol-Version Rejection', 'Streamable HTTP / Protocol Version Header', async () => {
    const res = await request('POST', rpc(3, 'ping'), { ...headers(), 'MCP-Protocol-Version': 'invalid-version' });
    return { passed: res.status === 400, statusCode: res.status, details: `Invalid version returned ${res.status}` };
  });
  await check('notification', 'Notification 202 Accepted Handling', 'Streamable HTTP / Sending Messages', async () => {
    const res = await request('POST', { jsonrpc: '2.0', method: 'notifications/initialized' }, headers());
    const body = await res.text();
    return { passed: res.status === 202 && body.length === 0, statusCode: res.status, details: `Notification returned ${res.status}; body length ${body.length}` };
  });
  await check('tools-ui', 'tools/list & ui:// MCP App Metadata Verification', 'MCP Apps / Tool UI Resources', async () => {
    const res = await request('POST', rpc(4, 'tools/list', {}), headers());
    const body = await res.json();
    const tools = body?.result?.tools;
    const matches = Array.isArray(tools) ? tools.filter((tool: any) =>
      typeof tool?._meta?.ui?.resourceUri === 'string' && tool._meta.ui.resourceUri.startsWith('ui://')) : [];
    return { passed: res.ok && matches.length > 0, statusCode: res.status, details: `${matches.length} tools with _meta.ui.resourceUri ui:// metadata` };
  });
  await check('sse', 'SSE Stream & Last-Event-ID Resumption Support', 'Streamable HTTP / Resumability and Redelivery', async () => {
    if (!sessionId) return { passed: false, details: 'No session available for SSE' };
    const sseHeaders = { ...headers(), Accept: 'text/event-stream' };
    const first = await request('GET', undefined, sseHeaders);
    if (!first.ok || !first.headers.get('content-type')?.includes('text/event-stream')) {
      await first.body?.cancel(); return { passed: false, statusCode: first.status, details: `GET returned ${first.status} without SSE` };
    }
    const reader = first.body?.getReader();
    const chunk = reader ? await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE priming timed out')), 3000))]) : null;
    const text = chunk?.value ? new TextDecoder().decode(chunk.value) : '';
    const eventId = /^id: ([^\r\n]+)/m.exec(text)?.[1];
    await reader?.cancel();
    if (!eventId) return { passed: false, statusCode: first.status, details: 'SSE opened but no priming event ID was received' };
    const resumed = await request('GET', undefined, { ...sseHeaders, 'Last-Event-ID': eventId });
    const passed = resumed.ok && !!resumed.headers.get('content-type')?.includes('text/event-stream');
    await resumed.body?.cancel();
    return { passed, statusCode: resumed.status, details: passed ? `Reconnected using Last-Event-ID ${eventId}; missed-event redelivery requires an injected event to prove` : `Resume returned ${resumed.status}` };
  });
  await check('delete', 'Session Termination via HTTP DELETE', 'Streamable HTTP / Session Management', async () => {
    if (!sessionId) return { passed: false, details: 'No session available to terminate' };
    const res = await request('DELETE', undefined, headers());
    await res.body?.cancel();
    const after = await request('POST', rpc(5, 'ping'), headers());
    await after.body?.cancel();
    return { passed: res.ok && after.status === 404, statusCode: res.status, details: `DELETE ${res.status}; subsequent request ${after.status}` };
  });
  const passed = checks.filter(item => item.passed).length;
  return { targetUrl, timestamp: new Date().toISOString(), protocolVersion: MCP_2025_PROTOCOL_VERSION,
    overallPassed: passed === checks.length, score: `${passed}/${checks.length} (${Math.round(100 * passed / checks.length)}%)`,
    totalLatencyMs: Date.now() - started, checks };
}
