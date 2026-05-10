/**
 * Node-runnable test for src/lib/sprites-ui.js — the popup-side OAuth glue
 * for Lane 4 ("UI — Sign-in Page & OAuth Redirect Flow").
 *
 * Stubs chrome.runtime.sendMessage, chrome.identity.launchWebAuthFlow, and
 * chrome.storage.local with deterministic in-memory implementations so we
 * can assert the exact wire shape and acceptance criteria from the PRD:
 *   - happy-path round-trip persists `user_id` only (no token leakage)
 *   - launchWebAuthFlow is called interactively with the URL we received
 *   - reauth response triggers onReauth and clears the persisted user_id
 *   - cancelled web-auth-flow surfaces a clean error (no DOM/log token)
 *   - "Authorizing…" callback fires only after the configured delay
 *
 * Run: node test/sprites-ui.test.mjs
 */

import assert from 'node:assert/strict';

let storeBackend;
let runtimeQueue;
let identityResponder;
let lastError;

function freshChrome() {
  storeBackend = new Map();
  runtimeQueue = [];
  identityResponder = null;
  lastError = null;

  globalThis.chrome = {
    storage: {
      local: {
        async get(keyOrKeys) {
          const out = {};
          const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
          for (const k of keys) if (storeBackend.has(k)) out[k] = storeBackend.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) storeBackend.set(k, v);
        },
        async remove(keyOrKeys) {
          const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
          for (const k of keys) storeBackend.delete(k);
        },
      },
    },
    runtime: {
      get lastError() { return lastError; },
      sendMessage(msg, cb) {
        const next = runtimeQueue.shift();
        if (!next) {
          throw new Error('test runtime queue empty for ' + JSON.stringify(msg));
        }
        // Tests can assert what the popup sent.
        next.received = msg;
        // Allow tests to flip lastError per call.
        lastError = next.lastError ?? null;
        queueMicrotask(() => cb(next.response));
      },
    },
    identity: {
      launchWebAuthFlow(opts, cb) {
        if (!identityResponder) throw new Error('test identity responder unset');
        identityResponder.received = opts;
        lastError = identityResponder.lastError ?? null;
        queueMicrotask(() => cb(identityResponder.redirectUrl));
      },
    },
  };
}

function enqueueRuntime(response, extra = {}) {
  const slot = { response, ...extra };
  runtimeQueue.push(slot);
  return slot;
}

function setIdentity(redirectUrl, extra = {}) {
  identityResponder = { redirectUrl, ...extra };
  return identityResponder;
}

freshChrome();
const ui = await import('../src/lib/sprites-ui.js');
const {
  fetchAuthorizationUrl,
  runOAuthFlow,
  getSpritesUserId,
  clearSpritesUserId,
  withReauthGuard,
  __internals,
} = ui;

let passed = 0;
async function test(name, fn) {
  freshChrome();
  await fn();
  console.log('ok -', name);
  passed += 1;
}

await test('fetchAuthorizationUrl returns url+state from worker response', async () => {
  const slot = enqueueRuntime({
    ok: true,
    url: 'https://sprites.dev/oauth/authorize?state=abc123',
    state: 'abc123',
  });
  const out = await fetchAuthorizationUrl();
  assert.equal(slot.received.type, 'SPRITES_GET_AUTH_URL');
  assert.equal(out.url, 'https://sprites.dev/oauth/authorize?state=abc123');
  assert.equal(out.state, 'abc123');
});

await test('fetchAuthorizationUrl surfaces worker error.message cleanly', async () => {
  enqueueRuntime({ ok: false, error: 'sprites OAuth config missing' });
  await assert.rejects(fetchAuthorizationUrl(), /sprites OAuth config missing/);
});

await test('runOAuthFlow round-trips and persists only user_id', async () => {
  const authSlot = enqueueRuntime({
    ok: true,
    url: 'https://sprites.dev/oauth/authorize?state=abc',
    state: 'abc',
  });
  const idSlot = setIdentity(
    'https://abcdefg.chromiumapp.org/?code=AUTH_CODE&state=abc'
  );
  const cbSlot = enqueueRuntime({ ok: true, user_id: 'user-42' });

  const result = await runOAuthFlow();
  assert.equal(result.user_id, 'user-42');

  assert.equal(authSlot.received.type, 'SPRITES_GET_AUTH_URL');
  assert.equal(idSlot.received.url, 'https://sprites.dev/oauth/authorize?state=abc');
  assert.equal(idSlot.received.interactive, true);
  assert.equal(cbSlot.received.type, 'SPRITES_OAUTH_CALLBACK');
  assert.equal(
    cbSlot.received.url,
    'https://abcdefg.chromiumapp.org/?code=AUTH_CODE&state=abc'
  );

  // Critical: the popup persists ONLY user_id, never the auth code or token.
  assert.equal(await getSpritesUserId(), 'user-42');
  for (const [, v] of storeBackend.entries()) {
    const json = JSON.stringify(v);
    assert.ok(!/AUTH_CODE/.test(json), 'auth code leaked into storage');
    assert.ok(!/access_token/.test(json), 'access_token leaked into storage');
    assert.ok(!/refresh_token/.test(json), 'refresh_token leaked into storage');
  }
});

