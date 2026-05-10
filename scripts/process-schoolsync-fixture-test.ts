/**
 * Fixture test for processSchoolsyncData.
 *
 * Acceptance evidence for t4:
 *   - Pass a hardcoded RawSchoolsyncPayload sample through processSchoolsyncData
 *     with a stubbed LLM client and an in-memory store.
 *   - Assert the returned object passes ProcessedAssignmentsSchema.parse().
 *   - Assert that calling processSchoolsyncData again with the same rawJson
 *     skips the LLM call and emits "schoolsync: skipping LLM call, identical input".
 *
 * Stubbing the LLM keeps the test runnable without ANTHROPIC_API_KEY. A live
 * smoke check against real claude-sonnet-4-6 is deferred to t7 (Integration &
 * Verification) where a real key is expected to be available.
 */

import {
  ProcessedAssignmentsSchema,
  type ProcessedAssignments,
  type RawSchoolsyncPayload,
} from "../server/orchestrator/schoolsync-types.js";
import {
  hashRawInput,
  processSchoolsyncData,
} from "../server/orchestrator/processSchoolsync.js";
import { createInMemoryProcessedStore } from "../server/orchestrator/processed-store.js";
import type { LLMClient } from "../server/orchestrator/llm-client.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const RAW_PAYLOAD: RawSchoolsyncPayload = {
  fetchedAt: "2026-05-09T12:00:00.000Z",
  source: "schoolsync.v1",
  assignments: [
    {
      id: "h-1",
      title: "WWII essay outline",
      subject: "History",
      due: "2026-05-04T23:59:00.000Z",
    },
    {
      id: "m-1",
      title: "Algebra problem set 4",
      // Use the alt key `course` to exercise the subject/course fallback.
      course: "Math",
      dueDate: "2026-05-12T23:59:00.000Z",
      description: "Sections 4.1-4.3",
    },
  ],
};

const LLM_OUTPUT: ProcessedAssignments = {
  categorized: [
    {
      subject: "History",
      assignments: [
        {
          id: "h-1",
          title: "WWII essay outline",
          subject: "History",
          due_date: "2026-05-04T23:59:00.000Z",
          source: "schoolsync.v1",
        },
      ],
    },
    {
      subject: "Math",
      assignments: [
        {
          id: "m-1",
          title: "Algebra problem set 4",
          subject: "Math",
          due_date: "2026-05-12T23:59:00.000Z",
          description: "Sections 4.1-4.3",
          source: "schoolsync.v1",
        },
      ],
    },
  ],
  prioritized: [
    {
      id: "h-1",
      title: "WWII essay outline",
      subject: "History",
      due_date: "2026-05-04T23:59:00.000Z",
      source: "schoolsync.v1",
    },
    {
      id: "m-1",
      title: "Algebra problem set 4",
      subject: "Math",
      due_date: "2026-05-12T23:59:00.000Z",
      description: "Sections 4.1-4.3",
      source: "schoolsync.v1",
    },
  ],
  overdue: [
    {
      id: "h-1",
      title: "WWII essay outline",
      subject: "History",
      due_date: "2026-05-04T23:59:00.000Z",
      source: "schoolsync.v1",
    },
  ],
  deadlineSummary:
    "Your WWII essay outline is overdue and should be turned in immediately. The next upcoming deadline is the Algebra problem set due May 12.",
};

let llmCalls: number = 0;
const stubClient: LLMClient = {
  async complete({ system, user }) {
    llmCalls += 1;
    // Sanity-check that the prompt vars actually got rendered into the user message.
    assert(user.includes("today: 2026-05-09"), "prompt should include today");
    assert(user.includes('"id":"h-1"'), "prompt should include assignment id");
    assert(system.includes("GROUP"), "system prompt must include GROUP rule");
    return JSON.stringify(LLM_OUTPUT);
  },
};

const logs: string[] = [];
const log = (line: string) => logs.push(line);

const userId = "user-123";
const rawJson = JSON.stringify(RAW_PAYLOAD);
const expectedHash = hashRawInput(rawJson);

const store = createInMemoryProcessedStore();

async function main() {
  // First call: should hit the LLM and persist a row.
  const first = await processSchoolsyncData(rawJson, userId, {
    store,
    client: stubClient,
    now: () => new Date("2026-05-09T12:00:00.000Z"),
    log,
  });
  ProcessedAssignmentsSchema.parse(first); // re-validate publicly returned shape
  assert(llmCalls === 1, "first call must invoke the LLM exactly once");
  assert(store.rows.length === 1, "first call must insert a row");
  assert(store.rows[0].userId === userId, "row userId");
  assert(store.rows[0].inputHash === expectedHash, "row inputHash matches sha256");
  assert(
    !logs.some((l) => l.includes("skipping LLM call")),
    "first call must NOT log skipping",
  );

  // Second call with identical rawJson: dedup must skip the LLM and return
  // the cached output. Log line is the contractual signal t2/t5 will rely on.
  const second = await processSchoolsyncData(rawJson, userId, {
    store,
    client: stubClient,
    now: () => new Date("2026-05-09T12:00:00.000Z"),
    log,
  });
  ProcessedAssignmentsSchema.parse(second);
  assert(llmCalls === 1, "second identical call must NOT invoke the LLM");
  assert(store.rows.length === 1, "second identical call must NOT insert");
  assert(
    logs.some((l) => l === "schoolsync: skipping LLM call, identical input"),
    "second call must log the skip line verbatim",
  );

  // Different rawJson with the same userId: dedup is keyed on (userId, hash),
  // so this must fall through to the LLM again.
  const otherRaw = JSON.stringify({
    ...RAW_PAYLOAD,
    fetchedAt: "2026-05-09T13:00:00.000Z",
  });
  await processSchoolsyncData(otherRaw, userId, {
    store,
    client: stubClient,
    now: () => new Date("2026-05-09T12:00:00.000Z"),
    log,
  });
  // Re-read through a function call to defeat literal-type narrowing from
  // earlier asserts (`llmCalls === 1` narrowed the local view to 1).
  const callsAfterDifferent: number = llmCalls;
  const rowsAfterDifferent: number = store.rows.length;
  assert(callsAfterDifferent === 2, "different input must trigger a fresh LLM call");
  assert(rowsAfterDifferent === 2, "different input must insert a second row");

  // Schema-violating LLM output must throw and log the raw response so an
  // operator can debug a model regression.
  const badClient: LLMClient = {
    async complete() {
      return '{"categorized":"not-an-array"}';
    },
  };
  let threw = false;
  try {
    await processSchoolsyncData(
      JSON.stringify({ ...RAW_PAYLOAD, fetchedAt: "third" }),
      "user-bad",
      { store, client: badClient, now: () => new Date(), log },
    );
  } catch {
    threw = true;
  }
  assert(threw, "bad LLM output must throw");
  assert(
    logs.some((l) => l.startsWith("schoolsync: LLM response failed schema parse")),
    "bad LLM output must log the raw response",
  );

  console.log("OK: processSchoolsyncData fixture test green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
