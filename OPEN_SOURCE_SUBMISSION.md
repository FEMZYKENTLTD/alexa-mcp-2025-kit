# Open Source Mini-Challenge submission

[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Protocol](https://img.shields.io/badge/MCP-2025--11--25-purple)](README.md)

## Copy-paste Devpost fields

**Contribution URL:** https://github.com/FEMZYKENTLTD/alexa-mcp-2025-kit

**Primary Project Repository URL:** https://github.com/FEMZYKENTLTD/echocare-kinship-alexa-mcp

**GitHub Username:** FEMZYKENTLTD

### What we did, how it works, and why it matters

**What we did:** We built `alexa-mcp-2025-kit`, a standalone MIT-licensed TypeScript developer toolkit that implements the reusable transport and validation building blocks for MCP `2025-11-25` Streamable HTTP. It provides an Express/Node Origin and protocol-version guard, cryptographically generated session IDs, notification handling, SSE event recording/replay, a type-safe helper for `ui://` MCP App tools, a YAML-frontmatter `SKILL.md` parser, an eight-check live compliance auditor, and a runnable reference server with a web status dashboard. It is separate from, but designed to interoperate with, our [EchoCare Kinship Alexa+ primary-track project](https://github.com/FEMZYKENTLTD/echocare-kinship-alexa-mcp). The root [LICENSE](LICENSE) contains the standard MIT license so GitHub can recognize it.

**How it works:** Mount `createStreamableHttp2025Guard()` after a JSON body parser at one `/mcp` endpoint, then attach an application's JSON-RPC dispatcher. The guard rejects untrusted Origins with a 403 JSON-RPC error; validates `MCP-Protocol-Version`; issues a UUID `MCP-Session-Id` on initialization; requires active sessions; acknowledges notifications and client responses with empty 202 replies; supports GET Server-Sent Events with event IDs, buffering, and `Last-Event-ID` replay; and terminates sessions by DELETE. `defineAlexaMcpAppTool()` validates a typed tool paired to a `ui://` resource, while `parseAgentSkillMarkdown()` and `loadAgentSkillManifest()` validate reusable agent instructions. Run `npx alexa-mcp-2025-kit selftest` to start an ephemeral reference endpoint, exercise eight protocol checks, print a readable scorecard and JSON report, then stop the server. The runnable `examples/reference-server.ts` also serves an HTTP status dashboard on port 3001.

**Why it matters:** Voice and agent integrations need more than working tool calls: they need secure Origin handling to prevent DNS rebinding, consistent protocol negotiation, explicit session lifecycle, recoverable SSE connections, discoverable MCP App UI metadata, and skills that can be validated independently. A small open-source kit gives other hackathon builders a reproducible reference and a compliance smoke test before connecting a real Alexa+ application. The TypeScript declarations give application authors the exact same interface across the standalone package and the primary-track repository, while the automated tests make important behaviors regression-testable. Production operators can customize Origin policy, add authentication, and replace in-memory session storage as required; the README explicitly documents these boundaries rather than suggesting an auditor score is a security certification.

## Verification for reviewers

```bash
npm install
npm run build
npm test
npm run demo-audit
npm run reference-server   # open http://localhost:3001/
```

The eight checks and additional security, parser/UI/session, and real HTTP SSE replay tests are in [`tests/compliance.test.ts`](tests/compliance.test.ts). [`README.md`](README.md) includes an architecture diagram, API reference, usage examples, limits, and sample CLI output. The reference server's MCP tool metadata points to a real `ui://status/card` resource served by `resources/read`. The auditor's SSE check confirms priming and reconnection; replay is additionally tested in the event-manager tests.
