// Node-runnable smoke test for schoolsync-poll ring-buffer + on-demand vs periodic
// behavior. Stubs the chrome.* APIs in-memory. Run with: node src/lib/schoolsync-poll.test.mjs
import assert from 'node:assert/strict';

const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return store.has(key) ? { [key]: store.get(key) } : {};
        return {};
      },
      async set(obj) { for (const k of Object.keys(obj)) store.set(k, obj[k]); },
      async remove(key) { store.delete(key); },
    },
  },
  alarms: {
    _alarms: new Map(),
    async clear(name) { this._alarms.delete(name); return true; },
    create(name, opts) { this._alarms.set(name, opts); },
  },
};

const mod = await import('./schoolsync-poll.js');
const {
  SCHOOLSYNC_POLL_ALARM, SNAPSHOT_KEY, MAX_SNAPSHOTS, POLL_INTERVAL_MINUTES,
  configureSchoolsyncPoll, snapshotNow, listSnapshots, clearSnapshots,
} = mod;

// 1. configure registers the alarm with the right interval
await configureSchoolsyncPoll();
assert.equal(chrome.alarms._alarms.get(SCHOOLSYNC_POLL_ALARM).periodInMinutes, POLL_INTERVAL_MINUTES);

// 2. on-demand snapshot with no fetcher records status=no_fetcher
await clearSnapshots();
const s1 = await snapshotNow({ source: 'on-demand', detectedPages: { 1: { url: 'a' } } });
assert.equal(s1.status, 'no_fetcher');
assert.equal(s1.source, 'on-demand');
assert.deepEqual(s1.detectedPages, { 1: { url: 'a' } });

// 3. injected fetcher path
const s2 = await snapshotNow({
  source: 'periodic',
  fetchPayload: async () => ({ items: [1, 2, 3] }),
});
assert.equal(s2.status, 'ok');
assert.deepEqual(s2.payload, { items: [1, 2, 3] });

// 4. fetcher that throws → status=fetch_error, error captured, snapshot still recorded
const s3 = await snapshotNow({
  source: 'periodic',
  fetchPayload: async () => { throw new Error('boom'); },
});
assert.equal(s3.status, 'fetch_error');
assert.equal(s3.error, 'boom');

// 5. ring buffer caps at MAX_SNAPSHOTS, newest first
await clearSnapshots();
for (let i = 0; i < MAX_SNAPSHOTS + 5; i++) {
  await snapshotNow({ source: 'periodic' });
}
const all = await listSnapshots();
assert.equal(all.length, MAX_SNAPSHOTS);
// newest first → ts descending (or equal)
for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].ts >= all[i].ts);

// 6. invalid source rejected
await assert.rejects(() => snapshotNow({ source: 'wat' }), /invalid source/);

console.log(`PASS — all ${6} schoolsync-poll smoke checks green; buffer=${all.length}/${MAX_SNAPSHOTS}`);
