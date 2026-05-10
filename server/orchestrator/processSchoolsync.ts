import { createHash } from "node:crypto";
import {
  ProcessedAssignmentsSchema,
  AssignmentSchema,
  type Assignment,
  type ProcessedAssignments,
  type RawSchoolsyncPayload,
  type RawSchoolsyncAssignment,
} from "./schoolsync-types.js";
import {
  SCHOOLSYNC_PROCESSING_SYSTEM_PROMPT,
  renderSchoolsyncProcessingUserPrompt,
} from "./prompts.js";
import {
  createAnthropicLLMClient,
  type LLMClient,
} from "./llm-client.js";
import type { ProcessedStore } from "./processed-store.js";

/** Dependencies for processSchoolsyncData. Both are injectable so the fixture
 *  test can run without a real Anthropic key or a live Postgres. */
export interface ProcessSchoolsyncDeps {
  store: ProcessedStore;
  client?: LLMClient; // defaults to createAnthropicLLMClient()
  /** Override "today" for deterministic tests. Defaults to new Date(). */
  now?: () => Date;
  /** Test seam: replace console.log so tests can assert log lines. */
  log?: (line: string) => void;
}

const DEFAULT_LOG = (line: string) => console.log(line);

/**
 * sha256(rawJson) hex digest. Computed on the raw input string verbatim so
 * caller-supplied canonicalization (key ordering, etc.) is preserved.
 */
export function hashRawInput(rawJson: string): string {
  return createHash("sha256").update(rawJson).digest("hex");
}

/**
 * Normalize a RawSchoolsyncPayload into the strict Assignment[] shape the
 * prompt expects. Handles the documented variants in t3's RawSchoolsyncAssignment
 * (subject vs course, due vs dueDate). Any assignment that fails to normalize
 * is dropped with a warning rather than failing the whole batch.
 */
export function normalizeAssignments(
  payload: RawSchoolsyncPayload,
  log: (line: string) => void = DEFAULT_LOG,
): Assignment[] {
  const out: Assignment[] = [];
  for (const raw of payload.assignments) {
    const candidate = rawToAssignment(raw, payload.source);
    const parsed = AssignmentSchema.safeParse(candidate);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      log(
        `schoolsync: dropping unnormalizable assignment id=${raw.id ?? "?"} reason=${parsed.error.issues
          .map((i) => `${i.path.join(".")}:${i.message}`)
          .join(",")}`,
      );
    }
  }
  return out;
}

function rawToAssignment(
  raw: RawSchoolsyncAssignment,
  source: string,
): Partial<Assignment> {
  return {
    id: raw.id,
    title: raw.title,
    subject: raw.subject ?? raw.course ?? "Uncategorized",
    due_date: raw.due ?? raw.dueDate ?? "",
    description: typeof raw.description === "string" ? raw.description : undefined,
    url: typeof raw.url === "string" ? raw.url : undefined,
    source,
  };
}

/**
 * Full Schoolsync processing pipeline.
 *
 * Steps (per task spec):
 *   1. sha256(rawJson) → inputHash.
 *   2. store.findByHash(userId, inputHash) — return cached output if present
 *      and log "schoolsync: skipping LLM call, identical input".
 *   3. Call claude-sonnet-4-6 with the t3 prompt.
 *   4. Parse with ProcessedAssignmentsSchema; throw + log raw response on fail.
 *   5. Insert new schoolsync_processed row.
 *   6. Return typed ProcessedAssignments.
 */
export async function processSchoolsyncData(
  rawJson: string,
  userId: string,
  deps: ProcessSchoolsyncDeps,
): Promise<ProcessedAssignments> {
  const log = deps.log ?? DEFAULT_LOG;
  const inputHash = hashRawInput(rawJson);

  // 2. Dedup: don't re-spend on identical input within a polling window.
  const cached = await deps.store.findByHash({ userId, inputHash });
  if (cached) {
    log("schoolsync: skipping LLM call, identical input");
    // outputJson is jsonb — we still validate it on the way out so a corrupted
    // row can't poison downstream consumers.
    return ProcessedAssignmentsSchema.parse(cached.outputJson);
  }

  // 3. Build prompt inputs. The raw payload is parsed once and normalized into
  // the strict Assignment[] the model expects.
  const payload = JSON.parse(rawJson) as RawSchoolsyncPayload;
  const assignments = normalizeAssignments(payload, log);
  const todayIso = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const userPrompt = renderSchoolsyncProcessingUserPrompt({
    todayIso,
    assignmentsJson: JSON.stringify(assignments),
  });

  const client = deps.client ?? createAnthropicLLMClient();
  const rawResponse = await client.complete({
    system: SCHOOLSYNC_PROCESSING_SYSTEM_PROMPT,
    user: userPrompt,
  });

  // 4. Parse. The prompt locks the model to raw JSON, but the SDK can return
  // surrounding whitespace or stray prose if the model misbehaves — strip
  // anything outside the outermost {...} before parsing.
  let parsed: ProcessedAssignments;
  try {
    parsed = ProcessedAssignmentsSchema.parse(extractJsonObject(rawResponse));
  } catch (err) {
    log(`schoolsync: LLM response failed schema parse. raw=${rawResponse}`);
    throw err;
  }

  // 5. Persist the validated output keyed by (userId, inputHash).
  await deps.store.insert({
    userId,
    inputHash,
    outputJson: parsed,
    processedAt: new Date(),
  });

  return parsed;
}

/** Pull the first balanced top-level JSON object out of a model response. */
function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response did not contain a JSON object");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}
