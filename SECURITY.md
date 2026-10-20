# Security policy

## Reporting

Please **do not disclose exploitable vulnerabilities in a public issue**. Use the
[GitHub private vulnerability reporting flow](https://github.com/FEMZYKENTLTD/alexa-mcp-2025-kit/security/advisories/new)
if available, or contact the repository maintainer privately through GitHub.
Include affected versions, a minimal reproduction, impact, and suggested fixes.
We will investigate reports and coordinate disclosure before publishing a fix.

## Deployment boundaries

- The default Origin allowlist includes localhost and `*.e2b.app` for development. Set
  `allowedOrigins` explicitly to your application's trusted origins in production.
- Origin checking is **not authentication**. Add appropriate authentication and
  authorization in the application, and terminate TLS at a trusted boundary.
- The in-memory session/event store has no expiry or cross-process coordination; use
  sticky routing and a shared, expiring store for scaled production deployments.
- Run the auditor only against endpoints you control: it issues initialize and DELETE.
- Check 7 probes SSE reconnection, not proof that a third-party endpoint replays
  arbitrary missed events. The integration tests exercise actual redelivery.
