# alexa-mcp-2025-kit

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A standalone TypeScript/Node toolkit for the **Build, Ship, Shape: Amazon Developer Hackathon** open-source mini-challenge. It pairs with the [EchoCare Kinship Alexa+ application](https://github.com/FEMZYKENTLTD/echocare-kinship-alexa-mcp), but has no dependency on that repository.

**What:** an MCP `2025-11-25` Streamable HTTP guard and session/event manager, a typed Alexa MCP App tool definition, an Agent Skill `SKILL.md` parser, and an eight-check live endpoint auditor. **Why:** make transport security and interoperable `ui://`/skill integration testable independently of any one Alexa+ app. **How:** mount the guard on a single `/mcp` endpoint, implement JSON-RPC dispatch in your server, and run the auditor against the running endpoint.

> This is a transport *guard*, not a complete MCP SDK or authentication solution. The application must implement `initialize`, tools, resources, JSON-RPC error handling, and production authentication. SSE history is in-memory (last 1,000 events per session); multi-instance deployments need shared state. `*.e2b.app` is allowed by default for development previews; **supply an explicit `allowedOrigins` list in production**.

## Install and test

```sh
npm install
npm test
npm run build
node examples/server.mjs
```

Node.js 20+ is required. Published-package consumers can import from `alexa-mcp-2025-kit`; this repository's local example imports `../dist/index.js` after building. Type declarations are emitted to `dist/index.d.ts`.

## Streamable HTTP usage

```ts
import { createStreamableHttp2025Guard, MCP_2025_PROTOCOL_VERSION } from 'alexa-mcp-2025-kit';

const guard = createStreamableHttp2025Guard({
  allowedOrigins: ['https://your-app.example', 'http://localhost:3000'],
  requireSessionId: true,
  enableSseResumption: true
});
// Express: app.use('/mcp', express.json(), guard.middleware);
// Then app.post('/mcp', yourJsonRpcHandler). For initialize, return an
// InitializeResult with protocolVersion: MCP_2025_PROTOCOL_VERSION.
// The guard provides req.mcpSessionId and req.mcpProtocolVersion to the handler.
```

See [`examples/server.mjs`](examples/server.mjs) for a runnable Node HTTP server with `initialize`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`. The guard checks `Origin` before any other MCP logic, rejects unsupported `MCP-Protocol-Version` (omitted means `2025-03-26`), creates UUID sessions on initialization, rejects missing/terminated sessions, accepts notifications and responses with `202`/no body, serves GET SSE, and terminates sessions on DELETE. It does **not** change your POST request handler's JSON response into SSE automatically. Send `Content-Type: application/json` or implement a POST SSE response yourself; use `recordSseEvent()` to assign sequential `<streamId>:<sequence>` IDs, obtain formatted frames and publish them to active GET listeners. `getEventsAfter(sessionId, lastEventId)` returns buffered frames following a known ID (unknown/evicted IDs return `[]`). GET sends a priming event with an ID and empty data and replays buffered events when given `Last-Event-ID`.

Mount body parsing **before** the middleware: it needs `req.body` to distinguish initialize/notifications from ordinary requests. Mount only on `/mcp`. Sessions and replay data live in this guard instance; if your load balancer routes requests to another instance, use sticky sessions or replace the in-memory storage with shared persistence. Validate authorizations separately from Origin checks. `supportedVersions` defaults to `['2025-11-25', '2025-03-26']`; a custom list controls accepted headers. The application's initialize handler must negotiate the version in its InitializeResult.

## Typed MCP Apps and Agent Skills

```ts
import { defineAlexaMcpAppTool, loadAgentSkillManifest } from 'alexa-mcp-2025-kit';

const tool = defineAlexaMcpAppTool<{ label: string }, { message: string }>({
  name: 'show_status', description: 'Show status',
  inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
  uiResource: { uri: 'ui://status/card', title: 'Status', description: 'Status UI' },
  handler: async ({ label }, { sessionId }) => ({ message: `${label} (${sessionId})` })
});
// Advertise { _meta: { ui: { resourceUri: tool.uiResource.uri } } }
// in tools/list and serve its HTML through resources/read.
const skill = loadAgentSkillManifest('examples/SKILL.md');
```

The helper validates the definition and preserves its original generic types and handler; it does not register the tool on a server. The parser expects `name`, `description`, `version`, `mcpSpecVersion`, `triggers`, `tools`, `uiResources` in YAML frontmatter and non-empty Markdown instructions. See [`examples/SKILL.md`](examples/SKILL.md). The `ui://` metadata key for MCP Apps is `_meta.ui.resourceUri`.

## Live compliance audit

```js
import { runMcp2025ComplianceAudit } from 'alexa-mcp-2025-kit';
console.log(JSON.stringify(await runMcp2025ComplianceAudit('http://127.0.0.1:3000/mcp'), null, 2));
```

The report provides `overallPassed`, `score`, timings and eight detailed checks: untrusted Origin 403; initialize/version; session UUID/ASCII; invalid version 400; notification 202; `tools/list` UI metadata; GET SSE priming and reconnection with `Last-Event-ID`; DELETE and subsequent 404. Network failures become failed checks rather than crashing the report. The auditor **does not prove missed-event redelivery** without an independently injected event; use `recordSseEvent` plus `getEventsAfter` or an integration test to verify actual replay (the test suite does this). Only audit endpoints you own or have permission to probe; it sends state-changing initialize/DELETE requests.

## License

[MIT](LICENSE). Copyright (c) 2026 OLUFEMI BENUA KERIPE.
