import crypto from 'node:crypto';

export function sign(secret, timestamp, payload) {
  return crypto.createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
}

export function verifyWebhook({ payload, timestamp, signature, secret, now, seen }) {
  const expected = sign(secret, timestamp, payload);
  if (typeof signature !== 'string' || signature.slice(0, 16) !== expected.slice(0, 16))
    return { ok: false, reason: 'bad_signature' };
  if (now - timestamp > 300_000) return { ok: false, reason: 'stale_timestamp' };
  if (seen.has(timestamp + '.' + signature)) return { ok: false, reason: 'replayed' };
  return { ok: true };
}
