import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createClient } from 'redis';
import { createJwksAuthenticator, createProductionMcpGuard, RedisSessionStore,
  runMcp2025ComplianceAudit, type SharedSessionStore, type SessionRecord,
  type StoredEvent, type SessionMessage, MCP_2025_PROTOCOL_VERSION } from '../src/index.js';

class SharedTestStore implements SharedSessionStore {
  sessions = new Map<string, SessionRecord>();
  history = new Map<string, StoredEvent[]>();
  listeners = new Map<string, Set<(message: SessionMessage) => void>>();
  async create(subject: string, protocolVersion: string) {
    const id = randomUUID();
    this.sessions.set(id, { subject, protocolVersion, streamId: randomUUID(), expiresAtMs: Date.now() + 60_000 });
    this.history.set(id, []);
    return id;
  }
  async get(id: string) { return this.sessions.get(id) ?? null; }
  async terminate(id: string) {
    if (!this.sessions.delete(id)) return false;
    for (const listener of this.listeners.get(id) ?? []) listener({ terminated: true });
    this.history.delete(id);
    return true;
  }
  async append(id: string, name: string, payload: unknown, prime = false) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Expired session');
    const sequence = (this.history.get(id)?.length ?? 0) + 1;
    const event = { id: `${session.streamId}:${sequence}`,
      formatted: prime ? `id: ${session.streamId}:${sequence}\ndata:\n\n` :
        `id: ${session.streamId}:${sequence}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n` };
    this.history.get(id)!.push(event);
    if (!prime) for (const listener of this.listeners.get(id) ?? []) listener(event);
    return event;
  }
  async eventsAfter(id: string, last: string) {
    const events = this.history.get(id) ?? [];
    return events.slice(events.findIndex(event => event.id === last) + 1);
  }
  async subscribe(id: string, listener: (message: SessionMessage) => void) {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return async () => { listeners.delete(listener); };
  }
}

function serve(store: SharedSessionStore) {
  const app = express();
  app.use('/mcp', express.json(), createProductionMcpGuard({
    store, allowedOrigins: ['http://127.0.0.1'], authenticate: async token => ['alice', 'bob'].includes(token) ? { subject: token } : null
  }).middleware);
  app.post('/mcp', (req, res) => {
    const { id, method } = req.body;
    const result = method === 'initialize' ? {
      protocolVersion: MCP_2025_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'protected', version: '1' }
    } : method === 'tools/list' ? { tools: [{ name: 'demo', inputSchema: { type: 'object', properties: {} },
      _meta: { ui: { resourceUri: 'ui://demo/card' } } }] } : {};
    res.json({ jsonrpc: '2.0', id, result });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
      close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })
    }));
    server.on('error', reject);
  });
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_2025_PROTOCOL_VERSION } };
const post = (url: string, body: object, token?: string, id?: string) => fetch(url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(id ? { 'MCP-Session-Id': id } : {}) }, body: JSON.stringify(body) });

describe('protected shared-session middleware', () => {
  it('fails closed without auth, binds sessions to subjects across instances and audits with a bearer token', async () => {
    const store = new SharedTestStore();
    const a = await serve(store);
    const b = await serve(store);
    try {
      expect((await post(a.url, init)).status).toBe(401);
      expect((await post(a.url, init, 'invalid')).status).toBe(401);
      const response = await post(a.url, init, 'alice');
      const id = response.headers.get('mcp-session-id')!;
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      expect((await post(b.url, { jsonrpc: '2.0', id: 2, method: 'ping' }, 'bob', id)).status).toBe(403);
      expect((await post(b.url, { jsonrpc: '2.0', id: 2, method: 'ping' }, 'alice', id)).status).toBe(200);
      const audit = await runMcp2025ComplianceAudit(a.url, { bearerToken: 'alice' });
      expect(audit.score).toBe('8/8 (100%)');
      const deleted = await fetch(b.url, { method: 'DELETE', headers: { Authorization: 'Bearer alice', 'MCP-Session-Id': id } });
      expect(deleted.status).toBe(204);
      expect((await post(a.url, { jsonrpc: '2.0', id: 3, method: 'ping' }, 'alice', id)).status).toBe(404);
    } finally { await a.close(); await b.close(); }
  });
  it('closes a live SSE stream when its session expires', async () => {
    const store = new SharedTestStore();
    const app = await serve(store);
    try {
      const initResponse = await post(app.url, init, 'alice');
      const id = initResponse.headers.get('mcp-session-id')!;
      store.sessions.get(id)!.expiresAtMs = Date.now() + 120;
      const stream = await fetch(app.url, { headers: {
        Authorization: 'Bearer alice', Accept: 'text/event-stream', 'MCP-Session-Id': id
      } });
      const reader = stream.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('id:');
      expect((await reader.read()).done).toBe(true);
    } finally { await app.close(); }
  });
  it('rejects missing required security configuration', () => {
    expect(() => createProductionMcpGuard({ store: new SharedTestStore(), allowedOrigins: ['http://127.0.0.1'], authenticate: null! })).toThrow();
    expect(() => createProductionMcpGuard({ store: new SharedTestStore(), authenticate: async () => ({ subject: 'alice' }) })).toThrow(/Origin/);
    expect(() => createJwksAuthenticator({ jwksUrl: 'http://public.example/jwks', issuer: 'issuer', audience: 'app' })).toThrow();
  });
});

describe('OIDC JWKS verification', () => {
  it('checks signature, algorithm, issuer, audience, subject and expiration', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const verifier = createJwksAuthenticator({ jwksUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/jwks`, issuer: 'https://issuer.example', audience: 'alexa-mcp' });
      const sign = (audience: string, expiration: string) => new SignJWT({ scope: 'mcp' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject('alice').setIssuer('https://issuer.example').setAudience(audience)
        .setIssuedAt().setExpirationTime(expiration).sign(privateKey);
      expect((await verifier(await sign('alexa-mcp', '15m')))?.subject).toBe('alice');
      expect(await verifier(await sign('other', '15m'))).toBeNull();
      expect(await verifier(await sign('alexa-mcp', '-10s'))).toBeNull();
      expect(await verifier('invalid')).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
  });
});

// CI supplies Redis; local runs skip only the external integration test, never the auth tests.
const redisUrl = process.env.REDIS_URL;
describe.skipIf(!redisUrl)('real Redis cross-instance and TTL integration', () => {
  it('shares sessions, publishes SSE events, replays across instances, and expires state', async () => {
    const client = createClient({ url: redisUrl, RESP: 2 });
    await client.connect();
    const namespace = `mcp-test-${randomUUID().replaceAll('-', '')}`;
    const a = new RedisSessionStore(client, { namespace, ttlSeconds: 2 });
    const b = new RedisSessionStore(client, { namespace, ttlSeconds: 2 });
    await a.connect(); await b.connect();
    try {
      const id = await a.create('alice', MCP_2025_PROTOCOL_VERSION);
      expect((await b.get(id))?.subject).toBe('alice');
      const pushed = new Promise<SessionMessage>(resolve => { void b.subscribe(id, resolve); });
      const prime = await b.append(id, '', null, true);
      const event = await a.append(id, 'message', { jsonrpc: '2.0', id: 1, result: {} });
      expect(await pushed).toEqual(event);
      expect(await b.eventsAfter(id, prime.id)).toEqual([event]);
      await new Promise(resolve => setTimeout(resolve, 2300));
      expect(await b.get(id)).toBeNull();
      await expect(a.append(id, 'message', {})).rejects.toThrow();
    } finally { await a.close(); await b.close(); await client.quit(); }
  }, 10_000);
});
