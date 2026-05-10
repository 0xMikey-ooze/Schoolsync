import { z } from "zod";

/**
 * Placeholder for the raw payload that t2 (Data Ingestion) will fetch from
 * Schoolsync/sprites.dev. The shape below is the minimum surface t3/t4 rely on
 * for normalization. t2 should update this file once the real payload is
 * confirmed. Keep additive-only changes here so consumers stay backward
 * compatible.
 */
export interface RawSchoolsyncPayload {
  fetchedAt: string; // ISO timestamp of the fetch
  source: string; // sprites.dev source identifier (e.g. "schoolsync.v1")
  assignments: RawSchoolsyncAssignment[];
}

export interface RawSchoolsyncAssignment {
  id: string;
  title: string;
  subject?: string;
  course?: string; // some SISes label this "course" instead of "subject"
  due?: string; // ISO due date; t2 will normalize variants here
  dueDate?: string;
  description?: string;
  url?: string;
  // Extra fields from the source — preserved verbatim for traceability.
  [extra: string]: unknown;
}

/**
 * Normalized assignment shape used by the LLM pipeline and DB persistence.
 * `due_date` is always an ISO-8601 string after normalization.
 */
export const AssignmentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subject: z.string().min(1),
  due_date: z.string().min(1), // ISO-8601, validated as parseable below
  description: z.string().optional(),
  url: z.string().url().optional(),
  source: z.string().optional(), // upstream source label from RawSchoolsyncPayload
}).refine(
  (a) => !Number.isNaN(Date.parse(a.due_date)),
  { message: "due_date must be a parseable ISO-8601 string", path: ["due_date"] },
);

export type Assignment = z.infer<typeof AssignmentSchema>;

/**
 * Output schema the LLM is asked to emit. Mirrors the four pipeline outputs:
 * subject grouping, priority sort, overdue flagging, and a short summary.
 */
export const ProcessedAssignmentsSchema = z.object({
  categorized: z.array(
    z.object({
      subject: z.string().min(1),
      assignments: z.array(AssignmentSchema),
    }),
  ),
  prioritized: z.array(AssignmentSchema),
  overdue: z.array(AssignmentSchema),
  deadlineSummary: z.string().min(1),
});

export type ProcessedAssignments = z.infer<typeof ProcessedAssignmentsSchema>;
