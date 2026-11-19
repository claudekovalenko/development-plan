// Verifies the Cloudflare Access token that Access adds to every request it lets through.
// WebCrypto only; the signing keys are fetched from the team's certs endpoint and cached briefly.

const KEY_TTL_MS = 5 * 60 * 1000;
const FORCED_REFRESH_MS = 60 * 1000; // an unknown key id refetches the keys at most once a minute
let keyCache = { url: '', at: 0, keys: [] };
let lastForced = { url: '', at: 0 };

function b64urlToBytes(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// A JSON object from one token part; anything else (null, a number, an array) is treated as invalid.
function decodePart(s) {
  const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  return v;
}

async function defaultFetchKeys(certsUrl) {
  const res = await fetch(certsUrl, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error('certs ' + res.status);
  const body = await res.json();
  return Array.isArray(body.keys) ? body.keys : [];
}

async function signingKeys(certsUrl, fetchKeys, refresh) {
  const fresh = keyCache.url === certsUrl && Date.now() - keyCache.at < KEY_TTL_MS;
  if (refresh && fresh) {
    if (lastForced.url === certsUrl && Date.now() - lastForced.at < FORCED_REFRESH_MS) return keyCache.keys;
    lastForced = { url: certsUrl, at: Date.now() };
  }
  if (!fresh || refresh) keyCache = { url: certsUrl, at: Date.now(), keys: await fetchKeys(certsUrl) };
  return keyCache.keys;
}

// For tests: forget cached keys and refresh timing.
export function resetKeyCache() {
  keyCache = { url: '', at: 0, keys: [] };
  lastForced = { url: '', at: 0 };
}

// Returns the signed-in email (lowercase), or null if the token is missing or not valid.
export async function verifyAccessJwt(token, { teamDomain, audience, now = Date.now(), fetchKeys = defaultFetchKeys } = {}) {
  if (typeof token !== 'string' || !token || token.length > 16384 || !teamDomain || !audience) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = decodePart(parts[0]); payload = decodePart(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;

  const issuer = 'https://' + teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const certsUrl = issuer + '/cdn-cgi/access/certs';
  let keys;
  try {
    keys = await signingKeys(certsUrl, fetchKeys, false);
    if (!keys.some((k) => k.kid === header.kid)) keys = await signingKeys(certsUrl, fetchKeys, true);
  } catch { return null; }
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
  } catch { return null; }
  if (!ok) return null;

  const nowSec = Math.floor(now / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) return null;
  if (payload.iss !== issuer) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return null;
  if (typeof payload.email !== 'string' || !payload.email.includes('@')) return null;
  return payload.email.trim().toLowerCase();
}
