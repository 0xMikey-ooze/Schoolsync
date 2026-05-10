# ACCEPTANCE — Schoolsync × sprites.dev OAuth + LLM Assignment Intelligence

This file records acceptance evidence per sub-task. It is appended-to by sibling
verification teams; entries are isolated by section so concurrent edits stay clean.

---

## Sub-task 2/4 — LLM Pipeline Correctness & Cache Verification

**Branch:** `team/llm-pipeline-verify`
**Run date (UTC):** 2026-05-10
**Status:** PARTIAL — verification harness built and runs; pipeline under test does not exist in repo.

### Deliverables produced

1. **Fixture** — `fixtures/canvas-assignments.json`
   - 7 Canvas-shaped assignments across 4 subjects (Math, Science, English, History).
   - Mix of past-due and future-due relative to fixture-anchored `nowISO = 2026-05-09T12:00:00Z`.
   - One past-due-but-submitted item (`asg_302`) to verify overdue logic excludes submitted work.
   - One same-day item (`asg_401`, due 2026-05-10) to verify the overdue threshold uses `nowISO` rather than calendar-day.
   - Embedded `_expectations` block declares the exact overdue set, expected subjects, and expected per-subject buckets.

2. **Verification harness** — `tests/llm-pipeline.test.mjs`
   - Runs with bare `node tests/llm-pipeline.test.mjs` (no install required).
   - Imports the upstream pipeline from any of:
     - `server/orchestrator/llm-pipeline.mjs|.js`
     - `src/lib/llm-pipeline.mjs|.js`
   - Required export signature:
     ```js
     export async function processAssignments(rawAssignments, { now, llmCall, cache }) -> {
       items: [{ id, subject, isOverdue, dueAt, courseName, ... }],
       subjectBuckets: { [subject]: assignmentId[] },
       deadlineSummary: string,
     }
     ```
   - Asserts:
     - **Overdue correctness** — `items.filter(isOverdue).map(id)` exactly equals `_expectations.overdueIds` (`asg_101`, `asg_201`).
     - **Subject grouping** — every subject in `_expectations.subjectsExpected` is present and non-empty; each expected ID appears in its expected bucket.
     - **Deadline summary** — `deadlineSummary` is a non-empty string.
     - **Cache hit** — invokes pipeline twice with identical `rawAssignments` + `nowISO` and shared cache; counts `llmCall` invocations and asserts the second call did not increment the counter (cache hit verified by injected counter, not log scraping).

### Cache contract enforced by harness

The pipeline must accept an injectable `llmCall` and a `cache` map, and must
look up by content-hash of `rawAssignments` (or equivalent) so identical input
on the next 15-min poll yields a cache hit. The counter approach is more
reliable than log scraping because it does not depend on log format and gives
a binary verdict.

### Verification result

Command:
```
node tests/llm-pipeline.test.mjs
```
Exit code: `2` — `MISSING_PIPELINE`. The harness reports the missing module
path and the required export signature so the upstream LLM Pipeline task can
satisfy the contract by publishing to one of the conventional paths.

### Why this is PARTIAL not DONE

The repository at HEAD is the upstream Schoolsync Chrome extension
(`manifest_version: 3`, `src/background/service-worker.js`,
`src/content/parsers/*`). It contains **no Node server, no `package.json`, no
`server/orchestrator/`, and no LLM pipeline source**. The PRD's prior tasks
(Database Schema, Auth Backend, Polling Worker, LLM Processing Pipeline) were
marked done in the run manifest but did not actually land code in this
worktree. Verifying a pipeline that does not exist is not possible; the
harness instead pins the contract and produces a deterministic red until the
pipeline is implemented.

### Forbidden paths avoided

- Did not modify `manifest.json`, `src/background/`, `src/content/parsers/` — those belong to the unrelated Chrome-extension app already in the repo.
- Did not invent a stub pipeline implementation to make the harness green; doing so would falsely claim verification of a feature that does not exist.
- Did not modify any auth, schema, secrets, or persistence path.

### Next step for the conductor

Either (a) recover the upstream "LLM Processing Pipeline" task so it actually
lands `server/orchestrator/llm-pipeline.{mjs,js}` (or `src/lib/`) implementing
the export above, then re-run `node tests/llm-pipeline.test.mjs`; or
(b) accept that the grafted PRD does not match the repository and reset the
PRD to match the Chrome extension's actual capabilities.
