/**
 * Node-runnable test for src/lib/sprites-store.js.
 *
 * Schoolsync ships as a Chrome MV3 extension and has no test runner in repo,
 * so we mock chrome.storage.local with an in-memory Map and exercise the
 * store using Node's webcrypto (compatible with the SubtleCrypto API the
 * extension uses at runtime).
 *
 * Run: node test/sprites-store.test.mjs
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
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
} else if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
// btoa/atob are global in Node 20+ — guard for older Node just in case.
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');
}

const mod = await import('../src/lib/sprites-store.js');
const {
  migrate,
  rollback,
  getSchemaVersion,
  encryptColumn,
  decryptColumn,
  userSessions,
  rawAssignmentsCache,
  processedAssignmentsCache,
} = mod;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  — ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL — ${name}\n${e.stack || e}`);
    process.exitCode = 1;
  }
}

// --- migration -------------------------------------------------------------

await test('migrate from scratch stamps schema version 1', async () => {
  store.clear();
  assert.equal(await getSchemaVersion(), 0);
  const v = await migrate();
  assert.equal(v, 1);
  assert.equal(await getSchemaVersion(), 1);
});

await test('migrate is idempotent', async () => {
  await migrate();
  await migrate();
  assert.equal(await getSchemaVersion(), 1);
});

await test('rollback restores prior (empty) state', async () => {
  await userSessions.upsert({
    user_id: 'rb-user',
    access_token: 'tok',
    expires_at: Date.now() + 60_000,
  });
  await rollback();
  assert.equal(await getSchemaVersion(), 0);
  assert.equal(await userSessions.get('rb-user'), null);
  // Index keys must also be gone so a fresh migrate starts clean.
  const all = await userSessions.all();
  assert.deepEqual(all, []);
});

// --- encryption round-trip -------------------------------------------------

await test('encryptColumn / decryptColumn round-trips a string', async () => {
  await migrate();
  const ct = await encryptColumn('hello sprites');
  assert.ok(ct && ct.iv && ct.ct, 'ciphertext envelope present');
  assert.notEqual(ct.ct, 'hello sprites');
  assert.equal(await decryptColumn(ct), 'hello sprites');
});

await test('encryptColumn passes null through (nullable refresh_token)', async () => {
  assert.equal(await encryptColumn(null), null);
  assert.equal(await decryptColumn(null), null);
});

await test('encryptColumn produces fresh IV per call', async () => {
  const a = await encryptColumn('same');
  const b = await encryptColumn('same');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

// --- userSessions ---------------------------------------------------------

await test('userSessions.upsert + get round-trips encrypted tokens', async () => {
  await rollback();
  await migrate();
  const exp = Date.now() + 3_600_000;
  await userSessions.upsert({
    user_id: 'u1',
    access_token: 'access-abc',
    refresh_token: 'refresh-xyz',
    expires_at: exp,
  });
  const row = await userSessions.get('u1');
  assert.equal(row.user_id, 'u1');
  assert.equal(row.access_token, 'access-abc');
  assert.equal(row.refresh_token, 'refresh-xyz');
  assert.equal(row.expires_at, exp);
  assert.ok(row.created_at > 0);
  assert.ok(row.updated_at >= row.created_at);
});

await test('userSessions raw on-disk row stores ciphertext, not plaintext', async () => {
  const raw = store.get('sprites:row:user_sessions:u1');
  assert.ok(raw);
  assert.notEqual(raw.access_token, 'access-abc');
  assert.ok(raw.access_token.iv && raw.access_token.ct);
  assert.notEqual(raw.refresh_token, 'refresh-xyz');
});

await test('userSessions accepts nullable refresh_token', async () => {
  await userSessions.upsert({
    user_id: 'u2',
    access_token: 'a',
    refresh_token: null,
    expires_at: Date.now(),
  });
  const row = await userSessions.get('u2');
  assert.equal(row.refresh_token, null);
});

await test('userSessions.upsert preserves created_at on update', async () => {
  const before = await userSessions.get('u1');
  await new Promise((r) => setTimeout(r, 5));
  await userSessions.upsert({
    user_id: 'u1',
    access_token: 'access-rotated',
    refresh_token: 'refresh-xyz',
    expires_at: before.expires_at,
  });
  const after = await userSessions.get('u1');
  assert.equal(after.created_at, before.created_at);
  assert.ok(after.updated_at > before.updated_at);
  assert.equal(after.access_token, 'access-rotated');
});

await test('userSessions.delete removes row and de-indexes', async () => {
  await userSessions.delete('u2');
  assert.equal(await userSessions.get('u2'), null);
  const all = await userSessions.all();
  assert.ok(!all.some((r) => r.user_id === 'u2'));
});

await test('userSessions.upsert rejects missing user_id', async () => {
  await assert.rejects(() =>
    userSessions.upsert({ access_token: 'x', expires_at: 1 })
  );
});

await test('userSessions.upsert rejects missing required column', async () => {
  await assert.rejects(() => userSessions.upsert({ user_id: 'u3' }));
});

// --- rawAssignmentsCache --------------------------------------------------

await test('rawAssignmentsCache stores and reads jsonb payload', async () => {
  const payload = { items: [{ id: 1, title: 'Algebra HW' }] };
  await rawAssignmentsCache.upsert({
    user_id: 'u1',
    data_hash: 'sha256:abc',
    raw_json: payload,
    fetched_at: 1700000000000,
  });
  const row = await rawAssignmentsCache.get('u1');
  assert.deepEqual(row.raw_json, payload);
  assert.equal(row.data_hash, 'sha256:abc');
  assert.equal(row.fetched_at, 1700000000000);
});

// --- processedAssignmentsCache --------------------------------------------

await test('processedAssignmentsCache stores LLM output keyed by source_hash', async () => {
  const processed = { bySubject: { math: [{ id: 1 }] }, overdue: [] };
  await processedAssignmentsCache.upsert({
    user_id: 'u1',
    processed_json: processed,
    source_hash: 'sha256:abc',
    processed_at: 1700000001000,
  });
  const row = await processedAssignmentsCache.get('u1');
  assert.deepEqual(row.processed_json, processed);
  assert.equal(row.source_hash, 'sha256:abc');
});

await test('processedAssignmentsCache.all returns every row', async () => {
  await processedAssignmentsCache.upsert({
    user_id: 'u9',
    processed_json: {},
    source_hash: 'h',
    processed_at: 1,
  });
  const rows = await processedAssignmentsCache.all();
  const ids = rows.map((r) => r.user_id).sort();
  assert.deepEqual(ids, ['u1', 'u9']);
});

console.log(`\n${passed} test(s) passed`);
