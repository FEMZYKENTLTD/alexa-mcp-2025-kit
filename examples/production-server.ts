/**
 * Distributed reference: REDIS_URL, JWKS_URL, MCP_ISSUER, MCP_AUDIENCE,
 * MCP_ALLOWED_ORIGINS (comma-separated HTTPS origins) MUST be set.
 * Run: npx tsx examples/production-server.ts
 */
import express from 'express';
import { createClient } from 'redis';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createJwksAuthenticator, createProductionMcpGuard, defineAlexaMcpAppTool,
  MCP_2025_PROTOCOL_VERSION, RedisSessionStore } from '../src/index.js';
import { jsonRpcHttpError, originAllowed } from '../src/http-security.js';

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; see README production deployment`);
  return value;
};
const origins = required('MCP_ALLOWED_ORIGINS').split(',').map(value => value.trim());
if (origins.some(origin => !origin.startsWith('https://'))) throw new Error('Production Origins must use HTTPS');
const redis = createClient({ url: required('REDIS_URL'), RESP: 2 });
redis.on('error', error => console.error('Redis connection error:', error));
await redis.connect();
const store = new RedisSessionStore(redis, { ttlSeconds: 1800 });
await store.connect();
const guard = createProductionMcpGuard({
  store, allowedOrigins: origins, authenticate: createJwksAuthenticator({
    jwksUrl: required('JWKS_URL'), issuer: required('MCP_ISSUER'), audience: required('MCP_AUDIENCE')
  })
});
const tool = defineAlexaMcpAppTool({
  name: 'show_status', description: 'Show a status card',
  inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
  uiResource: { uri: 'ui://status/card', title: 'Status', description: 'Interactive status card', mimeType: 'text/html' },
  handler: async ({ label }: { label: string }) => ({ content: [{ type: 'text', text: `Status: ${label}` }] })
});
const advertised: Tool = {
  name: tool.name, description: tool.description,
  inputSchema: { ...tool.inputSchema, properties: tool.inputSchema.properties as Record<string, object> },
  _meta: { ui: { resourceUri: tool.uiResource.uri } }
};
const app = express();
// Reject untrusted Origins BEFORE parsing malformed/oversized bodies.
app.use('/mcp', (req, res, next) => {
  if (req.headers.origin !== undefined && !originAllowed(req.headers.origin, origins)) {
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
  if (req.body?.jsonrpc !== '2.0' || (typeof id !== 'string' && typeof id !== 'number')) {
    error(-32600, 'Invalid JSON-RPC request'); return;
  }
  if (method === 'initialize') {
    if (params?.protocolVersion !== MCP_2025_PROTOCOL_VERSION) { error(-32602, 'Unsupported protocol version'); return; }
    send({ protocolVersion: MCP_2025_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'production-example', version: '1.0.0' } });
  } else if (method === 'tools/list') send({ tools: [advertised] });
  else if (method === 'tools/call' && params?.name === tool.name && typeof params?.arguments?.label === 'string')
    send(await tool.handler(params.arguments, { sessionId: (req as typeof req & { mcpSessionId: string }).mcpSessionId, protocolVersion: (req as typeof req & { mcpProtocolVersion: string }).mcpProtocolVersion }));
  else if (method === 'resources/list') send({ resources: [{ uri: tool.uiResource.uri, name: tool.uiResource.title, mimeType: 'text/html' }] });
  else if (method === 'resources/read' && params?.uri === tool.uiResource.uri)
    send({ contents: [{ uri: tool.uiResource.uri, mimeType: 'text/html', text: '<!doctype html><html><body><h1>Status</h1></body></html>' }] });
  else error(-32601, 'Method not found');
});
const server = app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0', () => console.log('Protected /mcp listening'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close(() => { void store.close().then(() => redis.quit()).then(() => process.exit(0)); });
});
