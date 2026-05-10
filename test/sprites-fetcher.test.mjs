/**
 * Node-runnable tests for src/lib/sprites-fetcher.js (Lane 3).
 *
 * Mocks chrome.storage.local with an in-memory Map, supplies Node webcrypto
 * for SubtleCrypto, stubs fetch + sleep + alarms + runtime so we can assert
 * the polling pipeline end-to-end without a browser. Each test starts from
 * a clean store + fresh module imports.
 *
 * Run: node test/sprites-fetcher.test.mjs
 */

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// --- mock chrome.storage.local + alarms + runtime --------------------------
const store = new Map();

function makeFakeChrome({ alarmCalls, alarmListeners, runtimeListeners } = {}) {
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
    alarms: alarmCalls && alarmListeners ? {
      create: (name, opts) => alarmCalls.push({ name, opts }),
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    } : undefined,
    runtime: runtimeListeners ? {
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    } : undefined,
  };
}
globalThis.chrome = makeFakeChrome();

if (!globalThis.crypto) globalThis.crypto = webcrypto;
else if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');
}

const fetcher = await import('../src/lib/sprites-fetcher.js');
const storeMod = await import('../src/lib/sprites-store.js');
const auth = await import('../src/lib/sprites-auth.js');
const {
  fetchAssignments,
  normalizeAssignments,
  defaultMapAssignment,
  extractAssignmentList,
  hashNormalized,
  refreshUserAssignments,
  pollAllUsers,
  installPollingAlarm,
  attachAssignmentHandlers,
  setSpritesApiConfig,
  __internals,
} = fetcher;
const { rawAssignmentsCache, userSessions } = storeMod;
const { setConfig: setAuthConfig, ReauthRequiredError } = auth;

const SPRITES_API = { assignmentsUrl: 'https://api.sprites.dev/v1/assignments' };
const AUTH_CONFIG = {
  authorizeUrl: 'https://sprites.dev/oauth/authorize',
  tokenUrl: 'https://sprites.dev/oauth/token',
  clientId: 'schoolsync-extension',
  redirectUri: 'https://example.test/callback',
  scopes: ['assignments:read'],
};

async function reset() {
  store.clear();
  await storeMod.migrate();
  await setSpritesApiConfig(SPRITES_API);
  await setAuthConfig(AUTH_CONFIG);
}

async function seedSession(user_id, { expires_at = Date.now() + 3_600_000 } = {}) {
  await userSessions.upsert({
    user_id,
    access_token: 'token-' + user_id,
    refresh_token: 'refresh-' + user_id,
    expires_at,
  });
}

function makeFetchStub(responses) {
  // responses: array of either { status, body, headers } or () => Response/Promise
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (next === undefined) throw new Error('fetch stub exhausted');
      const r = typeof next === 'function' ? await next(url, init) : next;
      const headers = new Map(Object.entries(r.headers || {}));
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        headers: { get: (k) => headers.get(k) ?? headers.get(k.toLowerCase()) ?? null },
        async json() { return r.body; },
        async text() { return typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? ''); },
      };
    },
  };
}

const sleeps = [];
const fastSleep = async (ms) => { sleeps.push(ms); };

let passed = 0;
async function test(name, fn) {
  await reset();
  sleeps.length = 0;
  try {
    await fn();
    console.log('  ok   ' + name);
    passed++;
  } catch (err) {
    console.log('  FAIL ' + name);
    throw err;
  }
}

// --- normalize / map -------------------------------------------------------

