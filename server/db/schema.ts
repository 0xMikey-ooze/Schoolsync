import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Persisted output of the LLM pipeline for a single processing run.
 *
 * - `output_json` stores a ProcessedAssignments object verbatim (validated by
 *   the Zod schema in server/orchestrator/schoolsync-types.ts before insert).
 * - `input_hash` is the sha256 hex digest of the canonicalized raw input
 *   payload. t4 uses (user_id, input_hash) for dedup so we don't re-spend on
 *   identical input within a polling window.
 */
export const schoolsyncProcessed = pgTable(
  "schoolsync_processed",
  {
    userId: text("user_id").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    outputJson: jsonb("output_json").notNull(),
    inputHash: text("input_hash").notNull(), // sha256 hex (64 chars)
  },
  (t) => ({
    userInputHashIdx: uniqueIndex("schoolsync_processed_user_hash_idx").on(
      t.userId,
      t.inputHash,
    ),
  }),
);

export type SchoolsyncProcessedRow = typeof schoolsyncProcessed.$inferSelect;
export type NewSchoolsyncProcessedRow = typeof schoolsyncProcessed.$inferInsert;
