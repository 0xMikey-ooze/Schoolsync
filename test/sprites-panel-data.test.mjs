/**
 * Node-runnable tests for src/lib/sprites-panel-data.js (Lane 4 UI data adapter).
 *
 * Mocks chrome.storage.local with an in-memory Map and Node webcrypto so the
 * sprites-store encryption layer round-trips. Each test starts from a clean
 * store and a fresh module graph.
 *
 * Run: node test/sprites-panel-data.test.mjs
 */

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const store = new Map();

function makeFakeChrome({ runtimeListeners } = {}) {
  return {
    storage: {
      local: {
        async get(keyOrKeys) {
          const out = {};
          if (keyOrKeys == null) {
            for (const [k, v] of store.entries()) out[k] = v;
            return out;
          }
          const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
        async remove(keyOrKeys) {
          const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
          for (const k of keys) store.delete(k);
        },
      },
    },
    runtime: runtimeListeners ? {
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    } : undefined,
  };
}

// Canonical (non-stamped) imports so the panel-data module's static import of
// sprites-store points at the same instance the test's setup code mutates.
// _cachedKey lives in module scope, so we must call resetEncryptionKey()
// between tests to keep the JWK in chrome.storage and the cached CryptoKey
// in lockstep — otherwise test N-1 leaks a key the test N store no longer has.
const storeModP = import('../src/lib/sprites-store.js');
const panelModP = import('../src/lib/sprites-panel-data.js');

async function freshImports({ runtimeListeners } = {}) {
  store.clear();
  globalThis.chrome = makeFakeChrome({ runtimeListeners });
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const storeMod = await storeModP;
  const panelMod = await panelModP;
  await storeMod.resetEncryptionKey();
  await storeMod.migrate();
  return { storeMod, panelMod };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const NOW = Date.parse('2026-05-09T12:00:00.000Z');

test('getPanelData returns unauthenticated when userId is null', async () => {
  const { panelMod } = await freshImports();
  const data = await panelMod.getPanelData({ userId: null, now: NOW });
  assert.equal(data.status, 'unauthenticated');
  assert.equal(data.userId, null);
  assert.equal(data.lastSyncedAt, null);
  assert.deepEqual(data.categorized, []);
  assert.deepEqual(data.overdue, []);
});

test('getPanelData returns empty when user has no cache rows', async () => {
  const { storeMod, panelMod } = await freshImports();
  await storeMod.userSessions.upsert({
    user_id: 'u1', access_token: 'tok', expires_at: NOW + 60_000,
  });
  const data = await panelMod.getPanelData({ userId: 'u1', now: NOW });
  assert.equal(data.status, 'empty');
  assert.equal(data.userId, 'u1');
  assert.equal(data.lastSyncedAt, null);
  assert.match(data.deadlineSummary, /No assignments synced yet/);
});

test('getPanelData renders processed_json verbatim when present', async () => {
  const { storeMod, panelMod } = await freshImports();
  const processed = {
    categorized: [
      { subject: 'Math', items: [
        { id: 'a1', title: 'Algebra HW', subject: 'Math', dueDate: '2026-05-12T00:00:00.000Z' },
      ]},
      { subject: 'English', items: [
        { id: 'a2', title: 'Essay', subject: 'English', dueDate: '2026-05-15T00:00:00.000Z' },
      ]},
    ],
    overdue: [
      { id: 'a0', title: 'Late Lab', subject: 'Science', dueDate: '2026-05-01T00:00:00.000Z' },
    ],
    deadlineSummary: '1 overdue, 2 due this week.',
  };
  await storeMod.processedAssignmentsCache.upsert({
    user_id: 'u1',
    processed_json: processed,
    source_hash: 'abc',
    processed_at: NOW - 90_000,
  });
  const data = await panelMod.getPanelData({ userId: 'u1', now: NOW });
  assert.equal(data.status, 'ok');
  assert.equal(data.lastSyncedSource, 'processed');
  assert.equal(data.deadlineSummary, '1 overdue, 2 due this week.');
  assert.equal(data.categorized.length, 2);
  assert.equal(data.overdue.length, 1);
});

test('getPanelData falls back to normalized[] when processed row is missing', async () => {
  const { storeMod, panelMod } = await freshImports();
  await storeMod.rawAssignmentsCache.upsert({
    user_id: 'u1',
    data_hash: 'h',
    raw_json: {
      raw: {},
      normalized: [
        { id: '1', title: 'Past Quiz', subject: 'Math', dueDate: '2026-05-01T00:00:00.000Z' },
        { id: '2', title: 'Future Test', subject: 'Math', dueDate: '2026-05-15T00:00:00.000Z' },
        { id: '3', title: 'Essay Draft', subject: 'English', dueDate: '2026-05-12T00:00:00.000Z' },
      ],
    },
    fetched_at: NOW - 5 * 60_000,
  });
  const data = await panelMod.getPanelData({ userId: 'u1', now: NOW });
  assert.equal(data.status, 'ok');
  assert.equal(data.lastSyncedSource, 'raw');
  assert.equal(data.overdue.length, 1);
  assert.equal(data.overdue[0].id, '1');
  // Two subjects with upcoming items, in first-seen order.
  assert.deepEqual(data.categorized.map((c) => c.subject), ['Math', 'English']);
  assert.equal(data.categorized[0].items.length, 1); // Future Test only; Past Quiz is overdue
  assert.equal(data.categorized[1].items.length, 1);
  assert.match(data.deadlineSummary, /1 overdue/);
});

test('getPanelData falls back to raw when processed_json is malformed', async () => {
  const { storeMod, panelMod } = await freshImports();
  await storeMod.processedAssignmentsCache.upsert({
    user_id: 'u1',
    processed_json: { categorized: 'not-an-array' },
    source_hash: 'x',
    processed_at: NOW - 10_000,
  });
  await storeMod.rawAssignmentsCache.upsert({
    user_id: 'u1',
    data_hash: 'h',
    raw_json: {
      normalized: [
        { id: '1', title: 'OK', subject: 'Math', dueDate: '2026-05-15T00:00:00.000Z' },
      ],
    },
    fetched_at: NOW - 30_000,
  });
  const data = await panelMod.getPanelData({ userId: 'u1', now: NOW });
  assert.equal(data.status, 'ok');
  assert.equal(data.lastSyncedSource, 'raw');
  assert.equal(data.categorized[0].items[0].id, '1');
});

test('formatLastSynced renders just-now / minutes / hours / days', async () => {
  const { panelMod } = await freshImports();
  const iso = new Date(NOW).toISOString();
  assert.equal(panelMod.formatLastSynced(iso, NOW), 'Last synced: just now');
  assert.equal(panelMod.formatLastSynced(iso, NOW + 5 * 60_000), 'Last synced: 5 min ago');
  assert.equal(panelMod.formatLastSynced(iso, NOW + 3 * 3600_000), 'Last synced: 3 hr ago');
  assert.equal(panelMod.formatLastSynced(iso, NOW + 2 * 86_400_000), 'Last synced: 2 days ago');
  assert.equal(panelMod.formatLastSynced(iso, NOW + 86_400_000), 'Last synced: 1 day ago');
  assert.equal(panelMod.formatLastSynced(null, NOW), 'Never synced');
});

test('resolveActiveUserId returns first session or null', async () => {
  const { storeMod, panelMod } = await freshImports();
  assert.equal(await panelMod.resolveActiveUserId(), null);
  await storeMod.userSessions.upsert({
    user_id: 'first', access_token: 't', expires_at: NOW + 1000,
  });
  assert.equal(await panelMod.resolveActiveUserId(), 'first');
});

test('attachPanelHandlers responds to SPRITES_GET_PANEL_DATA', async () => {
  const runtimeListeners = [];
  const { storeMod, panelMod } = await freshImports({ runtimeListeners });
  await storeMod.userSessions.upsert({
    user_id: 'u9', access_token: 't', expires_at: NOW + 1000,
  });
  panelMod.attachPanelHandlers(globalThis.chrome.runtime);
  assert.equal(runtimeListeners.length, 1);
  const handler = runtimeListeners[0];

  const reply = await new Promise((resolve) => {
    const ret = handler({ type: 'SPRITES_GET_PANEL_DATA' }, null, resolve);
    assert.equal(ret, true, 'handler must return true to keep sendResponse alive');
  });
  assert.equal(reply.ok, true, `handler error: ${reply.error}`);
  assert.equal(reply.data.status, 'empty');
  assert.equal(reply.data.userId, 'u9');
});

test('attachPanelHandlers ignores unrelated messages', async () => {
  const runtimeListeners = [];
  const { panelMod } = await freshImports({ runtimeListeners });
  panelMod.attachPanelHandlers(globalThis.chrome.runtime);
  const ret = runtimeListeners[0]({ type: 'SOMETHING_ELSE' }, null, () => {});
  assert.equal(ret, undefined);
});

test('groupBySubject preserves first-seen subject order', async () => {
  const { panelMod } = await freshImports();
  const grouped = panelMod.__internals.groupBySubject([
    { id: '1', title: 't', subject: 'Z', dueDate: 'd' },
    { id: '2', title: 't', subject: 'A', dueDate: 'd' },
    { id: '3', title: 't', subject: 'Z', dueDate: 'd' },
  ]);
  assert.deepEqual(grouped.map((g) => g.subject), ['Z', 'A']);
  assert.equal(grouped[0].items.length, 2);
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ok  ', t.name);
      pass++;
    } catch (err) {
      console.error('  FAIL', t.name);
      console.error(err.stack || err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
