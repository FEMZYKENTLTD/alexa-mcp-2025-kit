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
- The basic in-memory guard has no expiry or cross-process coordination. For production, use
  `createProductionMcpGuard` with `RedisSessionStore` and `createJwksAuthenticator`: it verifies JWT
  issuer/audience/signature/expiry and binds expiring sessions to token subjects. Deploy Redis
  with TLS, ACLs, private networking, persistence/HA, and monitoring; protect the app with HTTPS
  and rate limiting. The caller supplies identity provider keys/configuration and secrets.
- Run the auditor only against endpoints you control: it issues initialize and DELETE.
- Check 7 probes SSE reconnection, not proof that a third-party endpoint replays
  arbitrary missed events. The integration tests exercise actual redelivery.
