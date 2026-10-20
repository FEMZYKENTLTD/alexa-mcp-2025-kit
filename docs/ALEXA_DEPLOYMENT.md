# Deploying an Alexa+ MCP add-on with this kit

**GitHub is source control and CI/container distribution, not the running MCP server.**
GitHub Actions can build and push the production image to GHCR when this branch is
merged into `main`. GitHub Pages cannot run Node, Redis, OAuth, or Streamable HTTP.
Run the GHCR image on a container host (for example, AWS App Runner, Fly.io, or
Render) with an HTTPS domain. Provision Redis and an OAuth authorization server
separately. No deployment account, domain, OAuth application, or live credentials
are included or created by this repository.

This repository is the reusable **kit**. Create and configure your Alexa add-on
manifest in the [primary Alexa+ application repository](https://github.com/FEMZYKENTLTD/echocare-kinship-alexa-mcp)
or an Alexa AI CLI project, pointing its MCP endpoint to the deployed server.

## 1. Provision external services (human account owner required)

| Requirement | Where it comes from | Server setting |
| --- | --- | --- |
| Public HTTPS hostname and an always-on container host | Your hosting provider and DNS registrar | `MCP_PUBLIC_URL=https://host.example/mcp`; `PORT` if assigned by host |
| Private TLS-enabled Redis, ACL username/password | Your managed Redis provider | `REDIS_URL=rediss://user:password@private-host:6379` (secret) |
| OAuth 2.1 authorization server (PKCE S256, refresh tokens, client credentials) | Configure a managed provider such as Cognito/Auth0/Okta or an existing compliant OAuth server | `MCP_ISSUER`, `JWKS_URL` |
| OAuth resource/API audience for the exact MCP URL | Configure in your auth provider | `MCP_AUDIENCE` = `MCP_PUBLIC_URL` |
| Trusted browser origins | Your HTTPS web application's origins | `MCP_ALLOWED_ORIGINS`, comma separated |
| Alexa client ID and optional client secret | Register Alexa as a **static OAuth client** at your auth provider | Enter into `alexa-ai configure-account-linking` via masked prompt; **not** a server environment variable |

Use your provider's `/.well-known/oauth-authorization-server` metadata (RFC 8414),
not only OIDC discovery. It must advertise authorization and token endpoints,
`client_credentials`, `authorization_code`, `refresh_token`, and `S256` in
`code_challenge_methods_supported`. The token endpoint must accept a `resource`
parameter matching the canonical MCP URL for both authorization-code and
client-credentials requests. It must issue short-lived **JWT access tokens**
signed with RS256 or ES256 containing `iss`, `aud`, `exp`, and a user `sub` for
linked accounts (or `client_id`/`azp` for service tokens). Include `scope` (space
separated) or `scp` (string array) with `mcp:service` for service discovery,
`mcp:tools` for user tool calls, and `mcp:resources` for user resource access.
Access and refresh tokens must have the provider's rotation/revocation policy.
**Not every hosted auth provider configuration meets these requirements**:
verify token claims and grant support before configuring Alexa. Do not put a
signing private key in this repository or MCP container.

## 2. Build and deploy from GitHub

Merge the PR, then inspect Actions → **Build, audit and test** and **Publish
production container**. If Actions/package publishing is disabled for the
repository or organization, enable it in GitHub settings. On success, the
container image is `ghcr.io/femzykentltd/alexa-mcp-2025-kit:latest` (also SHA
tagged). Allow your host access to the GHCR image if it is private. Configure
the environment variables using the **host's secret manager**, and run the
image with port `3001` (or the host-provided `PORT`) behind HTTPS. The server
exposes an unauthenticated `/healthz` for container health checks; `/mcp` remains
protected. Ensure Redis is reachable privately with TLS and proper ACLs.

For local *development* only, copy `.env.example` to `.env` (ignored by Git).
Replace placeholders with your own values; never commit the populated file.

```sh
npm ci
npm run build:production
# Start with your environment populated; do not post values in chat.
npm run production-server
# Probe public metadata once deployed:
curl -i https://host.example/.well-known/oauth-protected-resource
```

The public protected-resource metadata is generated from `MCP_PUBLIC_URL` and
`MCP_ISSUER` and serves `mcp:tools`/`mcp:resources`. It must be reachable
without a Bearer token, and `resource` must exactly match your add-on endpoint,
including trailing slashes. Unauthenticated `/mcp` returns 401 **without** a
`WWW-Authenticate` header for the Alexa+ MCP toolkit. OAuth metadata is served
by the **authorization server**, not by this MCP server.

## 3. Connect Alexa+ account linking

Use the Alexa AI CLI in your Alexa add-on project (not GitHub Actions):

```sh
alexa-ai configure-account-linking --addon-id YOUR_ADDON_ID \
  --stage development --client-id YOUR_REGISTERED_CLIENT_ID
# Enter the client secret when prompted; never pass it on a plaintext CLI flag.
```

Register **all** Alexa redirect URIs shown by the CLI/developer hub with your
OAuth provider. Enable account linking in the add-on manifest, provide a public
privacy policy, and run `alexa-ai deploy`. Alexa reads protected-resource
metadata, discovers the authorization server, verifies PKCE S256 support, and
performs the customer-facing linking flow. Alexa obtains tokens and sends
`Authorization: Bearer <access-token>` after linking. For private MCP servers,
Alexa can use client credentials for service discovery before user linking;
service tokens can initialize/list tools but cannot call user tools. User and
service sessions are **separate**: after linking, start a new user session rather
than reusing a service session. If an Alexa client does not reinitialize on
token transition, test this during add-on integration; do not weaken the
session ownership check to make it pass.

## 4. Test and limitations

Run `npm run demo-audit` for the local reference endpoint. For a protected
production endpoint, obtain a short-lived user access token from your IdP:

```sh
# Set MCP_AUDIT_BEARER_TOKEN using your secret manager (not a CLI flag).
node dist/cli.js audit https://host.example/mcp
```

The auditor does not print the token and does not follow redirects. Its 8/8
score verifies protocol checks, **not** OAuth client registration, customer
linking, scopes beyond the tested methods, privacy policy, or end-to-end Alexa
certification. Exercise service and user tokens, expirations, and account
linking in the Alexa simulator before submission.

Official references:
- [Alexa+ account linking](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking)
- [Alexa+ two-tier MCP authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication)
- [Alexa+ MCP toolkit quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart)
