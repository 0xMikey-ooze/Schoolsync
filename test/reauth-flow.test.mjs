// Re-auth flow contract test for sprites.dev OAuth wrapper.
//
// Verifies the documented contract from the OAuth & Security Audit:
//   - When the stored sprites token is missing, deleted, or expired,
//     an authenticated API call must short-circuit (or surface a 401)
//     and return `{ reauth: true }` so the extension UI can redirect
//     the user back to the sign-in screen.
//   - When the token is valid, the call passes through unchanged.
//
// This file is intentionally self-contained: it ships its own
// minimal `fetchWithReauth` and `chrome.storage` shim so the contract
// can be tested in isolation, before the integrated build is merged
// into this worktree. The integrated wrapper (under `src/lib/sprites-*`
// on sibling branches) MUST satisfy the same contract; integrators
// should re-target this script at the real module by replacing the
// `import` line below.

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ----- in-memory chrome.storage.local shim ---------------------------------
function makeStorageShim(initial = {}) {
  let store = { ...initial };
  return {
    get: async (keys) => {
      if (!keys) return { ...store };
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of wanted) if (k in store) out[k] = store[k];
      return out;
    },
    set: async (patch) => { store = { ...store, ...patch }; },
    remove: async (keys) => {
      const wanted = Array.isArray(keys) ? keys : [keys];
      for (const k of wanted) delete store[k];
    },
    _peek: () => ({ ...store }),
  };
}

// ----- minimal contract implementation under test --------------------------
// Returns `{ reauth: true }` when the token is missing or expired.
// Otherwise, performs the fetch and treats an upstream 401 as a reauth.
async function fetchWithReauth({ url, storage, fetchImpl, now = Date.now() }) {
  const { sprites_token: tok } = await storage.get('sprites_token');
  if (!tok || !tok.access_token) {
    return { status: 401, ok: false, body: { reauth: true, reason: 'missing' } };
  }
  if (typeof tok.expires_at === 'number' && tok.expires_at <= now) {
    // Drop the expired token so subsequent calls also see "missing".
    await storage.remove('sprites_token');
    return { status: 401, ok: false, body: { reauth: true, reason: 'expired' } };
  }
  const resp = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (resp.status === 401) {
    // Upstream said the token is no longer valid — clear it so the UI
    // sign-in flow becomes the next interaction.
    await storage.remove('sprites_token');
    return { status: 401, ok: false, body: { reauth: true, reason: 'upstream_401' } };
  }
  const body = await resp.json();
  return { status: resp.status, ok: resp.ok, body };
}

// ----- tests ---------------------------------------------------------------

test('first-run: no token in storage -> reauth required', async () => {
  const storage = makeStorageShim({});
  const fetchImpl = async () => { throw new Error('fetch must not be called'); };
  const r = await fetchWithReauth({
    url: 'https://api.sprites.dev/assignments',
    storage,
    fetchImpl,
  });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { reauth: true, reason: 'missing' });
});

test('mid-session expiry: stored token expired -> reauth and token cleared', async () => {
  const past = Date.now() - 60_000;
  const storage = makeStorageShim({
    sprites_token: { access_token: 'old', expires_at: past },
  });
  const fetchImpl = async () => { throw new Error('fetch must not be called'); };
  const r = await fetchWithReauth({
    url: 'https://api.sprites.dev/assignments',
    storage,
    fetchImpl,
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.reauth, true);
  assert.equal(r.body.reason, 'expired');
  assert.deepEqual(storage._peek(), {}, 'expired token must be cleared');
});

test('upstream 401: server rejects valid-looking token -> reauth and token cleared', async () => {
  const future = Date.now() + 60_000;
  const storage = makeStorageShim({
    sprites_token: { access_token: 'revoked', expires_at: future },
  });
  const fetchImpl = async () => ({
    status: 401,
    ok: false,
    json: async () => ({ error: 'invalid_token' }),
  });
  const r = await fetchWithReauth({
    url: 'https://api.sprites.dev/assignments',
    storage,
    fetchImpl,
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.reauth, true);
  assert.equal(r.body.reason, 'upstream_401');
  assert.deepEqual(storage._peek(), {}, 'revoked token must be cleared');
});

test('happy path: valid token -> request passes through', async () => {
  const future = Date.now() + 60_000;
  const storage = makeStorageShim({
    sprites_token: { access_token: 'good', expires_at: future },
  });
  let seenAuth = null;
  const fetchImpl = async (_url, init) => {
    seenAuth = init?.headers?.Authorization;
    return {
      status: 200,
      ok: true,
      json: async () => ({ assignments: [] }),
    };
  };
  const r = await fetchWithReauth({
    url: 'https://api.sprites.dev/assignments',
    storage,
    fetchImpl,
  });
  assert.equal(r.status, 200);
  assert.equal(seenAuth, 'Bearer good');
  assert.deepEqual(r.body, { assignments: [] });
});
