# alexa-mcp-2025-kit

[![CI](https://github.com/FEMZYKENTLTD/alexa-mcp-2025-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/FEMZYKENTLTD/alexa-mcp-2025-kit/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![MCP](https://img.shields.io/badge/MCP-2025--11--25-8b5cf6)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.json) [![Tests](https://img.shields.io/badge/compliance-8%2F8-brightgreen)](tests/compliance.test.ts)

**A standalone, open-source TypeScript toolkit for MCP 2025-11-25 Streamable HTTP, Alexa+ MCP Apps, Agent Skills, and live compliance testing.** Built for the **Build, Ship, Shape: Amazon Developer Hackathon** open-source mini-challenge, alongside the [EchoCare Kinship Alexa+ primary project](https://github.com/FEMZYKENTLTD/echocare-kinship-alexa-mcp). [Submission notes for judges](OPEN_SOURCE_SUBMISSION.md).

The toolkit supplies a session-aware Express/Node guard, `ui://` tool definitions, a `SKILL.md` YAML/Markdown parser, a reference server with status dashboard, and an eight-check compliance auditor. Separating these primitives from a single application makes transport regressions, DNS-rebinding protections, and UI metadata independently reproducible.

## Architecture

```text
┌─────────────────────────────── client / Alexa+ host ───────────────────────────────┐
│ POST initialize · JSON-RPC requests/notifications · GET SSE · DELETE session       │
└─────────────────────────────────┬───────────────────────────────────────────────────┘
                                  ▼
                        single /mcp endpoint
                  ┌──────────────────────────────┐
                  │ origin + protocol guard      │
                  │ UUID sessions + event replay │◀── Last-Event-ID
                  └──────────────┬───────────────┘
                                 ▼
       ┌─────────────────────────┴──────────────────────────┐
       │ application JSON-RPC dispatcher / reference server │
       └───────────┬───────────────────────────┬────────────┘
                   ▼                           ▼
         typed MCP tool + ui://           SKILL.md manifest
         resources/read + tools/list      YAML + instructions
                   └───────────┬───────────────┘
                               ▼
                   CLI / live 8-check auditor
```

## Install, run, verify

Requires Node.js **20+**.

```bash
npm install
npm run build
npm test                         # 17 Vitest tests, including all eight protocol checks
npm run demo-audit               # ephemeral self-test; prints table + JSON, exits 0 on 8/8
npm run reference-server         # dashboard: http://localhost:3001/; MCP: /mcp
```

After publishing, use `npx alexa-mcp-2025-kit selftest` or `npx alexa-mcp-2025-kit audit https://your-host.example/mcp`. To exercise this checkout without publishing, run `node dist/cli.js selftest` after building. `audit` without a URL also starts an ephemeral local reference server. The reference server example binds `0.0.0.0:3001` for dashboards; the CLI's temporary self-test server binds `127.0.0.1` on an OS-assigned port and shuts down automatically.

**Typical CLI output** (URL and timings vary):

```text
Started ephemeral reference server at http://127.0.0.1:PORT/mcp
MCP 2025-11-25 compliance audit: http://127.0.0.1:PORT/mcp
Score: 8/8 (100%) | Total latency: 71 ms
Result    Check                                               HTTP   Latency
PASS      Origin Security Guard                               403    38 ms
PASS      Initialize Handshake & 2025-11-25 Negotiation       200     6 ms
PASS      MCP-Session-Id Issuance & ASCII Validation          —       0 ms
PASS      Invalid MCP-Protocol-Version Rejection              400     3 ms
PASS      Notification 202 Accepted Handling                  202     2 ms
PASS      tools/list & ui:// MCP App Metadata Verification    200     3 ms
PASS      SSE Stream & Last-Event-ID Resumption Support       200    14 ms
PASS      Session Termination via HTTP DELETE                 204     5 ms

JSON report:
{ "targetUrl": "http://127.0.0.1:PORT/mcp", "protocolVersion": "2025-11-25",
  "overallPassed": true, "score": "8/8 (100%)", "checks": [ ... ] }
```

A failed check exits 1; invalid CLI syntax exits 2. The full JSON report includes ISO timestamp, latency, status codes, per-check spec sections, and diagnostic details. Auditing sends initialize/DELETE requests: **only probe endpoints you own or have permission to test**.

## Public API reference (`src/index.ts`)

| Export | Role |
| --- | --- |
| `MCP_2025_PROTOCOL_VERSION`, `LEGACY_PROTOCOL_VERSION` | `2025-11-25`, `2025-03-26` |
| `createStreamableHttp2025Guard(options?)` | `{ middleware, createSession, hasSession, terminateSession, recordSseEvent, getEventsAfter }` |
| `defineAlexaMcpAppTool<TInput,TOutput>(definition)` | Validate and retain typed `ui://` tool definition and async handler |
| `parseAgentSkillMarkdown(markdownContent)` | Validate YAML frontmatter and instructions; return `AgentSkillManifest` |
| `loadAgentSkillManifest(filePath)` | Read and parse a `SKILL.md` file |
| `runMcp2025ComplianceAudit(targetUrl)` | Return `Promise<ComplianceAuditReport>` with eight checks |

Types exported: `StreamableHttp2025Options`, `AlexaMcpUiResourceMeta`, `AlexaMcpToolDefinition`, `AgentSkillManifest`, `ComplianceCheckItem`, `ComplianceAuditReport`. ESM import and `.d.ts` declarations are provided by `dist/` after build; `prepack` also builds them automatically for `npm pack`/publish. Package dependencies include the official `@modelcontextprotocol/sdk` (used to type the reference server's `Tool` and `CallToolResult`), Express, and YAML; development tooling includes tsx, Vitest, and TypeScript.

### Guard and sessions

```ts
import express from 'express';
import { createStreamableHttp2025Guard, MCP_2025_PROTOCOL_VERSION } from 'alexa-mcp-2025-kit';
const app = express();
const guard = createStreamableHttp2025Guard({
  allowedOrigins: ['https://your-app.example', 'http://localhost:3001'],
  requireSessionId: true, supportedVersions: [MCP_2025_PROTOCOL_VERSION, '2025-03-26'],
  enableSseResumption: true
});
app.use('/mcp', express.json(), guard.middleware);
app.post('/mcp', (req, res) => {
  // Implement JSON-RPC dispatch; send InitializeResult for initialize.
  // req.mcpSessionId and req.mcpProtocolVersion are available here.
});
```

The guard checks incoming Origin (`403` JSON-RPC error with `id: null` for untrusted origins), supports POST/GET/DELETE, validates version (`400` for unsupported; omitted means legacy), issues a visible-ASCII UUID on initialize, enforces sessions (`400` missing / `404` terminated), and answers notifications/responses `202` without a body. GET opens an SSE stream with a priming event ID; `recordSseEvent(sessionId, eventName, payload)` publishes events with `<streamId>:<sequence>` IDs, and `getEventsAfter(sessionId, lastEventId)` returns buffered frames. DELETE returns `204` and terminates the session. The application dispatches JSON-RPC requests and can reply to POST with JSON **or** implement POST SSE (using the event helper); the guard does not convert JSON handlers into POST SSE automatically. See [`src/reference-server.ts`](src/reference-server.ts) for full JSON-RPC dispatch and [`examples/reference-server.ts`](examples/reference-server.ts) for its runnable launcher.

**Deployment limits:** the default Origin allowlist includes `localhost`, `127.0.0.1`, and `*.e2b.app` for local development; explicitly set your own allowlist in production. Origin validation is not user authentication. Mount JSON body parsing before the guard; the parser must classify initialize and notifications. Because a body parser may reject malformed JSON before calling the guard, put a matching **Origin preflight gate before parsing** (as in `src/reference-server.ts`) to guarantee 403 for untrusted Origins even on malformed requests. The reference server returns JSON-RPC errors for trusted malformed requests. Keep requests for a session on one instance, or implement shared storage: this guard stores active sessions and the most recent 1,000 SSE frames **in memory**. Unknown or evicted Last-Event-ID values do not replay old frames. The application's initialize handler is responsible for negotiating its `InitializeResult` and for authorization, JSON-RPC errors, and resource rendering.

### MCP App tools and Agent Skills

```ts
import { defineAlexaMcpAppTool, loadAgentSkillManifest } from 'alexa-mcp-2025-kit';
const tool = defineAlexaMcpAppTool<{ label: string }, { message: string }>({
  name: 'show_status', description: 'Show status',
  inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
  uiResource: { uri: 'ui://status/card', title: 'Status', description: 'Status UI', aspectRatio: '4:3' },
  handler: async ({ label }, { sessionId }) => ({ message: `${label} (${sessionId})` })
});
// Expose { _meta: { ui: { resourceUri: tool.uiResource.uri } } } in tools/list.
// Serve matching HTML with resources/list and resources/read.
const skill = loadAgentSkillManifest('examples/SKILL.md');
```

The helper validates the definition but **does not automatically register it** on a server. The parser requires `name`, `description`, `version`, `mcpSpecVersion`, `triggers`, `tools`, and `uiResources` frontmatter and nonempty Markdown instructions. See [`examples/SKILL.md`](examples/SKILL.md).

### Audit scope

The auditor checks: (1) Origin 403, (2) initialize/version negotiation, (3) session ASCII/UUID, (4) invalid version 400, (5) notification 202, (6) UI metadata in `tools/list`, (7) GET SSE priming plus reconnection with Last-Event-ID, and (8) DELETE then 404. **Check 7 tests reconnection, not proof of missed-event redelivery** on an arbitrary remote server: it cannot manufacture server-push messages there. The unit test additionally verifies actual buffered event replay using `recordSseEvent`/`getEventsAfter`. Network errors become failed checks, not an aborted audit.

## Continuous verification and security

CI runs `npm ci`, build, all tests, the 8/8 demo, npm audit, and a package dry-run on Node 20 and 22. Development dependencies were updated to Vitest 4 to resolve critical and moderate npm audit findings while retaining Node 20 support. See [SECURITY.md](SECURITY.md) for responsible disclosure and production boundaries.

## License

[MIT](LICENSE) © 2026 OLUFEMI BENUA KERIPE. The root LICENSE is the standard MIT text for GitHub detection.
