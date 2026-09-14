/**
 * Secret redaction, shared by every artifact the harness writes.
 *
 * Split out of `writer.ts` so the engine can redact without importing `node:fs`. Both
 * `trace.jsonl` and `context.jsonl` run their text through this: the captured context is
 * a far larger surface than the trace (whole file bodies, whole command outputs, whole
 * tool arguments), so applying a weaker rule there would make the sidecar the leak.
 */

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,
  /\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (value, pattern) =>
      value.replace(pattern, (_match, prefix?: string) =>
        typeof prefix === 'string' && prefix.toLowerCase().startsWith('bearer')
          ? `${prefix}[REDACTED]`
          : '[REDACTED]',
      ),
    text.replace(
      /(["'](?:api[_-]?key|token|password|secret|client[_-]?secret|access[_-]?token)["']\s*:\s*["'])([^"']*)(["'])/gi,
      '$1[REDACTED]$3',
    ),
  );
}

/**
 * Keys whose *value* is a credential whatever it looks like.
 *
 * Pattern matching on the value alone is not enough: `{"password": "hunter2"}` and
 * `{"token": "9f3a-2201"}` carry secrets that no regex over the string would flag, because
 * the thing that makes them secret is the key, not the shape. Tool arguments are the
 * realistic path for that — a model writing a config file or calling a script with
 * credentials — so the capture scrubs by key as well as by content.
 *
 * Matched against the key with separators and case normalized away, so `apiKey`,
 * `api_key`, `API-KEY` and `apikey` are one rule.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'apikey',
  'apisecret',
  'accesskey',
  'accesskeyid',
  'secretaccesskey',
  'privatekey',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'sessionkey',
  'bearer',
]);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[\s_.\-]/g, '').toLowerCase();
  if (SENSITIVE_KEYS.has(normalized)) return true;
  // A plural key holds the same thing several times: `{"tokens": [...]}` is exactly as
  // sensitive as `{"token": "..."}`. Checked as a fallback rather than by stemming the
  // whole set, so `tokenizer` and `access` stay ordinary keys.
  return normalized.endsWith('s') && SENSITIVE_KEYS.has(normalized.slice(0, -1));
}

/** Redacts and reports whether anything changed, so the record can say that it did. */
export function redactTracked(text: string): { text: string; redacted: boolean } {
  const redacted = redactSecrets(text);
  return { text: redacted, redacted: redacted !== text };
}

/** Scrub strings in metadata while preserving schema keys and numeric settings. */
export function redactMetadata<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactMetadata) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactMetadata(entry)]),
    ) as T;
  }
  return value;
}
