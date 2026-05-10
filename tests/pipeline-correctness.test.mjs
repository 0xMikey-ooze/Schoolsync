#!/usr/bin/env node
// LLM pipeline correctness test (sub 3/4).
//
// Loads the Canvas-shaped fixture written by sub-task 2/4 at
// fixtures/canvas-assignments.json, pipes it through the LLM pipeline module
// scaffolded by sub-task 1/4, and checks the three correctness contracts that
// sub-task 3/4 owns. Cache-hit verification belongs to sub-task 4/4 and is
// intentionally NOT exercised here.
//
// Assertions (all three must pass; any failure exits non-zero):
//   (A) Every past-due-and-unsubmitted item is flagged overdue=true.
//       Every future-due item is flagged overdue=false.
//       Past-due-but-submitted items are NOT flagged overdue (per fixture
//       _expectations).
//   (B) The subject groupings object has at least one key and every key maps
//       to a non-empty array of assignment ids.
//   (C) deadlineSummary is a non-empty string.
//
// Pipeline-module discovery:
//   The script resolves the pipeline module by trying, in order:
//     - $LLM_PIPELINE_PATH (explicit override; useful for stacking on a sibling
//       branch's reference implementation before the production module lands)
//     - server/orchestrator/llm-pipeline.mjs
//     - server/orchestrator/llm-pipeline.js
//     - src/lib/llm-pipeline.mjs
//     - src/lib/llm-pipeline.js
//
// Module contract:
//   export async function processAssignments(rawAssignments, ctx) -> result
//     ctx:    { now: ISO8601, llmCall: async (prompt, payload) => structured }
//     result: { items: [{ id, isOverdue, ... }],
//               subjectBuckets: { [subject]: id[] },
//               deadlineSummary: string }
//
// The test injects a deterministic counted llmCall stub so correctness
// assertions don't depend on a live model. The stub also makes the test
// reproducible offline.
//
// Usage:
//   node tests/pipeline-correctness.test.mjs
// Exit codes:
//   0 — all assertions passed
//   1 — at least one assertion failed (a real correctness regression)
//   2 — pipeline module not found (upstream sub 1/4 has not landed)
//   3 — fixture not found (upstream sub 2/4 has not landed)
//   4 — harness error (unexpected exception)

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

const failures = [];
function check(cond, msg) {
  if (cond) {
    console.log(`${GREEN}PASS${RESET} ${msg}`);
  } else {
    console.log(`${RED}FAIL${RESET} ${msg}`);
    failures.push(msg);
  }
}

const FIXTURE_PATH = resolve(repoRoot, 'fixtures/canvas-assignments.json');

async function loadFixture() {
  let raw;
  try {
    raw = await readFile(FIXTURE_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`${YELLOW}MISSING_FIXTURE${RESET} ${FIXTURE_PATH} not found.`);
      console.log('Sub-task 2/4 ("Commit Canvas Assignment Fixture File") must land first.');
      process.exit(3);
    }
    throw e;
  }
  return JSON.parse(raw);
}

async function loadPipeline() {
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
      const mod = await import(pathToFileURL(resolve(repoRoot, rel)).href);
      if (typeof mod.processAssignments === 'function') {
        return { rel, processAssignments: mod.processAssignments };
      }
    } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'ENOENT') {
        // Surface real load errors instead of silently treating them as missing.
        throw new Error(
          `pipeline candidate ${rel} loaded but failed to import: ${e.message}`,
        );
      }
    }
  }
  return null;
}

// Deterministic LLM stub. Categorizes by course name keywords; the fixture's
// _expectations reflect what this stub will produce. Production paths use a
// real Anthropic call; verification swaps it out so we can assert structure
// without burning credits or depending on network.
function makeLlmStub() {
  let calls = 0;
  async function llmCall(_prompt, payload) {
    calls += 1;
    const buckets = {};
    const assignments = Array.isArray(payload?.assignments) ? payload.assignments : [];
    for (const a of assignments) {
      const courseName = (a.course?.name || '').toLowerCase();
      let subject = 'Other';
      if (/algebra|math|geometry|calculus/.test(courseName)) subject = 'Math';
      else if (/biolog|chem|physics|science/.test(courseName)) subject = 'Science';
      else if (/english|literature|writing/.test(courseName)) subject = 'English';
      else if (/history|civics|government/.test(courseName)) subject = 'History';
      (buckets[subject] ||= []).push(a.id);
    }
    return {
      subjectBuckets: buckets,
      deadlineSummary: `You have ${assignments.length} assignments to track this week.`,
    };
  }
  return { llmCall, getCalls: () => calls };
}

