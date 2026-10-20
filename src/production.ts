/** Opt-in distributed transport. The existing synchronous guard remains unchanged. */
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
/** Minimal Redis v5 command surface; compatible with createClient() without generic casts. */
export interface RedisSessionClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  hGetAll(key: string): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  duplicate(): RedisSessionClient;
  isOpen: boolean;
}
import { jsonRpcHttpError, originAllowed } from './http-security.js';
import { LEGACY_PROTOCOL_VERSION, MCP_2025_PROTOCOL_VERSION, type StreamableHttp2025Options } from './index.js';

export interface AuthenticatedMcpIdentity {
  subject: string;
  scopes?: string[];
  clientId?: string;
  expiresAtMs?: number;
}
export interface SessionRecord { subject: string; protocolVersion: string; streamId: string; expiresAtMs?: number }
export interface StoredEvent { id: string; formatted: string }
export type SessionMessage = StoredEvent | { terminated: true };
export interface SharedSessionStore {
  create(subject: string, protocolVersion: string): Promise<string>;
  get(sessionId: string): Promise<SessionRecord | null>;
  terminate(sessionId: string): Promise<boolean>;
  append(sessionId: string, eventName: string, payload: unknown, prime?: boolean): Promise<StoredEvent>;
  eventsAfter(sessionId: string, lastEventId: string): Promise<StoredEvent[]>;
  subscribe(sessionId: string, listener: (message: SessionMessage) => void): Promise<() => Promise<void>>;
}

const createScript = `
local now = redis.call('TIME')
local expires = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) + tonumber(ARGV[4]) * 1000
redis.call('HSET', KEYS[1], 'subject', ARGV[1], 'version', ARGV[2], 'stream', ARGV[3], 'seq', 0, 'expires', expires)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1`;
const terminateScript = `
if redis.call('DEL', KEYS[1]) == 0 then return 0 end
redis.call('DEL', KEYS[2])
redis.call('PUBLISH', ARGV[1], '{"terminated":true}')
return 1`;
const appendScript = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {} end
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
local id = redis.call('HGET', KEYS[1], 'stream') .. ':' .. seq
local frame
if ARGV[3] == '1' then
  frame = 'id: ' .. id .. '\\ndata:\\n\\n'
else
  frame = 'id: ' .. id .. '\\nevent: ' .. ARGV[1] .. '\\ndata: ' .. ARGV[2] .. '\\n\\n'
