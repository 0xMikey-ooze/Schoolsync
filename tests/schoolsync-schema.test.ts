import {
  AssignmentSchema,
  ProcessedAssignmentsSchema,
  type ProcessedAssignments,
} from "../server/orchestrator/schoolsync-types.js";
import {
  SCHOOLSYNC_PROCESSING_SYSTEM_PROMPT,
  renderSchoolsyncProcessingUserPrompt,
} from "../server/orchestrator/prompts.js";

// Hand-crafted fixture matching the Assignment shape and the four-bucket
// ProcessedAssignments output. This is the acceptance evidence: the parse
// must succeed without errors.
const fixture: ProcessedAssignments = {
  categorized: [
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
    {
      subject: "History",
      assignments: [
        {
          id: "h-1",
          title: "WWII essay outline",
          subject: "History",
          due_date: "2026-05-04T23:59:00.000Z",
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
    },
  ],
  deadlineSummary:
    "Your WWII essay outline is overdue and should be turned in immediately. The next upcoming deadline is the Algebra problem set due May 12.",
};

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// 1. ProcessedAssignments.parse() succeeds on the fixture.
const parsed = ProcessedAssignmentsSchema.parse(fixture);
assert(parsed.categorized.length === 2, "categorized length");
assert(parsed.prioritized.length === 2, "prioritized length");
assert(parsed.overdue.length === 1, "overdue length");
assert(parsed.deadlineSummary.length > 0, "summary present");

// 2. Assignment-level invariants: bad due_date is rejected.
const badDate = AssignmentSchema.safeParse({
  id: "x",
  title: "x",
  subject: "x",
  due_date: "not-a-date",
});
assert(!badDate.success, "bad due_date must fail");

// 3. Prompt contains all four pipeline instructions.
const promptLower = SCHOOLSYNC_PROCESSING_SYSTEM_PROMPT.toLowerCase();
for (const needle of ["group", "sort", "overdue", "summary"]) {
  assert(promptLower.includes(needle), `prompt missing instruction: ${needle}`);
}

// 4. User prompt renderer substitutes both template variables.
const rendered = renderSchoolsyncProcessingUserPrompt({
  todayIso: "2026-05-09",
  assignmentsJson: '[{"id":"m-1"}]',
});
assert(rendered.includes("2026-05-09"), "today substituted");
assert(rendered.includes('"id":"m-1"'), "assignments substituted");
assert(!rendered.includes("{{"), "no leftover template tokens");

console.log("OK: ProcessedAssignments parse + prompt checks all green");
