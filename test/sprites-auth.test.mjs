/**
 * Node-runnable test for src/lib/sprites-auth.js.
 *
 * Mocks chrome.storage.local with an in-memory Map, supplies Node webcrypto
 * for SubtleCrypto, and stubs fetch so we can assert the exact OAuth wire
 * payloads (PKCE, state, code exchange, refresh grant). Every test that
 * touches storage starts from a clean slate.
 *
 * Run: node test/sprites-auth.test.mjs
 */

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// --- mock chrome.storage.local ---------------------------------------------
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keyOrKeys) {
        const out = {};
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      async remove(keyOrKeys) {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        for (const k of keys) store.delete(k);
      },
    },
  },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;
else if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');
}

const auth = await import('../src/lib/sprites-auth.js');
const storeMod = await import('../src/lib/sprites-store.js');
const {
  setConfig,
  getAuthorizationUrl,
  handleCallback,
  getValidToken,
  ReauthRequiredError,
  withReauth,
  __internals,
} = auth;

const SAMPLE_CONFIG = {
  authorizeUrl: 'https://sprites.dev/oauth/authorize',
  tokenUrl: 'https://sprites.dev/oauth/token',
  clientId: 'schoolsync-extension',
  redirectUri: 'https://abcdef.chromiumapp.org/',
  scopes: ['profile', 'assignments.read'],
};

let passed = 0;
async function test(name, fn) {
  store.clear();
  await setConfig(SAMPLE_CONFIG);
  try {
    await fn();
    console.log(`  ok  — ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL — ${name}\n${e.stack || e}`);
    process.exitCode = 1;
  }
}

/* ---------- /auth/sprites/url ---------- */

await test('getAuthorizationUrl emits PKCE + state and stashes pending state', async () => {
  const { url, state } = await getAuthorizationUrl();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, SAMPLE_CONFIG.authorizeUrl);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), SAMPLE_CONFIG.clientId);
  assert.equal(u.searchParams.get('redirect_uri'), SAMPLE_CONFIG.redirectUri);
  assert.equal(u.searchParams.get('scope'), 'profile assignments.read');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('code_challenge') || '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(u.searchParams.get('state'), state);
  // state is persisted server-side so callback can validate it
  const pending = store.get(__internals.PENDING_KEY);
  assert.equal(pending.state, state);
  assert.match(pending.code_verifier, /^[A-Za-z0-9_-]+$/);
  assert.ok(pending.code_verifier.length >= 43 && pending.code_verifier.length <= 128);
});

await test('getAuthorizationUrl mints a fresh state and verifier on each call', async () => {
  const a = await getAuthorizationUrl();
  const b = await getAuthorizationUrl();
  assert.notEqual(a.state, b.state);
  // Latest call overwrites pending (single-flight per browser)
  const pending = store.get(__internals.PENDING_KEY);
  assert.equal(pending.state, b.state);
});

/* ---------- /auth/sprites/callback ---------- */

function tokenEndpointStub({ expectedGrant, response, status = 200, capture }) {
  return async (url, init) => {
    assert.equal(url, SAMPLE_CONFIG.tokenUrl);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), expectedGrant);
    if (capture) capture(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return response; },
      async text() { return JSON.stringify(response); },
    };
  };
}

