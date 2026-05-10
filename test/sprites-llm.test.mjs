/**
 * Node-runnable tests for src/lib/sprites-llm.js (Lane 4).
 *
 * Mocks chrome.storage.local with an in-memory Map, supplies Node webcrypto
 * for SubtleCrypto, and stubs the Anthropic call via the `llmClient` opt
 * (and via fetchImpl for the one test that exercises callAnthropic directly).
 *
 * Each test calls `resetStore()` so the in-memory chrome storage is fresh
 * and the migrate() guard inside the table helpers re-runs cleanly.
 *
 * Run: node test/sprites-llm.test.mjs
 */

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const store = new Map();
const runtimeListeners = [];

function makeFakeChrome() {
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
    runtime: {
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    },
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

const llm = await import('../src/lib/sprites-llm.js');
const storeMod = await import('../src/lib/sprites-store.js');
const {
  setLLMConfig,
  getLLMConfig,
  todayIso,
  buildSystemPrompt,
  buildUserPrompt,
  validateProcessed,
  callAnthropic,
  processUserAssignments,
  refreshAndProcess,
  attachLLMHandlers,
  __internals,
} = llm;
const { rawAssignmentsCache, processedAssignmentsCache, migrate } = storeMod;

function resetStore() {
  store.clear();
  runtimeListeners.length = 0;
}

/* helpers */
const SAMPLE_TODAY = '2026-05-09';
const SAMPLE_NOW = Date.parse(SAMPLE_TODAY + 'T12:00:00Z'); // mid-day UTC

function sampleNormalized() {
  return [
    { id: 'a1', title: 'Algebra HW 5', subject: 'Math', dueDate: '2026-05-12T23:59:00Z' },
    { id: 'a2', title: 'Lab Report',   subject: 'Science', dueDate: '2026-05-08T23:59:00Z' }, // overdue vs today
    { id: 'a3', title: 'Essay Draft',  subject: 'English', dueDate: '2026-05-15T23:59:00Z' },
  ];
}

function sampleProcessed(fetchedAt = new Date(SAMPLE_NOW).toISOString()) {
  return {
    categories: [
      {
        subject: 'Math',
        assignments: [
          { title: 'Algebra HW 5', dueDate: '2026-05-12T23:59:00Z', overdue: false, priority: 'medium' },
        ],
      },
      {
        subject: 'Science',
        assignments: [
          { title: 'Lab Report', dueDate: '2026-05-08T23:59:00Z', overdue: true, priority: 'high' },
        ],
      },
      {
        subject: 'English',
        assignments: [
          { title: 'Essay Draft', dueDate: '2026-05-15T23:59:00Z', overdue: false, priority: 'low' },
        ],
      },
    ],
    deadlineSummary: '3 assignments due this week; Science Lab Report overdue.',
    fetchedAt,
  };
}

async function seedRaw(user_id, hash = 'abc123def456' + '0'.repeat(52)) {
  await migrate();
  await rawAssignmentsCache.upsert({
    user_id,
    data_hash: hash,
    raw_json: { raw: { assignments: sampleNormalized() }, normalized: sampleNormalized() },
    fetched_at: SAMPLE_NOW,
  });
}

let passed = 0;
async function run(name, fn) {
  resetStore();
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error('         ', err?.stack || err?.message || err);
    process.exitCode = 1;
  }
}

/* ---- todayIso ---- */
await run('todayIso returns YYYY-MM-DD', async () => {
  const t = todayIso(SAMPLE_NOW);
  assert.equal(t, '2026-05-09');
});

