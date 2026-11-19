// Verifies the Cloudflare Access token that Access adds to every request it lets through.
// WebCrypto only; the signing keys are fetched from the team's certs endpoint and cached briefly.

const KEY_TTL_MS = 5 * 60 * 1000;
let keyCache = { url: '', at: 0, keys: [] };

function b64urlToBytes(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function defaultFetchKeys(certsUrl) {
  const res = await fetch(certsUrl, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error('certs ' + res.status);
  const body = await res.json();
  return Array.isArray(body.keys) ? body.keys : [];
}

async function signingKeys(certsUrl, fetchKeys, refresh) {
  const fresh = keyCache.url === certsUrl && Date.now() - keyCache.at < KEY_TTL_MS;
  if (!fresh || refresh) keyCache = { url: certsUrl, at: Date.now(), keys: await fetchKeys(certsUrl) };
  return keyCache.keys;
}

// Returns the signed-in email (lowercase), or null if the token is missing or not valid.
export async function verifyAccessJwt(token, { teamDomain, audience, now = Date.now(), fetchKeys = defaultFetchKeys } = {}) {
  if (!token || !teamDomain || !audience) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = decodePart(parts[0]); payload = decodePart(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;

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
