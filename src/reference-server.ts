import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createStreamableHttp2025Guard, defineAlexaMcpAppTool, MCP_2025_PROTOCOL_VERSION } from './index.js';
import { DEFAULT_ALLOWED_ORIGINS, originAllowed, jsonRpcHttpError } from './http-security.js';

/** Start a disposable MCP reference endpoint; close() releases the listener. */
export async function startReferenceServer(port = 0, host = '127.0.0.1'): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const app = express();
  const guard = createStreamableHttp2025Guard();
  const status = defineAlexaMcpAppTool<{ label: string }, CallToolResult>({
    name: 'show_status', description: 'Render an interactive status card',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
    uiResource: { uri: 'ui://status/card', title: 'Status card', description: 'A compact interactive status view', mimeType: 'text/html', aspectRatio: '4:3' },
    handler: async ({ label }) => ({ content: [{ type: 'text', text: `Status: ${label}` }] })
  });
  const advertisedTool: Tool = {
    name: status.name, description: status.description,
    inputSchema: { ...status.inputSchema, properties: status.inputSchema.properties as Record<string, object> },
    _meta: { ui: { resourceUri: status.uiResource.uri } }
  };
  app.get('/health', (_req, res) => res.json({ status: 'ready', protocolVersion: MCP_2025_PROTOCOL_VERSION, endpoint: '/mcp', tool: status.name, uptimeSeconds: Math.round(process.uptime()) }));
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MCP 2025 Reference Server</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;background:#111827;color:#f9fafb;max-width:720px;margin:10vh auto;padding:2rem}code{color:#34d399}.card{border:1px solid #374151;border-radius:16px;padding:24px;background:#1f2937}dt{color:#9ca3af}dd{margin:0 0 1rem}</style></head><body><div class="card"><h1>Alexa MCP 2025 Kit</h1><p id="health">Checking live server status…</p><dl><dt>Transport</dt><dd><code>POST /mcp · GET /mcp · DELETE /mcp</code></dd><dt>Protocol</dt><dd><code>2025-11-25</code></dd><dt>Example MCP App</dt><dd><code>show_status → ui://status/card</code></dd></dl><p>Run <code>npm run demo-audit</code> for an eight-check self-test.</p></div><script>async function update(){try{const r=await fetch('/health');const h=await r.json();document.querySelector('#health').textContent='● '+h.status+' · uptime '+h.uptimeSeconds+'s'}catch{document.querySelector('#health').textContent='● unavailable'}}update();setInterval(update,10000)</script></body></html>`);
  });
  // Origin must be rejected before parsing: even malformed/oversized JSON from an
  // untrusted site receives the spec-required 403 instead of a parser error.
  app.use('/mcp', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin, DEFAULT_ALLOWED_ORIGINS)) {
      jsonRpcHttpError(res, 403, 'Forbidden Origin'); return;
    }
    next();
  }, express.json({ limit: '1mb' }), guard.middleware);
  app.use('/mcp', (error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!error) { next(); return; }
    jsonRpcHttpError(res, 400, 'Invalid JSON request body');
  });
  app.post('/mcp', async (req, res) => {
    const { id, method, params } = req.body ?? {};
    const send = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
    const error = (code: number, message: string) => res.status(400).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    try {
      if (req.body?.jsonrpc !== '2.0' || (typeof id !== 'string' && typeof id !== 'number') || typeof method !== 'string') {
        error(-32600, 'Invalid JSON-RPC request'); return;
      }
      switch (method) {
        case 'initialize':
          if (params?.protocolVersion !== MCP_2025_PROTOCOL_VERSION) { error(-32602, 'Unsupported initialize protocolVersion'); return; }
          send({ protocolVersion: MCP_2025_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'alexa-mcp-2025-kit-reference', version: '1.0.0' } });
          return;
        case 'ping': send({}); return;
        case 'tools/list': send({ tools: [advertisedTool] }); return;
        case 'tools/call':
          if (params?.name !== status.name || typeof params.arguments?.label !== 'string') { error(-32602, 'Invalid tool arguments'); return; }
          send(await status.handler(params.arguments, { sessionId: req.headers['mcp-session-id'] as string, protocolVersion: req.headers['mcp-protocol-version'] as string ?? MCP_2025_PROTOCOL_VERSION }));
          return;
        case 'resources/list': send({ resources: [{ uri: status.uiResource.uri, name: status.uiResource.title, description: status.uiResource.description, mimeType: 'text/html' }] }); return;
        case 'resources/read':
          if (params?.uri !== status.uiResource.uri) { error(-32602, 'Unknown UI resource'); return; }
          send({ contents: [{ uri: status.uiResource.uri, mimeType: 'text/html', text: '<!doctype html><html><body><main><h1>Status card</h1><p>Ready</p></main></body></html>' }] });
          return;
        default: error(-32601, 'Method not found');
      }
    } catch { error(-32603, 'Internal error'); }
  });
  // The guard handles GET SSE and DELETE. No wildcard route should shadow it.
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/mcp`, server,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    }) };
}