/* ---- buildSystemPrompt / buildUserPrompt ---- */
await run('buildSystemPrompt injects today date and schema', async () => {
  const prompt = buildSystemPrompt('2026-05-09');
  assert.match(prompt, /Today's date is 2026-05-09/);
  assert.match(prompt, /"categories"/);
  assert.match(prompt, /"deadlineSummary"/);
  assert.match(prompt, /"priority": "high"\|"medium"\|"low"/);
  assert.match(prompt, /Return ONLY the JSON object/);
});

await run('buildUserPrompt JSON-encodes assignments + fetchedAt', async () => {
  const text = buildUserPrompt(sampleNormalized(), '2026-05-09T12:00:00.000Z');
  const parsed = JSON.parse(text);
  assert.equal(parsed.assignments.length, 3);
  assert.equal(parsed.fetchedAt, '2026-05-09T12:00:00.000Z');
});

/* ---- validateProcessed ---- */
await run('validateProcessed accepts well-formed payload', async () => {
  const v = validateProcessed(sampleProcessed());
  assert.equal(v.ok, true);
});

await run('validateProcessed rejects missing categories', async () => {
  const bad = { ...sampleProcessed() };
  delete bad.categories;
  const v = validateProcessed(bad);
  assert.equal(v.ok, false);
  assert.match(v.error, /categories/);
});

await run('validateProcessed rejects bad priority', async () => {
  const bad = sampleProcessed();
  bad.categories[0].assignments[0].priority = 'urgent';
  const v = validateProcessed(bad);
  assert.equal(v.ok, false);
  assert.match(v.error, /priority/);
});

await run('validateProcessed rejects non-boolean overdue', async () => {
  const bad = sampleProcessed();
  bad.categories[0].assignments[0].overdue = 'yes';
  const v = validateProcessed(bad);
  assert.equal(v.ok, false);
  assert.match(v.error, /overdue/);
});

await run('validateProcessed rejects empty deadlineSummary', async () => {
  const bad = sampleProcessed();
  bad.deadlineSummary = '';
  const v = validateProcessed(bad);
  assert.equal(v.ok, false);
});

await run('validateProcessed rejects bad fetchedAt', async () => {
  const bad = sampleProcessed();
  bad.fetchedAt = 'not-a-date';
  const v = validateProcessed(bad);
  assert.equal(v.ok, false);
});

/* ---- setLLMConfig / getLLMConfig ---- */
await run('setLLMConfig persists apiKey + defaults', async () => {
  await setLLMConfig({ apiKey: 'sk-ant-test' });
  const cfg = await getLLMConfig();
  assert.equal(cfg.apiKey, 'sk-ant-test');
  assert.equal(cfg.model, 'claude-sonnet-4-6');
  assert.equal(cfg.maxTokens, 2048);
});

await run('setLLMConfig throws when apiKey missing', async () => {
  await assert.rejects(() => setLLMConfig({}), /apiKey is required/);
});

/* ---- callAnthropic via stubbed fetch ---- */
await run('callAnthropic posts correct headers/body and parses content', async () => {
  let receivedReq;
  const fetchImpl = async (url, init) => {
    receivedReq = { url, init };
    return {
      ok: true,
      status: 200,
      async json() {
        return { content: [{ type: 'text', text: JSON.stringify({ hello: 'world' }) }] };
      },
    };
  };
  const out = await callAnthropic({
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-4-6',
    system: 'sys',
    userMessages: [{ role: 'user', content: 'data' }],
    fetchImpl,
  });
  assert.deepEqual(out, { hello: 'world' });
  assert.equal(receivedReq.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(receivedReq.init.method, 'POST');
  assert.equal(receivedReq.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(receivedReq.init.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(receivedReq.init.body);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'data' }]);
});

await run('callAnthropic strips ```json fences from model reply', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { content: [{ type: 'text', text: '```json\n{"a":1}\n```' }] };
    },
  });
  const out = await callAnthropic({ apiKey: 'k', system: 's', userMessages: [], fetchImpl });
  assert.deepEqual(out, { a: 1 });
});

await run('callAnthropic throws on non-2xx', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async text() { return 'invalid api key'; },
  });
  await assert.rejects(
    () => callAnthropic({ apiKey: 'k', system: 's', userMessages: [], fetchImpl }),
    /anthropic 401/,
  );
});