await test('runOAuthFlow propagates worker callback error and stores nothing', async () => {
  enqueueRuntime({ ok: true, url: 'https://sprites.dev/oauth/authorize?state=x', state: 'x' });
  setIdentity('https://abc.chromiumapp.org/?code=BAD&state=x');
  enqueueRuntime({ ok: false, error: 'state mismatch' });

  await assert.rejects(runOAuthFlow(), /state mismatch/);
  assert.equal(await getSpritesUserId(), null);
});

await test('runOAuthFlow surfaces user-cancelled launchWebAuthFlow as a clean error', async () => {
  enqueueRuntime({ ok: true, url: 'https://sprites.dev/oauth/authorize?state=y', state: 'y' });
  setIdentity(undefined); // chrome returns no redirectUrl on cancel
  await assert.rejects(runOAuthFlow(), /cancelled/);
  assert.equal(await getSpritesUserId(), null);
});

await test('runOAuthFlow fires onAuthorizing only when callback is slow', async () => {
  enqueueRuntime({ ok: true, url: 'https://sprites.dev/oauth/authorize?state=z', state: 'z' });
  setIdentity('https://abc.chromiumapp.org/?code=C&state=z');

  // Replace the runtime so the callback message resolves AFTER the
  // authorizing delay. The first sendMessage (auth URL) already drained
  // synchronously above; the next one is the callback.
  const slowSlot = { response: { ok: true, user_id: 'user-slow' } };
  runtimeQueue.push(slowSlot);

  const realSendMessage = chrome.runtime.sendMessage;
  let authorizingFired = 0;
  // Slow only the callback message; getAuthorizationUrl already used a fast slot.
  chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === 'SPRITES_OAUTH_CALLBACK') {
      const next = runtimeQueue.shift();
      next.received = msg;
      setTimeout(() => cb(next.response), 30);
    } else {
      realSendMessage(msg, cb);
    }
  };

  await runOAuthFlow({
    onAuthorizing: () => { authorizingFired += 1; },
    authorizingDelayMs: 5,
  });
  assert.equal(authorizingFired, 1, 'authorizing handler should fire when callback is slow');
});

await test('runOAuthFlow does NOT fire onAuthorizing for fast callbacks', async () => {
  enqueueRuntime({ ok: true, url: 'https://sprites.dev/oauth/authorize?state=q', state: 'q' });
  setIdentity('https://abc.chromiumapp.org/?code=C&state=q');
  enqueueRuntime({ ok: true, user_id: 'fast' });

  let authorizingFired = 0;
  await runOAuthFlow({
    onAuthorizing: () => { authorizingFired += 1; },
    authorizingDelayMs: 500,
  });
  assert.equal(authorizingFired, 0, 'fast callback should suppress authorizing UI');
});

await test('withReauthGuard converts {ok:false, reauth:true} into onReauth + thrown sentinel', async () => {
  await chrome.storage.local.set({ sprites_user_id: 'previous-user' });
  let reauthSeen = 0;
  const result = withReauthGuard(
    async () => ({ ok: false, reauth: true }),
    { onReauth: () => { reauthSeen += 1; } }
  );
  await assert.rejects(result, (err) => err.reauth === true);
  assert.equal(reauthSeen, 1);
  assert.equal(await getSpritesUserId(), null, 'reauth should clear popup user_id');
});

await test('withReauthGuard passes non-reauth responses through untouched', async () => {
  let reauthSeen = 0;
  const out = await withReauthGuard(
    async () => ({ ok: true, data: [1, 2, 3] }),
    { onReauth: () => { reauthSeen += 1; } }
  );
  assert.deepEqual(out, { ok: true, data: [1, 2, 3] });
  assert.equal(reauthSeen, 0);
});

await test('withReauthGuard re-throws non-reauth errors unchanged', async () => {
  await assert.rejects(
    withReauthGuard(async () => { throw new Error('network down'); }),
    /network down/
  );
});

await test('clearSpritesUserId removes only the popup-side identifier', async () => {
  await chrome.storage.local.set({
    sprites_user_id: 'u1',
    'sprites:config': { authorizeUrl: 'x' },
    'user_sessions/u1': { encrypted: 'BLOB' },
  });
  await clearSpritesUserId();
  assert.equal(await getSpritesUserId(), null);
  const cfg = await chrome.storage.local.get('sprites:config');
  const sess = await chrome.storage.local.get('user_sessions/u1');
  assert.ok(cfg['sprites:config'], 'config must survive sign-out');
  assert.ok(sess['user_sessions/u1'], 'encrypted session must survive sign-out');
});

console.log(`\n${passed} sprites-ui tests passed`);
