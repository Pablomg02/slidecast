import { createHmac, timingSafeEqual } from 'node:crypto';

export const DECK_TOKEN_TTL = 7 * 24 * 3600;

function mac(secret, slug, expires) {
  return createHmac('sha256', secret).update(`${slug}.${expires}`).digest('base64url');
}

// Path segment "<expires>.<mac>" granting access to one deck's files.
export function issueDeckToken(secret, slug, now = Date.now()) {
  const expires = Math.floor(now / 1000) + DECK_TOKEN_TTL;
  return `${expires}.${mac(secret, slug, expires)}`;
}

export function verifyDeckToken(secret, slug, token, now = Date.now()) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
  if (!m) return false;
  const expires = Number(m[1]);
  // A later expiry than issueDeckToken gives can only come from a forged token
  // (a few minutes of slack in case the clock is set back).
  if (expires * 1000 <= now || expires > Math.floor(now / 1000) + DECK_TOKEN_TTL + 300) return false;
  const want = Buffer.from(mac(secret, slug, expires));
  const got = Buffer.from(m[2]);
  return got.length === want.length && timingSafeEqual(got, want);
}
