/** Public RFC 9728 metadata required for Alexa+ MCP account-linking discovery. */
export interface AlexaProtectedResourceOptions {
  resourceUrl: string;
  authorizationServer: string;
  scopes?: string[];
}

export function createAlexaProtectedResourceMetadata(options: AlexaProtectedResourceOptions): {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
} {
  const resource = new URL(options.resourceUrl);
  const issuer = new URL(options.authorizationServer);
  if (resource.protocol !== 'https:' || issuer.protocol !== 'https:' ||
      resource.search || resource.hash || resource.username || resource.password ||
      issuer.search || issuer.hash || issuer.username || issuer.password ||
      !resource.pathname.endsWith('/mcp') || resource.href !== options.resourceUrl ||
      issuer.href !== options.authorizationServer) {
    throw new Error('Alexa MCP resource and authorization server must be canonical HTTPS URLs');
  }
  const scopes = options.scopes ?? ['mcp:tools', 'mcp:resources'];
  if (!scopes.length || scopes.some(scope => !scope || /\s/.test(scope))) {
    throw new Error('Alexa MCP scopes must be non-empty and must not contain whitespace');
  }
  return { resource: resource.href, authorization_servers: [issuer.href], scopes_supported: scopes };
}