await test('extractAssignmentList pulls out arrays from common envelopes', async () => {
  assert.deepEqual(extractAssignmentList([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(extractAssignmentList({ assignments: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(extractAssignmentList({ data: [{ id: 3 }] }), [{ id: 3 }]);
  assert.deepEqual(extractAssignmentList({ items: [{ id: 4 }] }), [{ id: 4 }]);
  assert.throws(() => extractAssignmentList({ wat: 'no list' }));
});

await test('defaultMapAssignment normalizes common field-name variants to ISO8601', () => {
  const a = defaultMapAssignment({
    id: 'a1', title: 'Essay 1', subject: 'English', dueDate: '2026-06-01T15:00:00Z',
  });
  assert.equal(a.id, 'a1');
  assert.equal(a.title, 'Essay 1');
  assert.equal(a.subject, 'English');
  assert.equal(a.dueDate, '2026-06-01T15:00:00.000Z');

  const b = defaultMapAssignment({
    uuid: 'b2', name: 'Lab Report', course: 'Bio', due_date: '2026-06-02',
  });
  assert.equal(b.id, 'b2');
  assert.equal(b.title, 'Lab Report');
  assert.equal(b.subject, 'Bio');
  assert.equal(b.dueDate, '2026-06-02T00:00:00.000Z');

  // Missing required field => dropped (returns null)
  assert.equal(defaultMapAssignment({ id: 'c', title: 'No Date' }), null);
  assert.equal(defaultMapAssignment({ id: 'c', dueDate: '2026-01-01' }), null);

  // Subject defaults to "Unknown" when absent.
  const d = defaultMapAssignment({ id: 'd', title: 'X', dueDate: '2026-01-01' });
  assert.equal(d.subject, 'Unknown');
});

await test('normalizeAssignments returns sorted, mapped, drops invalid', () => {
  const out = normalizeAssignments({
    assignments: [
      { id: 'b', title: 'B', subject: 'Math', dueDate: '2026-01-02' },
      { id: 'a', title: 'A', subject: 'Math', dueDate: '2026-01-01' },
      { title: 'orphan', dueDate: '2026-01-03' }, // no id => dropped
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].id, 'b');
});

await test('hashNormalized is deterministic and changes on data change', async () => {
  const x = [{ id: 'a', title: 'A', subject: 'M', dueDate: '2026-01-01T00:00:00.000Z' }];
  const y = [{ id: 'a', title: 'A', subject: 'M', dueDate: '2026-01-01T00:00:00.000Z' }];
  const z = [{ id: 'a', title: 'B', subject: 'M', dueDate: '2026-01-01T00:00:00.000Z' }];
  const hx = await hashNormalized(x);
  const hy = await hashNormalized(y);
  const hz = await hashNormalized(z);
  assert.equal(hx, hy);
  assert.notEqual(hx, hz);
  assert.match(hx, /^[0-9a-f]{64}$/);
});

// --- fetchAssignments retry behaviour --------------------------------------

await test('fetchAssignments returns body on first 200', async () => {
  const stub = makeFetchStub([{ status: 200, body: { assignments: [] } }]);
  const out = await fetchAssignments('tok', { fetchImpl: stub.impl, sleep: fastSleep, apiConfig: SPRITES_API });
  assert.deepEqual(out, { assignments: [] });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(sleeps.length, 0);
});

await test('fetchAssignments retries on 429 and succeeds within max retries', async () => {
  const stub = makeFetchStub([
    { status: 429, body: '', headers: { 'Retry-After': '1' } },
    { status: 429, body: '' },
    { status: 200, body: { assignments: [{ id: 'a', title: 'T', subject: 'S', dueDate: '2026-01-01' }] } },
  ]);
  const out = await fetchAssignments('tok', { fetchImpl: stub.impl, sleep: fastSleep, apiConfig: SPRITES_API });
  assert.equal(stub.calls.length, 3);
  assert.equal(sleeps.length, 2);
  // Retry-After honoured on attempt 1 -> 1000ms
  assert.equal(sleeps[0], 1000);
  // All sleeps capped at 32s
  for (const s of sleeps) assert.ok(s <= __internals.CAP_DELAY_MS);
  assert.ok(out.assignments[0].id === 'a');
});

await test('fetchAssignments retries on 5xx', async () => {
  const stub = makeFetchStub([
    { status: 500, body: 'oops' },
    { status: 503, body: 'oops' },
    { status: 200, body: [] },
  ]);
  const out = await fetchAssignments('tok', { fetchImpl: stub.impl, sleep: fastSleep, apiConfig: SPRITES_API });
  assert.deepEqual(out, []);
  assert.equal(stub.calls.length, 3);
});

await test('fetchAssignments throws after exhausting retries on persistent 5xx', async () => {
  const stub = makeFetchStub([
    { status: 500, body: '' },
    { status: 500, body: '' },
    { status: 500, body: '' },
    { status: 500, body: '' },
  ]);
  await assert.rejects(
    fetchAssignments('tok', { fetchImpl: stub.impl, sleep: fastSleep, apiConfig: SPRITES_API }),
    /HTTP 500/,
  );
  assert.equal(stub.calls.length, __internals.MAX_ATTEMPTS); // 1 + 3 retries
});

await test('fetchAssignments does NOT retry on 400 (non-retryable)', async () => {
  const stub = makeFetchStub([{ status: 400, body: 'bad request' }]);
  await assert.rejects(
    fetchAssignments('tok', { fetchImpl: stub.impl, sleep: fastSleep, apiConfig: SPRITES_API }),
    /HTTP 400/,
  );
  assert.equal(stub.calls.length, 1);
});

await test('fetchAssignments converts 401 to ReauthRequiredError (no retry)', async () => {
  const stub = makeFetchStub([{ status: 401, body: '' }]);
  await assert.rejects(
    fetchAssignments('tok', { fetchImpl: stub.impl, sleep: fastSleep, apiConfig: SPRITES_API }),
    (err) => err instanceof ReauthRequiredError,
  );
  assert.equal(stub.calls.length, 1);
});

await test('fetchAssignments backoff capped at 32s', () => {
  // Synthetically check the math without doing real sleeps.
  for (const attempt of [1, 2, 3, 4, 5, 10]) {
    const ms = __internals.computeBackoffMs(attempt);
    assert.ok(ms <= __internals.CAP_DELAY_MS, `attempt=${attempt} ms=${ms}`);
  }
  assert.equal(__internals.computeBackoffMs(1, 90), 32_000); // Retry-After capped
});

// --- refreshUserAssignments end-to-end -------------------------------------

await test('refreshUserAssignments writes new cache row when first run', async () => {
  await seedSession('u1');
  const stub = makeFetchStub([
    { status: 200, body: { assignments: [
      { id: 'a1', title: 'Essay', subject: 'Eng', due_date: '2026-06-01' },
    ]}},
  ]);
  const r = await refreshUserAssignments('u1', { fetchImpl: stub.impl, sleep: fastSleep });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(r.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  const row = await rawAssignmentsCache.get('u1');
  assert.ok(row);
  assert.equal(row.data_hash, r.hash);
  assert.equal(row.raw_json.normalized.length, 1);
  assert.equal(row.raw_json.normalized[0].id, 'a1');
});

await test('refreshUserAssignments skips write when hash unchanged', async () => {
  await seedSession('u1');
  const payload = { assignments: [
    { id: 'a1', title: 'Essay', subject: 'Eng', due_date: '2026-06-01' },
  ]};
  const stub1 = makeFetchStub([{ status: 200, body: payload }]);
  const r1 = await refreshUserAssignments('u1', { fetchImpl: stub1.impl, sleep: fastSleep, now: 1_000 });
  assert.equal(r1.changed, true);
  const stub2 = makeFetchStub([{ status: 200, body: payload }]);
  const r2 = await refreshUserAssignments('u1', { fetchImpl: stub2.impl, sleep: fastSleep, now: 2_000 });
  assert.equal(r2.changed, false);
  assert.equal(r2.hash, r1.hash);
  // fetchedAt remained the original timestamp, not bumped.
  const row = await rawAssignmentsCache.get('u1');
  assert.equal(row.fetched_at, 1_000);
  assert.equal(r2.fetchedAt, new Date(1_000).toISOString());
});

await test('refreshUserAssignments writes new row when hash changes', async () => {
  await seedSession('u1');
  const stub1 = makeFetchStub([{ status: 200, body: { assignments: [
    { id: 'a1', title: 'Essay', subject: 'Eng', due_date: '2026-06-01' },
  ]}}]);
  await refreshUserAssignments('u1', { fetchImpl: stub1.impl, sleep: fastSleep, now: 1_000 });
  const stub2 = makeFetchStub([{ status: 200, body: { assignments: [
    { id: 'a1', title: 'Essay v2', subject: 'Eng', due_date: '2026-06-01' },
  ]}}]);
  const r2 = await refreshUserAssignments('u1', { fetchImpl: stub2.impl, sleep: fastSleep, now: 2_000 });
  assert.equal(r2.changed, true);
  const row = await rawAssignmentsCache.get('u1');
  assert.equal(row.fetched_at, 2_000);
  assert.equal(row.raw_json.normalized[0].title, 'Essay v2');
});

await test('refreshUserAssignments returns reauth on missing session (Lane 2 contract)', async () => {
  // No session seeded.
  const stub = makeFetchStub([]); // should never be called
  const r = await refreshUserAssignments('ghost', { fetchImpl: stub.impl, sleep: fastSleep });
  assert.equal(r.ok, false);
  assert.equal(r.reauth, true);
  assert.equal(stub.calls.length, 0);
});

await test('refreshUserAssignments returns reauth on 401 from sprites', async () => {
  await seedSession('u1');
  const stub = makeFetchStub([{ status: 401, body: '' }]);
  const r = await refreshUserAssignments('u1', { fetchImpl: stub.impl, sleep: fastSleep });
  assert.equal(r.ok, false);
  assert.equal(r.reauth, true);
});

// --- pollAllUsers iteration ------------------------------------------------

await test('pollAllUsers iterates every signed-in user, isolates failures', async () => {
  await seedSession('u1');
  await seedSession('u2');
  await seedSession('u3');
  // u1 succeeds, u2 401 -> reauth, u3 throws network error
  const fetches = {
    'u1': { status: 200, body: { assignments: [
      { id: 'a', title: 'T', subject: 'S', dueDate: '2026-06-01' },
    ]}},
    'u2': { status: 401, body: '' },
  };
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    const auth = init.headers.Authorization;
    const u = auth.replace('Bearer token-', '');
    if (u === 'u3') throw new Error('boom');
    const r = fetches[u];
    return {
      status: r.status, ok: r.status === 200,
      headers: { get: () => null },
      async json() { return r.body; },
      async text() { return JSON.stringify(r.body); },
    };
  };
  const log = { entries: [], info(...a){ this.entries.push(['info', a]); }, warn(...a){ this.entries.push(['warn', a]); }, error(...a){ this.entries.push(['error', a]); } };
  const result = await pollAllUsers({ fetchImpl, sleep: fastSleep, log });
  assert.equal(result.results.length, 3);
  const byUser = Object.fromEntries(result.results.map((r) => [r.user_id, r]));
  assert.equal(byUser.u1.ok, true);
  assert.equal(byUser.u1.changed, true);
  assert.equal(byUser.u2.ok, false);
  assert.equal(byUser.u2.reauth, true);
  assert.equal(byUser.u3.ok, false);
  assert.equal(byUser.u3.reauth, undefined);
  assert.match(byUser.u3.error, /boom/);
  // Tick logged
  assert.ok(log.entries.some(([lvl, a]) => lvl === 'info' && String(a[0]).startsWith('[sprites-poll] tick ')));
});

// --- installPollingAlarm wiring --------------------------------------------

await test('installPollingAlarm registers 15-minute alarm and onAlarm listener', async () => {
  const alarmCalls = [];
  const alarmListeners = [];
  const fakeChrome = makeFakeChrome({ alarmCalls, alarmListeners });
  installPollingAlarm(fakeChrome);
  assert.equal(alarmCalls.length, 1);
  assert.equal(alarmCalls[0].name, 'sprites-poll');
  assert.equal(alarmCalls[0].opts.periodInMinutes, 15);
  assert.equal(alarmListeners.length, 1);
  // Listener ignores non-matching alarm names without crashing.
  alarmListeners[0]({ name: 'someone-elses-alarm' });
});

// --- attachAssignmentHandlers wiring ---------------------------------------

await test('attachAssignmentHandlers wires SPRITES_REFRESH_NOW + SPRITES_GET_RAW_ASSIGNMENTS', async () => {
  await seedSession('u1');
  // Pre-populate a cache row
  await rawAssignmentsCache.upsert({
    user_id: 'u1',
    data_hash: 'deadbeef',
    raw_json: { normalized: [] },
    fetched_at: 1_700_000_000_000,
  });
  const runtimeListeners = [];
  const fakeChrome = makeFakeChrome({ runtimeListeners });
  attachAssignmentHandlers(fakeChrome.runtime);
  assert.equal(runtimeListeners.length, 1);
  const listener = runtimeListeners[0];

  // GET_RAW returns cached row
  const rawResp = await new Promise((resolve) => {
    listener({ type: 'SPRITES_GET_RAW_ASSIGNMENTS', user_id: 'u1' }, {}, resolve);
  });
  assert.equal(rawResp.ok, true);
  assert.equal(rawResp.row.data_hash, 'deadbeef');

  // GET_RAW returns null for unknown user
  const missResp = await new Promise((resolve) => {
    listener({ type: 'SPRITES_GET_RAW_ASSIGNMENTS', user_id: 'ghost' }, {}, resolve);
  });
  assert.equal(missResp.ok, true);
  assert.equal(missResp.row, null);

  // Unrelated message returns undefined (ignored)
  const ignored = listener({ type: 'NOT_OURS' }, {}, () => {});
  assert.equal(ignored, undefined);
});

console.log(`\n${passed} passed`);
