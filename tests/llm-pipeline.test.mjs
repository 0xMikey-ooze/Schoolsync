// Verification harness: LLM pipeline correctness + cache hit behavior.
//
// Usage: node tests/llm-pipeline.test.mjs
//
// Two modes:
//   1) IMPLEMENTED — if `server/orchestrator/llm-pipeline.mjs` (or `.js`) exports
//      `processAssignments(rawAssignments, { now, llmCall })`, the harness pipes the
//      fixture through it twice with a counted llmCall and asserts:
//        - overdue flags exactly match expected past-due-and-unsubmitted set
//        - subject buckets are non-empty and bucketed as expected
//        - deadlineSummary is a non-empty string
//        - second invocation with identical raw input does NOT call llmCall
//          (cache hit verified by counter == 1, not 2)
//   2) CONTRACT-ONLY — if the pipeline module is missing, the harness logs
//      MISSING_PIPELINE and exits with code 2. This is the documented red state
//      that the upstream "LLM Processing Pipeline" task must satisfy.
//
// The harness never invents pipeline behavior to make tests pass; it only validates
// what an implementation must produce.

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m';
const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log(`${GREEN}PASS${RESET} ${msg}`);
  } else {
    console.log(`${RED}FAIL${RESET} ${msg}`);
    failures.push(msg);
  }
}

async function loadFixture() {
  const raw = await readFile(resolve(repoRoot, 'fixtures/canvas-assignments.json'), 'utf8');
  return JSON.parse(raw);
}

async function tryLoadPipeline() {
  // Optional override for harness self-validation against a reference impl
  // that intentionally lives outside the source path. Set
  // LLM_PIPELINE_PATH=tests/_reference-pipeline.mjs to exercise the green path.
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
        // Surface real load errors instead of silently treating them as missing.
        throw new Error(`Found candidate pipeline at ${rel} but it failed to import: ${e.message}`);
      }
    }
  }
  return null;
}

function makeCountingLlm() {
  // The pipeline is expected to accept an injectable llmCall so tests can count
  // invocations. Production code should default to a real LLM client, but for
  // verification the harness substitutes this stub. The stub returns a
  // deterministic structured-output shape so correctness assertions don't
  // depend on an actual model response.
  let calls = 0;
  async function llmCall(prompt, payload) {
    calls += 1;
    // Deterministic categorization derived from course name keywords so the
    // pipeline's downstream behavior (bucketing, summary) can be exercised.
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
  return { llmCall: (...a) => llmCall(...a), getCalls: () => calls };
}

function runContractOnlyMode() {
  console.log(`${YELLOW}MISSING_PIPELINE${RESET} no processAssignments export found at any expected path.`);
  console.log('Expected one of:');
  console.log('  server/orchestrator/llm-pipeline.mjs');
  console.log('  server/orchestrator/llm-pipeline.js');
  console.log('  src/lib/llm-pipeline.mjs');
  console.log('  src/lib/llm-pipeline.js');
  console.log('Required export signature:');
  console.log('  export async function processAssignments(rawAssignments, { now, llmCall, cache }) -> {');
  console.log('    items: [{ id, subject, isOverdue, dueAt, courseName, ... }],');
  console.log('    subjectBuckets: { [subject]: assignmentId[] },');
  console.log('    deadlineSummary: string,');
  console.log('  }');
  console.log('Cache contract: when invoked twice with identical rawAssignments + same nowISO,');
  console.log('llmCall must be invoked exactly once across both invocations.');
  process.exitCode = 2;
}

async function main() {
  const fixture = await loadFixture();
  const expectedOverdue = new Set(fixture._expectations.overdueIds);
  const expectedSubjects = fixture._expectations.subjectsExpected;
  const expectedBuckets = fixture._expectations.subjectBuckets;

  const pipeline = await tryLoadPipeline();
  if (!pipeline) {
    runContractOnlyMode();
    return;
  }

  console.log(`Using pipeline at ${pipeline.rel}`);
  const counter = makeCountingLlm();
  const sharedCache = new Map();

  const out1 = await pipeline.processAssignments(fixture.assignments, {
    now: fixture.nowISO,
    llmCall: counter.llmCall,
    cache: sharedCache,
  });

  // Correctness: overdue flags
  const flagged = new Set((out1.items || []).filter(i => i.isOverdue).map(i => i.id));
  assert(
    flagged.size === expectedOverdue.size && [...expectedOverdue].every(id => flagged.has(id)),
    `overdue flags match expected set ${[...expectedOverdue].join(',')} (got ${[...flagged].join(',')})`
  );

  // Correctness: subject buckets non-empty + bucketed correctly
  assert(out1.subjectBuckets && typeof out1.subjectBuckets === 'object', 'subjectBuckets present');
  for (const subj of expectedSubjects) {
    const ids = out1.subjectBuckets?.[subj] || [];
    assert(ids.length > 0, `subject bucket ${subj} non-empty`);
    const expected = expectedBuckets[subj] || [];
    const ok = expected.every(id => ids.includes(id));
    assert(ok, `subject bucket ${subj} contains ${expected.join(',')}`);
  }

  // Correctness: deadlineSummary non-empty string
  assert(
    typeof out1.deadlineSummary === 'string' && out1.deadlineSummary.trim().length > 0,
    'deadlineSummary is a non-empty string'
  );

  const callsAfterFirst = counter.getCalls();
  assert(callsAfterFirst >= 1, `first invocation called llmCall (saw ${callsAfterFirst})`);

  // Cache hit: second identical invocation must not re-call llmCall
  await pipeline.processAssignments(fixture.assignments, {
    now: fixture.nowISO,
    llmCall: counter.llmCall,
    cache: sharedCache,
  });
  const callsAfterSecond = counter.getCalls();
  assert(
    callsAfterSecond === callsAfterFirst,
    `second invocation hit cache; llmCall count unchanged (${callsAfterFirst} -> ${callsAfterSecond})`
  );

  if (failures.length === 0) {
    console.log(`\n${GREEN}ALL CHECKS PASSED${RESET}`);
  } else {
    console.log(`\n${RED}${failures.length} CHECK(S) FAILED${RESET}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('HARNESS_ERROR', err);
  process.exit(3);
});