end
local encoded = cjson.encode({ id = id, formatted = frame })
redis.call('RPUSH', KEYS[2], encoded)
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[4]), -1)
local remaining = redis.call('PTTL', KEYS[1])
if remaining >= 0 then redis.call('PEXPIRE', KEYS[2], math.max(remaining, 1)) end
if ARGV[3] ~= '1' then redis.call('PUBLISH', ARGV[5], encoded) end
return { id, frame }`;

/** Redis keys and Pub/Sub are shared across instances. Pass a connected redis v5 client. */
export class RedisSessionStore implements SharedSessionStore {
  private readonly subscriber: RedisSessionClient;
  private readonly namespace: string;
  private readonly ttlSeconds: number;
  private readonly maxEvents: number;
  constructor(private readonly client: RedisSessionClient, options: { namespace?: string; ttlSeconds?: number; maxEvents?: number } = {}) {
    this.namespace = options.namespace ?? 'alexa-mcp-2025';
    this.ttlSeconds = options.ttlSeconds ?? 1800;
    this.maxEvents = options.maxEvents ?? 1000;
    if (!/^[\w-]+$/.test(this.namespace) || !Number.isInteger(this.ttlSeconds) || this.ttlSeconds < 1 || this.ttlSeconds > 86400 ||
      !Number.isInteger(this.maxEvents) || this.maxEvents < 1 || this.maxEvents > 10000)
      throw new Error('Invalid Redis session namespace, TTL, or history limit');
    this.subscriber = client.duplicate() as RedisSessionClient;
  }
  private keys(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid MCP session ID');
    const base = `${this.namespace}:{${id}}`;
    return { session: `${base}:session`, events: `${base}:events`, channel: `${base}:push` };
  }
  /** Connect the dedicated Pub/Sub connection before accepting GET SSE traffic. */
  async connect(): Promise<void> { await this.subscriber.connect(); }
  /** Closes only the owned subscriber; caller retains responsibility for its Redis client. */
  async close(): Promise<void> { if (this.subscriber.isOpen) await this.subscriber.quit(); }
  async create(subject: string, protocolVersion: string): Promise<string> {
    if (!subject || !protocolVersion) throw new Error('Subject and protocol version are required');
    const id = randomUUID();
    const { session } = this.keys(id);
    await this.client.eval(createScript, { keys: [session], arguments: [subject, protocolVersion, randomUUID(), String(this.ttlSeconds)] });
    return id;
  }
  async get(id: string): Promise<SessionRecord | null> {
    const data = await this.client.hGetAll(this.keys(id).session) as Record<string, string>;
    return data.subject && data.version && data.stream ?
      { subject: data.subject, protocolVersion: data.version, streamId: data.stream, expiresAtMs: Number(data.expires) } : null;
  }
  async terminate(id: string): Promise<boolean> {
    const { session, events, channel } = this.keys(id);
    return (await this.client.eval(terminateScript, { keys: [session, events], arguments: [channel] })) === 1;
  }
  async append(id: string, eventName: string, payload: unknown, prime = false): Promise<StoredEvent> {
    if (!prime && (!eventName || !/^[^\r\n:]+$/.test(eventName))) throw new Error('Invalid SSE event name');
    const data = prime ? '' : JSON.stringify(payload);
    if (data === undefined) throw new Error('SSE payload must be JSON serializable');
    const { session, events, channel } = this.keys(id);
    const result = await this.client.eval(appendScript, { keys: [session, events],
      arguments: [eventName, data, prime ? '1' : '0', String(this.maxEvents), channel] });
    if (!Array.isArray(result) || result.length !== 2) throw new Error('Unknown or expired MCP session');
    return { id: String(result[0]), formatted: String(result[1]) };
  }
  async eventsAfter(id: string, lastEventId: string): Promise<StoredEvent[]> {
    if (!await this.get(id)) return [];
    const entries = (await this.client.lRange(this.keys(id).events, 0, -1) as string[]).map(raw => JSON.parse(raw) as StoredEvent);
    const index = entries.findIndex(event => event.id === lastEventId);
    return index < 0 ? [] : entries.slice(index + 1);
  }
  async subscribe(id: string, listener: (message: SessionMessage) => void): Promise<() => Promise<void>> {
    const { channel } = this.keys(id);
    const callback = (raw: string) => listener(JSON.parse(raw) as SessionMessage);
    await this.subscriber.subscribe(channel, callback);
    return async () => { await this.subscriber.unsubscribe(channel, callback); };
  }
}

export interface JwksAuthOptions { jwksUrl: string; issuer: string; audience: string }
/** Verifies signed OIDC JWTs, issuer, audience, expiry and subject. Never accepts unsigned tokens. */
export function createJwksAuthenticator(options: JwksAuthOptions): (token: string) => Promise<AuthenticatedMcpIdentity | null> {
  const url = new URL(options.jwksUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    throw new Error('JWKS must use HTTPS (or localhost HTTP for tests)');
  if (!options.issuer || !options.audience) throw new Error('OIDC issuer and audience are required');
  const jwks = createRemoteJWKSet(url);
  return async token => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: options.issuer, audience: options.audience,
        algorithms: ['RS256', 'ES256'], requiredClaims: ['exp'] });
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) :
        Array.isArray(payload.scp) && payload.scp.every(value => typeof value === 'string') ? payload.scp as string[] : [];
      const clientId = typeof payload.client_id === 'string' ? payload.client_id :
        typeof payload.azp === 'string' ? payload.azp : undefined;
      // User tokens identify the customer; service tokens have no user sub and
      // must carry a registered OAuth client ID instead. Never invent a subject.
      const subject = payload.sub || (scopes.includes('mcp:service') && clientId ? `service:${clientId}` : undefined);
      return subject ? { subject, clientId, scopes, expiresAtMs: payload.exp! * 1000 } : null;
    } catch { return null; }
  };
}

export interface ProductionMcpOptions extends StreamableHttp2025Options {
  store: SharedSessionStore;
  authenticate: (token: string) => Promise<AuthenticatedMcpIdentity | null>;
  /** Optional Alexa scope policy; enable it on the Alexa-facing production endpoint. */
  scopePolicy?: { service: string; tools: string; resources: string };
  /** Alexa+ currently does not support WWW-Authenticate challenges; set false for add-ons. */
  sendAuthenticateChallenge?: boolean;
}
/** Distributed alternative to createStreamableHttp2025Guard. Requires auth on EVERY method. */
export function createProductionMcpGuard(options: ProductionMcpOptions) {
  if (!options?.store || !options.authenticate) throw new Error('A shared store and authenticator are required');
  if (!options.allowedOrigins?.length) throw new Error('Production guard requires an explicit Origin allowlist');
  if (options.requireSessionId === false) throw new Error('Production guard requires sessions');
  const { store, authenticate } = options;
  const allowed = options.allowedOrigins;
  const supported = options.supportedVersions ?? [MCP_2025_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];
  const middleware = (req: any, res: any, next: () => void): void => {
    void (async () => {
      const origin = req.headers.origin;
      if (origin !== undefined && (typeof origin !== 'string' || !originAllowed(origin, allowed))) {
        jsonRpcHttpError(res, 403, 'Forbidden Origin'); return;
      }
      if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
        res.setHeader('Allow', 'POST, GET, DELETE'); jsonRpcHttpError(res, 405, 'Method not allowed'); return;
      }
      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) {
        if (options.sendAuthenticateChallenge !== false) res.setHeader('WWW-Authenticate', 'Bearer');
        jsonRpcHttpError(res, 401, 'Bearer token required'); return;
      }
      const identity = await authenticate(authorization.slice(7));
      if (!identity?.subject) {
        if (options.sendAuthenticateChallenge !== false) res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
        jsonRpcHttpError(res, 401, 'Invalid bearer token'); return;
      }
      const version = req.headers['mcp-protocol-version'] ?? LEGACY_PROTOCOL_VERSION;
      if (typeof version !== 'string' || !supported.includes(version)) {
        jsonRpcHttpError(res, 400, 'Unsupported MCP-Protocol-Version'); return;
      }
      const method = req.method === 'POST' ? req.body?.method : undefined;
      if (options.scopePolicy && req.method === 'POST') {
        const policy = options.scopePolicy;
        const scopes = identity.scopes ?? [];
        const authorized = method === 'initialize' || method === 'tools/list' || method === 'ping'
          ? [policy.service, policy.tools, policy.resources].some(scope => scopes.includes(scope))
          : method === 'tools/call' ? scopes.includes(policy.tools)
          : method === 'resources/read' ? scopes.includes(policy.resources)
          : method === 'resources/list' ? [policy.service, policy.resources].some(scope => scopes.includes(scope))
          : true; // Unknown methods are handled by application JSON-RPC dispatch.
        if (!authorized) { jsonRpcHttpError(res, 403, 'Insufficient MCP scope'); return; }
      }
      const isInitialize = method === 'initialize';
      if (isInitialize) {
        const id = await store.create(identity.subject, req.body?.params?.protocolVersion ?? version);
        req.mcpSessionId = id;
        req.mcpSubject = identity.subject;
        req.mcpProtocolVersion = req.body?.params?.protocolVersion ?? version;
        res.setHeader('MCP-Session-Id', id);
        const originalEnd = res.end;
        res.end = function (chunk: any, ...args: any[]) {
          let valid = false;
          try {
            const message = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
            valid = res.statusCode >= 200 && res.statusCode < 300 && message?.jsonrpc === '2.0' &&
              message.id === req.body.id && supported.includes(message?.result?.protocolVersion);
          } catch { /* discard failed initialization */ }
          if (!valid) {
            if (!res.headersSent) res.removeHeader('MCP-Session-Id');
            void store.terminate(id).catch(() => {});
          }
          return originalEnd.call(this, chunk, ...args);
        };
        res.once('close', () => { if (!res.writableFinished) void store.terminate(id).catch(() => {}); });
        next(); return;
      }
      const id = req.headers['mcp-session-id'];
      if (typeof id !== 'string' || !id) { jsonRpcHttpError(res, 400, 'MCP-Session-Id required'); return; }
      // Validate before Redis lookup to avoid key injection and distinguish invalid from expired.
      if (!/^[a-f0-9-]{36}$/i.test(id)) { jsonRpcHttpError(res, 404, 'MCP session not found'); return; }
      const session = await store.get(id);
      if (!session) { jsonRpcHttpError(res, 404, 'MCP session not found'); return; }
      if (session.subject !== identity.subject) { jsonRpcHttpError(res, 403, 'Session belongs to another subject'); return; }
      req.mcpSessionId = id;
      req.mcpSubject = identity.subject;
      req.mcpProtocolVersion = version;
      if (req.method === 'DELETE') {
        if (!await store.terminate(id)) { jsonRpcHttpError(res, 404, 'MCP session not found'); return; }
        res.statusCode = 204; res.end(); return;
      }
      if (req.method === 'GET') {
        if (!req.headers.accept?.includes('text/event-stream')) { jsonRpcHttpError(res, 406, 'Accept: text/event-stream required'); return; }
        if (options.enableSseResumption === false) { jsonRpcHttpError(res, 405, 'SSE not available'); return; }
        let pending: SessionMessage[] = [];
        let ready = false;
        const seen = new Set<string>();
        const send = (event: SessionMessage) => {
          if ('terminated' in event) { res.end(); return; }
          if (!seen.has(event.id) && !res.destroyed) { seen.add(event.id); res.write(event.formatted); }
        };
        const unsubscribe = await store.subscribe(id, event => { if (ready) send(event); else pending.push(event); });
        if (res.destroyed) { await unsubscribe(); return; }
        try {
          const last = req.headers['last-event-id'];
          const replay = typeof last === 'string' ? await store.eventsAfter(id, last) : [];
          const prime = await store.append(id, '', null, true);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders?.();
          const ordered = [...replay, ...pending, prime]
            .filter((event): event is StoredEvent => !('terminated' in event))
            .sort((a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]));
          if (pending.some(event => 'terminated' in event)) { res.end(); await unsubscribe(); return; }
          for (const event of ordered) send(event);
          ready = true;
          for (const event of pending) send(event);
          pending = [];
          // Streams must not remain authorized after a JWT or session expires.
          const deadline = Math.min(identity.expiresAtMs ?? Infinity, session.expiresAtMs ?? Infinity);
          const timer = Number.isFinite(deadline) ? setTimeout(() => res.end(), Math.max(0, deadline - Date.now())) : undefined;
          res.once('close', () => { if (timer) clearTimeout(timer); void unsubscribe().catch(() => {}); });
        } catch (error) { await unsubscribe(); throw error; }
        return;
      }
      if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.body.jsonrpc === '2.0' &&
        ((typeof req.body.method === 'string' && req.body.id === undefined) ||
          (req.body.method === undefined && req.body.id !== undefined &&
            (req.body.result !== undefined || req.body.error !== undefined)))) {
        res.statusCode = 202; res.end(); return;
      }
      next();
    })().catch(() => { if (!res.headersSent) jsonRpcHttpError(res, 503, 'MCP authentication or session store unavailable'); else res.end(); });
  };
  return { middleware, createSession: (subject: string, version = MCP_2025_PROTOCOL_VERSION) => store.create(subject, version),
    hasSession: async (id: string) => !!await store.get(id), terminateSession: (id: string) => store.terminate(id),
    recordSseEvent: (id: string, eventName: string, payload: unknown) => store.append(id, eventName, payload),
    getEventsAfter: async (id: string, lastEventId: string) => (await store.eventsAfter(id, lastEventId)).map(event => event.formatted) };
}
