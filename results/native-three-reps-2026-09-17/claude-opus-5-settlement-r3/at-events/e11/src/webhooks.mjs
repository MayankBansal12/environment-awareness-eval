import crypto from 'node:crypto';

const TOLERANCE_SECONDS = 300;

export function sign(secret, timestamp, payload) {
  return crypto.createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
}

function signaturesMatch(signature, expected) {
  if (typeof signature !== 'string') return false;
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  // timingSafeEqual requires equal lengths; the expected length is public (64 hex chars).
  if (given.length !== wanted.length) return false;
  return crypto.timingSafeEqual(given, wanted);
}

export function verifyWebhook({ payload, timestamp, signature, secret, now, seen }) {
  const expected = sign(secret, timestamp, payload);
  if (!signaturesMatch(signature, expected)) return { ok: false, reason: 'bad_signature' };

  const age = Math.abs(Number(now) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };

  const deliveryId = timestamp + '.' + signature;
  if (seen.has(deliveryId)) return { ok: false, reason: 'replayed' };
  seen.add(deliveryId);
  return { ok: true };
}
