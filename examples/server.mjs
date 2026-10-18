// Run: npm run build && node examples/server.mjs
import { createServer } from 'node:http';
import { createStreamableHttp2025Guard, defineAlexaMcpAppTool, MCP_2025_PROTOCOL_VERSION } from '../dist/index.js';

const guard = createStreamableHttp2025Guard();
const tool = defineAlexaMcpAppTool({
  name: 'show_status', description: 'Show a status card',
  inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
  uiResource: { uri: 'ui://status/card', title: 'Status card', description: 'Interactive status card', mimeType: 'text/html' },
  handler: async ({ label }) => ({ content: [{ type: 'text', text: `Status: ${label}` }] })
});
const send = (res, id, result) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};
const server = createServer(async (req, res) => {
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  if (req.method === 'POST') {
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000) throw new Error('Body too large');
      }
      req.body = JSON.parse(body);
    } catch { res.writeHead(400).end('Invalid JSON'); return; }
  }
  guard.middleware(req, res, async () => {
    const { id, method, params } = req.body;
    if (method === 'initialize') {
      send(res, id, { protocolVersion: MCP_2025_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'example', version: '0.1.0' } });
    } else if (method === 'tools/list') {
      send(res, id, { tools: [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, _meta: { ui: { resourceUri: tool.uiResource.uri } } }] });
    } else if (method === 'resources/list') {
      send(res, id, { resources: [{ uri: tool.uiResource.uri, name: tool.uiResource.title, description: tool.uiResource.description, mimeType: 'text/html' }] });
    } else if (method === 'resources/read' && params?.uri === tool.uiResource.uri) {
      send(res, id, { contents: [{ uri: tool.uiResource.uri, mimeType: 'text/html', text: '<!doctype html><html><body><h1>Status</h1></body></html>' }] });
    } else if (method === 'tools/call' && params?.name === tool.name) {
      send(res, id, await tool.handler(params.arguments, { sessionId: req.mcpSessionId, protocolVersion: req.mcpProtocolVersion }));
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
    }
  });
});
server.listen(3000, '127.0.0.1', () => console.log('MCP example on http://127.0.0.1:3000/mcp'));
