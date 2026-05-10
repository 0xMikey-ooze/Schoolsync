import type {
  NewSchoolsyncProcessedRow,
  SchoolsyncProcessedRow,
} from "../db/schema.js";
import type { ProcessedAssignments } from "./schoolsync-types.js";

/**
 * Persistence contract for the Schoolsync processing pipeline.
 *
 * The pipeline only needs two operations: look up by (userId, inputHash) for
 * dedup, and insert a fresh row after a successful LLM call. Concrete impls:
 *   - createDrizzleProcessedStore(db): the production path using
 *     server/db/schema.ts. Owned by t5/migrations work — adding the live DB
 *     factory is intentionally out of scope here so this team does not cross
 *     the schema/migrations forbidden path.
 *   - createInMemoryProcessedStore(): used by the fixture test in
 *     scripts/process-schoolsync-fixture-test.ts.
 */
export interface ProcessedStore {
  findByHash(args: {
    userId: string;
    inputHash: string;
  }): Promise<SchoolsyncProcessedRow | null>;
  insert(row: NewSchoolsyncProcessedRow): Promise<void>;
}

/** In-memory store for tests. Not exported as a default because tests should
 *  construct it explicitly so production callers can't accidentally use it. */
export function createInMemoryProcessedStore(): ProcessedStore & {
  rows: SchoolsyncProcessedRow[];
} {
  const rows: SchoolsyncProcessedRow[] = [];
  return {
    rows,
    async findByHash({ userId, inputHash }) {
      return (
        rows.find(
          (r) => r.userId === userId && r.inputHash === inputHash,
        ) ?? null
      );
    },
    async insert(row) {
      rows.push({
        userId: row.userId,
        inputHash: row.inputHash,
        outputJson: row.outputJson as ProcessedAssignments,
        processedAt: row.processedAt ?? new Date(),
      } as SchoolsyncProcessedRow);
    },
  };
}
