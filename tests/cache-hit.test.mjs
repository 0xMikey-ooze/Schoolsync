// Focused cache-hit verification for processAssignments.
//
// Scope (sub 4/4 of LLM Pipeline Correctness & Cache Verification):
//   Run processAssignments twice with identical raw input + identical nowISO
//   + a shared cache, and assert that the injected llmCall counter is NOT
//   incremented on the second invocation. This is the deterministic cache-hit
//   contract: same input on the next 15-min poll must skip the LLM and read
//   from cache.
//
// This is intentionally narrower than tests/llm-pipeline.test.mjs (which also
// covers correctness) so a cache regression produces a single, unambiguous
// failure. The two tests share the fixture and the source-path resolution
// rules.
//
// Usage:
//   node tests/cache-hit.test.mjs
//   LLM_PIPELINE_PATH=tests/_reference-pipeline.mjs node tests/cache-hit.test.mjs
//
// Exit codes: 0 = green, 1 = cache assertion failed,
//             2 = pipeline source missing (contract-only red),
//             3 = harness error.

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m';
const failures = [];
function assert(cond, msg) {
  if (cond) console.log(`${GREEN}PASS${RESET} ${msg}`);
  else { console.log(`${RED}FAIL${RESET} ${msg}`); failures.push(msg); }
}

async function loadFixture() {
  const raw = await readFile(resolve(repoRoot, 'fixtures/canvas-assignments.json'), 'utf8');
  return JSON.parse(raw);
}

async function tryLoadPipeline() {
  // Same resolution order as the broader harness so both tests stay in sync.
  // LLM_PIPELINE_PATH override exists for harness self-validation against the
  // reference impl that lives outside production source paths.
  const override = process.env.LLM_PIPELINE_PATH;
  const candidates = override
    ? [override]
    : [
        'server/orchestrator/llm-pipeline.mjs',
        'server/orchestrator/llm-pipeline.js',
        'src/lib/llm-pipeline.mjs',
        'src/lib/llm-pipeline.js',
      ];
  for (const rel of candidates) {
    try {
      const url = pathToFileURL(resolve(repoRoot, rel)).href;
      const mod = await import(url);
      if (typeof mod.processAssignments === 'function') {
        return { rel, processAssignments: mod.processAssignments };
      }
    } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'ENOENT') {
        throw new Error(`Found candidate pipeline at ${rel} but it failed to import: ${e.message}`);
      }
    }
  }
  return null;
}

// Counting llmCall stub. The pipeline must accept this as an injectable
// dependency. The body returns a deterministic structured-output shape so the
// pipeline can complete its first call without a real model — but the body
// is irrelevant to this test's assertion: we only count invocations.
function makeCountingLlm() {
  let calls = 0;
  async function llmCall(_prompt, payload) {
    calls += 1;
    const buckets = { Math: [], Science: [], English: [], History: [], Other: [] };
    for (const a of payload.assignments) {
      const name = (a.course?.name || '').toLowerCase();
      let subject = 'Other';
      if (/algebra|math|geometry|calculus/.test(name)) subject = 'Math';
      else if (/biolog|chem|physics|science/.test(name)) subject = 'Science';
      else if (/english|literature|writing/.test(name)) subject = 'English';
      else if (/history|civics|government/.test(name)) subject = 'History';
      buckets[subject].push(a.id);
    }
    return {
      subjectBuckets: buckets,
      deadlineSummary: `You have ${payload.assignments.length} assignments to track this week.`,
    };
  }
  return { llmCall, getCalls: () => calls };
}

async function main() {
  const fixture = await loadFixture();
  const pipeline = await tryLoadPipeline();
  if (!pipeline) {
    console.log(`${YELLOW}MISSING_PIPELINE${RESET} no processAssignments export found.`);
    console.log('Set LLM_PIPELINE_PATH or land src/lib/llm-pipeline.{mjs,js} or server/orchestrator/llm-pipeline.{mjs,js}.');
    process.exitCode = 2;
    return;
  }

  console.log(`Using pipeline at ${pipeline.rel}`);
  const counter = makeCountingLlm();
  const sharedCache = new Map();

  // First call: must invoke the LLM (cache empty).
  await pipeline.processAssignments(fixture.assignments, {
    now: fixture.nowISO,
    llmCall: counter.llmCall,
    cache: sharedCache,
  });
  const callsAfterFirst = counter.getCalls();
  assert(callsAfterFirst === 1, `first invocation called llmCall exactly once (saw ${callsAfterFirst})`);

  // Second call with identical raw input + identical nowISO + shared cache:
  // must hit the cache and NOT re-invoke the LLM.
  await pipeline.processAssignments(fixture.assignments, {
    now: fixture.nowISO,
    llmCall: counter.llmCall,
    cache: sharedCache,
  });
  const callsAfterSecond = counter.getCalls();
  assert(
    callsAfterSecond === callsAfterFirst,
    `second invocation hit cache; llmCall counter unchanged (${callsAfterFirst} -> ${callsAfterSecond})`
  );

  // Sanity: a third call with a DIFFERENT nowISO (or different content) must
  // bust the cache. This guards against a degenerate "always return cached"
  // implementation that would also satisfy the counter assertion above.
  const differentNow = '2026-05-10T12:00:00Z';
  await pipeline.processAssignments(fixture.assignments, {
    now: differentNow,
    llmCall: counter.llmCall,
    cache: sharedCache,
  });
  const callsAfterThird = counter.getCalls();
  assert(
    callsAfterThird === callsAfterSecond + 1,
    `cache key includes nowISO; different now triggers re-invocation (${callsAfterSecond} -> ${callsAfterThird})`
  );

  if (failures.length === 0) {
    console.log(`\n${GREEN}CACHE-HIT VERIFIED${RESET} (counter ${callsAfterFirst} -> ${callsAfterSecond} unchanged across identical inputs)`);
  } else {
    console.log(`\n${RED}${failures.length} CACHE CHECK(S) FAILED${RESET}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('HARNESS_ERROR', err);
  process.exit(3);
});
