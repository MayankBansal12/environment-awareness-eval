import crypto from 'node:crypto';

export function sign(secret, timestamp, payload) {
  return crypto.createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
}

export function verifyWebhook({ payload, timestamp, signature, secret, now, seen }) {
  const expected = sign(secret, timestamp, payload);
  const expectedBuf = Buffer.from(expected, 'hex');
  const signatureBuf =
    typeof signature === 'string' && /^[0-9a-f]+$/.test(signature) ? Buffer.from(signature, 'hex') : null;
  if (
    !signatureBuf ||
    signatureBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(signatureBuf, expectedBuf)
  )
    return { ok: false, reason: 'bad_signature' };
  if (Math.abs(now - timestamp) > 300) return { ok: false, reason: 'stale_timestamp' };
  if (seen.has(timestamp + '.' + signature)) return { ok: false, reason: 'replayed' };
  seen.add(timestamp + '.' + signature);
  return { ok: true };
}