await test('handleCallback validates state, exchanges code, persists encrypted tokens', async () => {
  const { url, state } = await getAuthorizationUrl();
  const u = new URL(url);
  const challenge = u.searchParams.get('code_challenge');

  let capturedBody;
  const fetchImpl = tokenEndpointStub({
    expectedGrant: 'authorization_code',
    capture: (b) => { capturedBody = b; },
    response: {
      access_token: 'sprite_access_abc',
      refresh_token: 'sprite_refresh_xyz',
      expires_in: 3600,
      token_type: 'Bearer',
      user_id: 'user-42',
    },
  });

  const callbackUrl = `${SAMPLE_CONFIG.redirectUri}?code=auth-code-1&state=${encodeURIComponent(state)}`;
  const result = await handleCallback(callbackUrl, { fetchImpl, now: 1_700_000_000_000 });
  assert.equal(result.user_id, 'user-42');

  // Verifier was sent and the SHA-256 matches the challenge from /url.
  const verifier = capturedBody.get('code_verifier');
  assert.ok(verifier);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challengeFromVerifier = Buffer.from(new Uint8Array(digest))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challengeFromVerifier, challenge);
  assert.equal(capturedBody.get('client_id'), SAMPLE_CONFIG.clientId);
  assert.equal(capturedBody.get('redirect_uri'), SAMPLE_CONFIG.redirectUri);
  assert.equal(capturedBody.get('code'), 'auth-code-1');

  // Pending state was consumed (no replay).
  assert.equal(store.has(__internals.PENDING_KEY), false);

  // Decrypted access_token round-trips through user_sessions.
  const session = await storeMod.userSessions.get('user-42');
  assert.equal(session.access_token, 'sprite_access_abc');
  assert.equal(session.refresh_token, 'sprite_refresh_xyz');
  assert.equal(session.expires_at, 1_700_000_000_000 + 3600 * 1000);

  // The raw chrome.storage row stores ciphertext, never plaintext tokens.
  const rawRow = store.get('sprites:row:user_sessions:user-42');
  assert.notEqual(rawRow.access_token, 'sprite_access_abc');
  assert.equal(typeof rawRow.access_token.iv, 'string');
  assert.equal(typeof rawRow.access_token.ct, 'string');
});

await test('handleCallback rejects state mismatch and clears pending', async () => {
  await getAuthorizationUrl();
  const fetchImpl = () => { throw new Error('should not be called'); };
  await assert.rejects(
    handleCallback(`${SAMPLE_CONFIG.redirectUri}?code=c&state=wrong-state`, { fetchImpl }),
    /state mismatch/,
  );
  // Pending was cleared so a leaked code cannot be replayed against the
  // attacker-supplied state in a follow-up request.
  assert.equal(store.has(__internals.PENDING_KEY), false);
});

await test('handleCallback rejects expired pending request', async () => {
  const { state } = await getAuthorizationUrl({ now: 0 });
  const fetchImpl = () => { throw new Error('should not be called'); };
  await assert.rejects(
    handleCallback(`${SAMPLE_CONFIG.redirectUri}?code=c&state=${state}`, {
      fetchImpl,
      now: __internals.PENDING_TTL_MS + 1,
    }),
    /expired/,
  );
});

await test('handleCallback surfaces provider error responses', async () => {
  await getAuthorizationUrl();
  await assert.rejects(
    handleCallback(`${SAMPLE_CONFIG.redirectUri}?error=access_denied&error_description=user`, {
      fetchImpl: () => { throw new Error('not used'); },
    }),
    /access_denied/,
  );
});