// Convert "isOverdue" lookups across the shapes a pipeline might emit.
// The contract says result.items[].isOverdue, but some implementations may use
// `overdue`, so accept both. The assertion is correctness, not field-name policing.
function isItemOverdue(item) {
  if (typeof item.isOverdue === 'boolean') return item.isOverdue;
  if (typeof item.overdue === 'boolean') return item.overdue;
  return false;
}

async function main() {
  const fixture = await loadFixture();
  if (!fixture.assignments || !Array.isArray(fixture.assignments)) {
    throw new Error('fixture missing required "assignments" array');
  }
  if (!fixture.nowISO) throw new Error('fixture missing required "nowISO"');
  if (!fixture._expectations) {
    throw new Error('fixture missing "_expectations" — cannot derive overdue truth set');
  }

  const expectedOverdue = new Set(fixture._expectations.overdueIds || []);
  const allIds = new Set(fixture.assignments.map(a => a.id));
  const expectedNotOverdue = new Set(
    [...allIds].filter(id => !expectedOverdue.has(id)),
  );

  const pipeline = await loadPipeline();
  if (!pipeline) {
    console.log(
      `${YELLOW}MISSING_PIPELINE${RESET} no processAssignments export found at any expected path.`,
    );
    console.log(
      'Sub-task 1/4 ("Scaffold LLM Pipeline Source Module") must land first, ' +
        'or set LLM_PIPELINE_PATH to a stacked sibling-branch implementation.',
    );
    process.exit(2);
  }

  console.log(`Using pipeline: ${pipeline.rel}`);
  console.log(`Fixture nowISO: ${fixture.nowISO}`);
  console.log(`Fixture assignments: ${fixture.assignments.length}`);
  console.log('');

  const stub = makeLlmStub();
  const result = await pipeline.processAssignments(fixture.assignments, {
    now: fixture.nowISO,
    llmCall: stub.llmCall,
    cache: new Map(),
  });

  // ---------------- Assertion (A): overdue flags ----------------
  const items = Array.isArray(result?.items) ? result.items : [];
  check(items.length === fixture.assignments.length,
    `pipeline returned items for every fixture assignment (${items.length}/${fixture.assignments.length})`);

  const flaggedOverdue = new Set(items.filter(isItemOverdue).map(i => i.id));
  for (const id of expectedOverdue) {
    check(flaggedOverdue.has(id), `past-due item ${id} flagged overdue=true`);
  }
  for (const id of expectedNotOverdue) {
    check(!flaggedOverdue.has(id), `non-overdue item ${id} flagged overdue=false`);
  }

  // ---------------- Assertion (B): subject groupings ----------------
  const buckets = result?.subjectBuckets;
  check(
    buckets && typeof buckets === 'object' && !Array.isArray(buckets),
    'subjectBuckets is a plain object',
  );
  if (buckets && typeof buckets === 'object') {
    const keys = Object.keys(buckets);
    check(keys.length >= 1, `subjectBuckets has at least one key (got ${keys.length})`);
    for (const key of keys) {
      const ids = buckets[key];
      check(
        Array.isArray(ids) && ids.length > 0,
        `subjectBuckets["${key}"] is a non-empty array (got ${Array.isArray(ids) ? ids.length : typeof ids})`,
      );
    }
  }

  // ---------------- Assertion (C): deadlineSummary ----------------
  check(
    typeof result?.deadlineSummary === 'string' && result.deadlineSummary.trim().length > 0,
    `deadlineSummary is a non-empty string (got ${typeof result?.deadlineSummary}, len=${result?.deadlineSummary?.length ?? 0})`,
  );

  console.log('');
  if (failures.length === 0) {
    console.log(`${GREEN}ALL CORRECTNESS CHECKS PASSED${RESET}`);
    console.log(`(llmCall invocations: ${stub.getCalls()} — cache verification is sub 4/4)`);
    process.exit(0);
  }
  console.log(`${RED}${failures.length} CHECK(S) FAILED${RESET}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

main().catch(err => {
  console.error('HARNESS_ERROR', err);
  process.exit(4);
});
