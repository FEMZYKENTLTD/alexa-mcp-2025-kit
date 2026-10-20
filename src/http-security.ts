/** Shared security policy used by the transport guard and the example's pre-parser gate. */
export const DEFAULT_ALLOWED_ORIGINS: (string | RegExp)[] = ['localhost', '127.0.0.1', '*.e2b.app'];

export function originAllowed(origin: string, patterns: (string | RegExp)[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) return false;
  } catch { return false; }
  return patterns.some(pattern => {
    if (pattern instanceof RegExp) { pattern.lastIndex = 0; return pattern.test(origin); }
    if (pattern === '*.e2b.app') return url.hostname.endsWith('.e2b.app') && url.hostname !== '.e2b.app';
    if (pattern.includes('://')) return origin === pattern;
    return url.hostname.toLowerCase() === pattern.toLowerCase();
  });
}

export function jsonRpcHttpError(res: {
  statusCode: number;
  setHeader: (key: string, value: string) => void;
  end: (body: string) => void;
}, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: status === 403 ? -32000 : -32600, message } }));
}
