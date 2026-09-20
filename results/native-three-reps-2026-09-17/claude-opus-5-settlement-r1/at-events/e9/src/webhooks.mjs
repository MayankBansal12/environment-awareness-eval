import crypto from 'node:crypto';

const TOLERANCE_SECONDS = 300;

export function sign(secret, timestamp, payload) {
  return crypto.createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
}

function signatureMatches(signature, expected) {
  if (typeof signature !== 'string') return false;
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  // Length is not secret (always 64 hex chars); compare full contents in constant time.
  if (given.length !== wanted.length) return false;
  return crypto.timingSafeEqual(given, wanted);
}

export function verifyWebhook({ payload, timestamp, signature, secret, now, seen }) {
  const expected = sign(secret, timestamp, payload);
  if (!signatureMatches(signature, expected)) return { ok: false, reason: 'bad_signature' };
  if (!Number.isFinite(timestamp) || !Number.isFinite(now) || Math.abs(now - timestamp) > TOLERANCE_SECONDS)
    return { ok: false, reason: 'stale_timestamp' };
  const deliveryId = timestamp + '.' + signature;
  if (seen.has(deliveryId)) return { ok: false, reason: 'replayed' };
  seen.add(deliveryId);
  return { ok: true };
}