await test('handleCallback derives user_id from id_token.sub when user_id absent', async () => {
  const { state } = await getAuthorizationUrl();
  const idTokenPayload = Buffer.from(JSON.stringify({ sub: 'oidc-sub-7' }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const id_token = `header.${idTokenPayload}.sig`;
  const fetchImpl = tokenEndpointStub({
    expectedGrant: 'authorization_code',
    response: { access_token: 'a', expires_in: 3600, id_token },
  });
  const r = await handleCallback(
    `${SAMPLE_CONFIG.redirectUri}?code=c&state=${encodeURIComponent(state)}`,
    { fetchImpl },
  );
  assert.equal(r.user_id, 'oidc-sub-7');
});

/* ---------- getValidToken / refresh ---------- */

await test('getValidToken returns unexpired access_token without network', async () => {
  await storeMod.userSessions.upsert({
    user_id: 'u1',
    access_token: 'still-good',
    refresh_token: 'r',
    expires_at: 1000 + 60 * 60 * 1000,
  });
  const fetchImpl = () => { throw new Error('should not be called'); };
  const tok = await getValidToken('u1', { fetchImpl, now: 1000 });
  assert.equal(tok, 'still-good');
});

await test('getValidToken refreshes when expired and persists rotated tokens', async () => {
  const now = 2_000_000_000_000;
  await storeMod.userSessions.upsert({
    user_id: 'u2',
    access_token: 'old',
    refresh_token: 'old-refresh',
    expires_at: now - 1,
  });
  let captured;
  const fetchImpl = tokenEndpointStub({
    expectedGrant: 'refresh_token',
    capture: (b) => { captured = b; },
    response: {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 7200,
    },
  });
  const tok = await getValidToken('u2', { fetchImpl, now });
  assert.equal(tok, 'new-access');
  assert.equal(captured.get('refresh_token'), 'old-refresh');
  const session = await storeMod.userSessions.get('u2');
  assert.equal(session.access_token, 'new-access');
  assert.equal(session.refresh_token, 'new-refresh');
  assert.equal(session.expires_at, now + 7200 * 1000);
});

await test('getValidToken keeps prior refresh_token when provider omits rotation', async () => {
  const now = 3_000_000_000_000;
  await storeMod.userSessions.upsert({
    user_id: 'u3', access_token: 'a', refresh_token: 'keep-me', expires_at: now - 1,
  });
  const fetchImpl = tokenEndpointStub({
    expectedGrant: 'refresh_token',
    response: { access_token: 'rotated', expires_in: 1800 },
  });
  await getValidToken('u3', { fetchImpl, now });
  const session = await storeMod.userSessions.get('u3');
  assert.equal(session.refresh_token, 'keep-me');
});

await test('getValidToken throws ReauthRequiredError when no session', async () => {
  await assert.rejects(
    () => getValidToken('nope', { fetchImpl: () => { throw new Error('x'); } }),
    (err) => err instanceof ReauthRequiredError,
  );
});

await test('getValidToken throws ReauthRequiredError when refresh_token absent', async () => {
  await storeMod.userSessions.upsert({
    user_id: 'u4', access_token: 'a', refresh_token: null, expires_at: 1,
  });
  await assert.rejects(
    () => getValidToken('u4', { fetchImpl: () => { throw new Error('x'); }, now: 999 }),
    (err) => err instanceof ReauthRequiredError && /no refresh_token/i.test(err.message),
  );
});

await test('getValidToken throws ReauthRequiredError when provider rejects refresh', async () => {
  await storeMod.userSessions.upsert({
    user_id: 'u5', access_token: 'a', refresh_token: 'r', expires_at: 1,
  });
  const fetchImpl = tokenEndpointStub({
    expectedGrant: 'refresh_token',
    response: { error: 'invalid_grant' },
    status: 400,
  });
  await assert.rejects(
    () => getValidToken('u5', { fetchImpl, now: 999 }),
    (err) => err instanceof ReauthRequiredError && /400/.test(err.message),
  );
});

/* ---------- withReauth middleware ---------- */

await test('withReauth converts ReauthRequiredError into { reauth: true }', async () => {
  const wrapped = withReauth(async () => {
    throw new ReauthRequiredError('go back to sign in');
  });
  const r = await wrapped();
  assert.equal(r.ok, false);
  assert.equal(r.reauth, true);
  assert.equal(r.error, 'go back to sign in');
});

await test('withReauth lets other errors bubble', async () => {
  const wrapped = withReauth(async () => { throw new Error('boom'); });
  await assert.rejects(wrapped(), /boom/);
});

await test('withReauth returns successful results unchanged', async () => {
  const wrapped = withReauth(async (n) => ({ ok: true, doubled: n * 2 }));
  assert.deepEqual(await wrapped(7), { ok: true, doubled: 14 });
});

/* ---------- token never leaks into response bodies ---------- */

await test('handleCallback result contains no access_token / refresh_token', async () => {
  const { state } = await getAuthorizationUrl();
  const fetchImpl = tokenEndpointStub({
    expectedGrant: 'authorization_code',
    response: { access_token: 'a', refresh_token: 'r', expires_in: 60, user_id: 'u' },
  });
  const r = await handleCallback(
    `${SAMPLE_CONFIG.redirectUri}?code=c&state=${encodeURIComponent(state)}`,
    { fetchImpl },
  );
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'access_token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'refresh_token'), false);
});

console.log(`\n${passed} passed`);
