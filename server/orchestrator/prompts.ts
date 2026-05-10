/**
 * LLM prompts for the Schoolsync assignment intelligence pipeline.
 *
 * Today's date is injected at call time so the model can classify overdue
 * assignments correctly relative to "now". Always pass an ISO-8601 date.
 */

export interface SchoolsyncProcessingPromptVars {
  /** ISO-8601 date string for "today" — used to flag overdue items. */
  todayIso: string;
  /** JSON string of the normalized Assignment[] to be processed. */
  assignmentsJson: string;
}

/**
 * System prompt: lists the four required pipeline instructions and locks
 * the model to JSON-mode / structured output matching ProcessedAssignments.
 */
export const SCHOOLSYNC_PROCESSING_SYSTEM_PROMPT = [
  "You are an assistant that organizes a student's pending school assignments.",
  "You will receive a JSON array of normalized Assignment objects and a `today` date.",
  "",
  "Follow ALL FOUR of these instructions precisely:",
  "1. GROUP assignments by `subject` into the `categorized` array. Each entry must be { subject, assignments }. Every input assignment must appear in exactly one group, keyed by its subject string verbatim.",
  "2. SORT all assignments by `due_date` ascending (earliest first) and place the full sorted list in `prioritized`. Stable order for ties.",
  "3. FLAG OVERDUE: any assignment whose `due_date` is strictly before the provided `today` date goes into the `overdue` array, also sorted by `due_date` ascending.",
  "4. WRITE a concise 2-sentence `deadlineSummary` describing what is most urgent and any overdue work. Do not exceed two sentences.",
  "",
  "Respond with ONLY a single JSON object matching this exact shape and no prose, no code fences:",
  "{",
  '  "categorized": [{ "subject": string, "assignments": Assignment[] }],',
  '  "prioritized": Assignment[],',
  '  "overdue": Assignment[],',
  '  "deadlineSummary": string',
  "}",
  "Each Assignment object must preserve all fields from the input verbatim — do not invent, drop, or rename fields.",
].join("\n");

/**
 * User-message template. Renders today's date and the assignments JSON.
 * Use the `renderSchoolsyncProcessingUserPrompt` helper to substitute values
 * safely instead of doing manual string concatenation at call sites.
 */
export const SCHOOLSYNC_PROCESSING_USER_TEMPLATE = [
  "today: {{TODAY_ISO}}",
  "",
  "assignments:",
  "{{ASSIGNMENTS_JSON}}",
].join("\n");

export function renderSchoolsyncProcessingUserPrompt(
  vars: SchoolsyncProcessingPromptVars,
): string {
  return SCHOOLSYNC_PROCESSING_USER_TEMPLATE
    .replace("{{TODAY_ISO}}", vars.todayIso)
    .replace("{{ASSIGNMENTS_JSON}}", vars.assignmentsJson);
}
