// Run with: node test/auth.test.js
// No external dependencies, no network, no database — pure crypto tests
// against the verification logic in src/auth.js.

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_JWT_SECRET = 'legacy-shared-secret-1234567890';

const crypto = require('crypto');
const { verifyJwt } = require('../src/auth');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function makeUnsigned(header, payload) {
  const h = b64url(JSON.stringify(header)), p = b64url(JSON.stringify(payload));
  return `${h}.${p}`;
}
const futurePayload = { sub: 'user-123', email: 'test@example.com', exp: Math.floor(Date.now()/1000) + 3600 };
const expiredPayload = { sub: 'user-123', email: 'test@example.com', exp: Math.floor(Date.now()/1000) - 10 };

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } }

(async () => {
  // ---- HS256 (legacy) ----
  {
    const unsigned = makeUnsigned({ alg: 'HS256', typ: 'JWT' }, futurePayload);
    const sig = crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(unsigned).digest();
    const token = `${unsigned}.${b64url(sig)}`;
    const result = await verifyJwt(token);
    check('HS256 valid token verifies and returns correct sub', result && result.sub === 'user-123');
  }
  {
    // wrong secret -> must fail
    const unsigned = makeUnsigned({ alg: 'HS256', typ: 'JWT' }, futurePayload);
    const sig = crypto.createHmac('sha256', 'WRONG-SECRET').update(unsigned).digest();
    const token = `${unsigned}.${b64url(sig)}`;
    const result = await verifyJwt(token);
    check('HS256 tampered/wrong-secret token is rejected', result === null);
  }
  {
    // expired -> must fail
    const unsigned = makeUnsigned({ alg: 'HS256', typ: 'JWT' }, expiredPayload);
    const sig = crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(unsigned).digest();
    const token = `${unsigned}.${b64url(sig)}`;
    const result = await verifyJwt(token);
    check('HS256 expired token is rejected', result === null);
  }

  // ---- ES256 (current Supabase default) ----
  {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    jwk.kid = 'test-es-kid';
    jwk.alg = 'ES256';
    const fakeJwks = async () => [jwk];

    const unsigned = makeUnsigned({ alg: 'ES256', typ: 'JWT', kid: 'test-es-kid' }, futurePayload);
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const token = `${unsigned}.${b64url(sig)}`;
    const result = await verifyJwt(token, { getJwks: fakeJwks });
    check('ES256 valid token (matching kid) verifies', result && result.sub === 'user-123');

    // signed by a DIFFERENT key but claiming the same kid -> must fail
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const badSig = crypto.sign('sha256', Buffer.from(unsigned), { key: other.privateKey, dsaEncoding: 'ieee-p1363' });
    const badToken = `${unsigned}.${b64url(badSig)}`;
    const badResult = await verifyJwt(badToken, { getJwks: fakeJwks });
    check('ES256 token signed by wrong private key is rejected', badResult === null);

    // unknown kid -> must fail
    const unknownKidUnsigned = makeUnsigned({ alg: 'ES256', typ: 'JWT', kid: 'no-such-kid' }, futurePayload);
    const sig2 = crypto.sign('sha256', Buffer.from(unknownKidUnsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const token2 = `${unknownKidUnsigned}.${b64url(sig2)}`;
    const result2 = await verifyJwt(token2, { getJwks: fakeJwks });
    check('ES256 token with unknown kid is rejected', result2 === null);
  }

  // ---- RS256 (alternate asymmetric default) ----
  {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    jwk.kid = 'test-rs-kid';
    jwk.alg = 'RS256';
    const fakeJwks = async () => [jwk];

    const unsigned = makeUnsigned({ alg: 'RS256', typ: 'JWT', kid: 'test-rs-kid' }, futurePayload);
    const sig = crypto.sign('sha256', Buffer.from(unsigned), privateKey);
    const token = `${unsigned}.${b64url(sig)}`;
    const result = await verifyJwt(token, { getJwks: fakeJwks });
    check('RS256 valid token verifies', result && result.sub === 'user-123');
  }

  // ---- malformed input handling ----
  check('garbage string does not throw, returns null', await verifyJwt('not-a-jwt') === null);
  check('empty string does not throw, returns null', await verifyJwt('') === null);
  check('non-string does not throw, returns null', await verifyJwt(undefined) === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