/* ---- processUserAssignments — cache hit ---- */
await run('processUserAssignments cache-hit skips LLM when source_hash matches data_hash', async () => {
  const user_id = 'user-cache';
  const hash = 'h' + '0'.repeat(63);
  await seedRaw(user_id, hash);
  await processedAssignmentsCache.upsert({
    user_id,
    processed_json: sampleProcessed(),
    source_hash: hash,
    processed_at: SAMPLE_NOW - 1000,
  });
  let called = 0;
  const r = await processUserAssignments(user_id, {
    now: SAMPLE_NOW,
    llmClient: async () => { called++; return sampleProcessed(); },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(called, 0, 'LLM must not be called on cache hit');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'cache');
  assert.equal(r.processed.deadlineSummary, sampleProcessed().deadlineSummary);
});

/* ---- processUserAssignments — cache miss, LLM success ---- */
await run('processUserAssignments cache-miss calls LLM, validates, persists', async () => {
  const user_id = 'user-fresh';
  await seedRaw(user_id, 'newhash' + '0'.repeat(57));
  const llmClient = async ({ system, userMessages }) => {
    assert.match(system, /Today's date is 2026-05-09/);
    assert.equal(userMessages.length, 1);
    const payload = JSON.parse(userMessages[0].content);
    assert.equal(payload.assignments.length, 3);
    return sampleProcessed();
  };
  const r = await processUserAssignments(user_id, {
    now: SAMPLE_NOW,
    llmClient,
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'llm');
  // overdue boolean must be correct relative to today (one item overdue)
  const overdue = r.processed.categories.flatMap((c) => c.assignments).filter((a) => a.overdue);
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].title, 'Lab Report');
  // persisted with matching source_hash
  const cached = await processedAssignmentsCache.get(user_id);
  assert.equal(cached.source_hash, 'newhash' + '0'.repeat(57));
  assert.equal(cached.processed_at, SAMPLE_NOW);
  assert.equal(cached.processed_json.fetchedAt, new Date(SAMPLE_NOW).toISOString());
  assert.ok(cached.processed_json.deadlineSummary.length > 0);
});

/* ---- processUserAssignments — no raw row ---- */
await run('processUserAssignments returns no-raw when raw cache empty', async () => {
  const r = await processUserAssignments('ghost-user', {
    now: SAMPLE_NOW,
    llmClient: async () => { throw new Error('should not be called'); },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-raw');
});

/* ---- processUserAssignments — malformed → retry → success ---- */
await run('processUserAssignments retries once on malformed output, then succeeds', async () => {
  const user_id = 'user-retry-success';
  await seedRaw(user_id, 'rs' + '0'.repeat(62));
  let calls = 0;
  const llmClient = async () => {
    calls++;
    if (calls === 1) return { categories: 'not-an-array', deadlineSummary: 'x', fetchedAt: 'y' };
    return sampleProcessed();
  };
  const warns = [];
  const r = await processUserAssignments(user_id, {
    now: SAMPLE_NOW,
    llmClient,
    log: { info() {}, warn(m) { warns.push(m); }, error() {} },
  });
  assert.equal(calls, 2);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'llm');
  assert.ok(warns.some((m) => /invalid output/.test(m)));
});

/* ---- processUserAssignments — malformed → retry → still malformed → throws ---- */
await run('processUserAssignments throws after retry exhausted; nothing persisted', async () => {
  const user_id = 'user-retry-fail';
  await seedRaw(user_id, 'rf' + '0'.repeat(62));
  let calls = 0;
  const errs = [];
  const llmClient = async () => {
    calls++;
    return { junk: true };
  };
  await assert.rejects(
    () => processUserAssignments(user_id, {
      now: SAMPLE_NOW,
      llmClient,
      log: { info() {}, warn() {}, error(m) { errs.push(m); } },
    }),
    /schema validation failed/,
  );
  assert.equal(calls, 2);
  assert.ok(errs.some((m) => /giving up/.test(m)));
  const cached = await processedAssignmentsCache.get(user_id);
  assert.equal(cached, null, 'no cache row written on persistent failure');
});

/* ---- processUserAssignments — force re-runs LLM despite matching hash ---- */
await run('processUserAssignments force=true bypasses cache hit', async () => {
  const user_id = 'user-force';
  const hash = 'fc' + '0'.repeat(62);
  await seedRaw(user_id, hash);
  await processedAssignmentsCache.upsert({
    user_id,
    processed_json: sampleProcessed(),
    source_hash: hash,
    processed_at: SAMPLE_NOW - 1000,
  });
  let called = 0;
  const r = await processUserAssignments(user_id, {
    now: SAMPLE_NOW,
    force: true,
    llmClient: async () => { called++; return sampleProcessed(); },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(called, 1);
  assert.equal(r.source, 'llm');
});

/* ---- refreshAndProcess — changed:true triggers LLM ---- */
await run('refreshAndProcess invokes LLM when refresh reports changed', async () => {
  const user_id = 'user-rap';
  await seedRaw(user_id, 'aa' + '0'.repeat(62));
  let llmCalls = 0;
  const refreshFn = async () => ({ ok: true, changed: true, fetchedAt: new Date(SAMPLE_NOW).toISOString(), hash: 'aa' + '0'.repeat(62) });
  const processFn = async () => { llmCalls++; return { ok: true, processed: sampleProcessed(), source: 'llm' }; };
  const r = await refreshAndProcess(user_id, { refreshFn, processFn });
  assert.equal(llmCalls, 1);
  assert.equal(r.ok, true);
  assert.equal(r.refresh.changed, true);
  assert.equal(r.processed.source, 'llm');
});

/* ---- refreshAndProcess — changed:false serves cached when present ---- */
await run('refreshAndProcess unchanged returns cached processed without re-running LLM', async () => {
  const user_id = 'user-rap-unchanged';
  const hash = 'bb' + '0'.repeat(62);
  await seedRaw(user_id, hash);
  await processedAssignmentsCache.upsert({
    user_id,
    processed_json: sampleProcessed(),
    source_hash: hash,
    processed_at: SAMPLE_NOW - 1000,
  });
  let llmCalls = 0;
  const refreshFn = async () => ({ ok: true, changed: false, fetchedAt: new Date(SAMPLE_NOW).toISOString(), hash });
  const r = await refreshAndProcess(user_id, {
    refreshFn,
    // No processFn override, so it falls into the real processUserAssignments which
    // hits the cache branch. We pass an llmClient that would throw to prove no call.
    llmClient: async () => { llmCalls++; throw new Error('should not call'); },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.equal(llmCalls, 0);
  assert.equal(r.ok, true);
  assert.equal(r.refresh.changed, false);
  assert.equal(r.processed.source, 'cache');
});

/* ---- refreshAndProcess — refresh failure short-circuits ---- */
await run('refreshAndProcess returns refresh failure without LLM call', async () => {
  const refreshFn = async () => ({ ok: false, reauth: true, error: 'expired' });
  let llmCalls = 0;
  const processFn = async () => { llmCalls++; };
  const r = await refreshAndProcess('user-x', { refreshFn, processFn });
  assert.equal(llmCalls, 0);
  assert.equal(r.ok, false);
  assert.equal(r.refresh.reauth, true);
});

/* ---- attachLLMHandlers — wires both message types ---- */
await run('attachLLMHandlers wires SPRITES_GET_PROCESSED_ASSIGNMENTS and SPRITES_REFRESH_AND_PROCESS', async () => {
  attachLLMHandlers();
  assert.equal(runtimeListeners.length, 1);
  // Seed a cache hit so the handler returns synchronously without an LLM call.
  const user_id = 'user-handler';
  const hash = 'hh' + '0'.repeat(62);
  await seedRaw(user_id, hash);
  await processedAssignmentsCache.upsert({
    user_id,
    processed_json: sampleProcessed(),
    source_hash: hash,
    processed_at: SAMPLE_NOW - 1000,
  });

  const replies = [];
  const ret1 = runtimeListeners[0](
    { type: 'SPRITES_GET_PROCESSED_ASSIGNMENTS', user_id },
    null,
    (r) => replies.push(['get', r]),
  );
  assert.equal(ret1, true, 'handler must return true for async sendResponse');

  // Unrelated message must be ignored (return undefined).
  const ret2 = runtimeListeners[0]({ type: 'OTHER' }, null, () => {});
  assert.equal(ret2, undefined);

  // Wait microtasks to flush the promise chain.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], 'get');
  assert.equal(replies[0][1].ok, true);
  assert.equal(replies[0][1].source, 'cache');
});

console.log(`\n${passed} passed`);
