// Unit checks for the Cloudflare Access token verification, with a locally generated key.
import { verifyAccessJwt, resetKeyCache } from '../src/access.js';

const TEAM = 'test-team.cloudflareaccess.com';
const AUD = 'test-audience-tag';
const ISS = 'https://' + TEAM;
let failures = 0;
const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) failures++; };

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
let fetches = 0;
const fetchKeys = async (url) => { fetches++; if (url !== ISS + '/cdn-cgi/access/certs') throw new Error('wrong url ' + url); return [jwk]; };

async function sign(payload, { header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key = pair.privateKey } = {}) {
  const head = enc(header) + '.' + enc(payload);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head)));
  return head + '.' + b64url(sig);
}
const now = Date.now();
const at = (name) => name + '@' + 'example.test';
const good = { aud: [AUD], iss: ISS, email: at('Person'), exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000) };
const opts = { teamDomain: TEAM, audience: AUD, now, fetchKeys };

check('valid token gives the lowercase email', (await verifyAccessJwt(await sign(good), opts)) === at('person'));
check('missing token is rejected', (await verifyAccessJwt(null, opts)) === null);
check('expired token is rejected', (await verifyAccessJwt(await sign({ ...good, exp: Math.floor(now / 1000) - 1 }), opts)) === null);
check('token for another application (aud) is rejected', (await verifyAccessJwt(await sign({ ...good, aud: ['someone-else'] }), opts)) === null);
check('token from another team (iss) is rejected', (await verifyAccessJwt(await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }), opts)) === null);
check('token not yet valid (nbf) is rejected', (await verifyAccessJwt(await sign({ ...good, nbf: Math.floor(now / 1000) + 3600 }), opts)) === null);
check('token without an email is rejected', (await verifyAccessJwt(await sign({ ...good, email: undefined }), opts)) === null);
check('token signed by a different key is rejected', (await verifyAccessJwt(await sign(good, { key: other.privateKey }), opts)) === null);
const unsigned = enc({ alg: 'none', typ: 'JWT' }) + '.' + enc(good) + '.';
check('unsigned (alg none) token is rejected', (await verifyAccessJwt(unsigned, opts)) === null);
const hs = enc({ alg: 'HS256', kid: 'k1' }) + '.' + enc(good) + '.' + b64url(new Uint8Array(32));
check('HS256 token is rejected', (await verifyAccessJwt(hs, opts)) === null);
const t = await sign(good); const [h, , s] = t.split('.');
check('tampered payload is rejected', (await verifyAccessJwt(h + '.' + enc({ ...good, email: at('boss') }) + '.' + s, opts)) === null);
check('garbage is rejected', (await verifyAccessJwt('not.a.jwt', opts)) === null);
const before = fetches;
check('unknown key id is rejected', (await verifyAccessJwt(await sign(good, { header: { alg: 'RS256', kid: 'nope' } }), opts)) === null);
check('unknown key id refetches the keys once', fetches === before + 1);
for (let i = 0; i < 5; i++) await verifyAccessJwt(await sign(good, { header: { alg: 'RS256', kid: 'nope' + i } }), opts);
check('more unknown key ids within a minute do not refetch again', fetches === before + 1);
check('a token whose header is null is rejected', (await verifyAccessJwt(enc(null) + '.' + enc(good) + '.x', opts)) === null);
check('a token whose payload is null is rejected', (await verifyAccessJwt(enc({ alg: 'RS256', kid: 'k1' }) + '.' + enc(null) + '.x', opts)) === null);
check('a correctly signed null payload is rejected', (await verifyAccessJwt(await sign(null), opts)) === null);
check('a correctly signed array payload is rejected', (await verifyAccessJwt(await sign([good]), opts)) === null);
check('a header with a non-text key id is rejected', (await verifyAccessJwt(await sign(good, { header: { alg: 'RS256', kid: { k: 1 } } }), opts)) === null);
check('an oversized token is rejected', (await verifyAccessJwt('a'.repeat(20000) + '.b.c', opts)) === null);
resetKeyCache();
check('no team domain configured rejects everything', (await verifyAccessJwt(await sign(good), { ...opts, teamDomain: '' })) === null);
check('no audience configured rejects everything', (await verifyAccessJwt(await sign(good), { ...opts, audience: '' })) === null);
check('certs fetch failure rejects', (await verifyAccessJwt(await sign(good, { header: { alg: 'RS256', kid: 'k2' } }), { ...opts, fetchKeys: async () => { throw new Error('down'); } })) === null);

console.log(failures ? failures + ' access check(s) failed' : 'all access checks passed');
process.exit(failures ? 1 : 0);
