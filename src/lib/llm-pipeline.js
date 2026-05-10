/**
 * SchoolSync LLM Pipeline
 *
 * Categorizes assignments by subject, flags overdue items, and produces a
 * short deadline summary. The shape is stable so downstream tests, the
 * dashboard UI, and any cache layer can rely on it without re-derivation.
 *
 * Public contract:
 *   processAssignments(assignments, options?) -> ProcessedResult
 *
 * Input:
 *   assignments: Array<RawAssignment>
 *     - id?: string
 *     - title: string
 *     - course?: string
 *     - description?: string
 *     - dueDate: string | number | Date  (ISO/epoch/Date)
 *     - status?: string                  ('submitted' | 'graded' | 'missing' | ...)
 *
 * Output (ProcessedResult):
 *   - items: Array<ProcessedAssignment>   // input items + { subject, overdue, dueAt }
 *   - bySubject: Record<string, ProcessedAssignment[]>  // subject groupings map
 *   - overdue: ProcessedAssignment[]      // convenience: filtered overdue items
 *   - deadlineSummary: string             // human-readable deadline summary
 *   - generatedAt: string                 // ISO timestamp at processing time
 *
 * The default implementation is a deterministic stub so tests (and the
 * extension) can run offline without API keys. A real LLM call can be wired
 * in via options.classifier without changing the output shape.
 */

/**
 * @typedef {Object} RawAssignment
 * @property {string} [id]
 * @property {string} title
 * @property {string} [course]
 * @property {string} [description]
 * @property {string|number|Date} dueDate
 * @property {string} [status]
 */

/**
 * @typedef {RawAssignment & {
 *   subject: string,
 *   overdue: boolean,
 *   dueAt: string | null
 * }} ProcessedAssignment
 */

/**
 * @typedef {Object} ProcessedResult
 * @property {ProcessedAssignment[]} items
 * @property {Record<string, ProcessedAssignment[]>} bySubject
 * @property {ProcessedAssignment[]} overdue
 * @property {string} deadlineSummary
 * @property {string} generatedAt
 */

// Subject keyword map. Order matters only when a title hits multiple buckets;
// the first matching subject wins. Kept small and obvious so a maintainer can
// extend it without re-reading the code.
const SUBJECT_KEYWORDS = [
  ['Math', ['math', 'algebra', 'geometry', 'calculus', 'trig', 'statistics', 'precalc']],
  ['Science', ['science', 'biology', 'chemistry', 'physics', 'lab', 'anatomy']],
  ['English', ['english', 'literature', 'essay', 'reading', 'writing', 'grammar', 'novel', 'poetry']],
  ['History', ['history', 'social studies', 'government', 'civics', 'economics', 'geography']],
  ['Language', ['spanish', 'french', 'german', 'mandarin', 'latin', 'language']],
  ['Art', ['art', 'drawing', 'painting', 'sculpture', 'design']],
  ['Music', ['music', 'band', 'orchestra', 'choir']],
  ['PE', ['pe', 'gym', 'physical education', 'athletics', 'fitness']],
  ['Computer Science', ['cs', 'computer science', 'programming', 'coding', 'python', 'java']],
];

const TERMINAL_STATUSES = new Set(['submitted', 'graded', 'complete', 'completed', 'turned in', 'turned-in']);

/**
 * Default deterministic classifier. Maps an assignment to a subject string
 * using a simple keyword match against title + course + description.
 * @param {RawAssignment} a
 * @returns {string}
 */
function defaultClassify(a) {
  const haystack = [a.course, a.title, a.description].filter(Boolean).join(' ').toLowerCase();
  for (const [subject, keywords] of SUBJECT_KEYWORDS) {
    if (keywords.some((kw) => haystack.includes(kw))) return subject;
  }
  return 'Other';
}

/**
 * Parse a due date into a Date or null. Accepts ISO strings, epoch ms, or Date.
 * @param {string|number|Date|undefined|null} value
 * @returns {Date | null}
 */
function parseDue(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a millisecond delta as a short human string ("2d", "3h", "in 5d").
 * @param {number} ms - signed delta (positive = future, negative = past)
 * @returns {string}
 */
function formatDelta(ms) {
  const abs = Math.abs(ms);
  const day = 86_400_000;
  const hour = 3_600_000;
  if (abs >= day) return `${Math.round(abs / day)}d`;
  if (abs >= hour) return `${Math.round(abs / hour)}h`;
  return `${Math.max(1, Math.round(abs / 60_000))}m`;
}

/**
 * Build a one-line deadline summary highlighting overdue counts and the
 * nearest upcoming deadline.
 * @param {ProcessedAssignment[]} items
 * @param {Date} now
 * @returns {string}
 */
function buildDeadlineSummary(items, now) {
  if (items.length === 0) return 'No assignments to summarize.';

  const overdue = items.filter((i) => i.overdue);
  const upcoming = items
    .filter((i) => !i.overdue && i.dueAt)
    .map((i) => ({ item: i, due: new Date(i.dueAt) }))
    .filter((x) => !Number.isNaN(x.due.getTime()) && x.due.getTime() >= now.getTime())
    .sort((a, b) => a.due.getTime() - b.due.getTime());

  const parts = [];
  if (overdue.length > 0) {
    parts.push(`${overdue.length} overdue`);
  }
  if (upcoming.length > 0) {
    const next = upcoming[0];
    const delta = formatDelta(next.due.getTime() - now.getTime());
    parts.push(`next due in ${delta}: "${next.item.title}"`);
  } else if (overdue.length === 0) {
    parts.push('no upcoming deadlines');
  }
  return parts.join('; ') + '.';
}

/**
 * Process raw assignments into a categorized, overdue-flagged structure.
 *
 * @param {RawAssignment[]} assignments
 * @param {Object} [options]
 * @param {Date} [options.now] - override "now" for deterministic tests.
 * @param {(a: RawAssignment) => string} [options.classifier] - optional
 *   override (e.g. real LLM call). Must be synchronous and return a subject
 *   string. For async LLM use, wrap with a pre-pass that mutates inputs.
 * @returns {ProcessedResult}
 */
export function processAssignments(assignments, options = {}) {
  if (!Array.isArray(assignments)) {
    throw new TypeError('processAssignments: assignments must be an array');
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const classify = typeof options.classifier === 'function' ? options.classifier : defaultClassify;

  /** @type {ProcessedAssignment[]} */
  const items = assignments.map((a) => {
    const due = parseDue(a.dueDate);
    const status = (a.status || '').toLowerCase().trim();
    const isTerminal = TERMINAL_STATUSES.has(status);
    // Overdue = has a due date that has passed AND not already submitted/graded.
    const overdue = !!(due && due.getTime() < now.getTime() && !isTerminal);
    const subject = classify(a) || 'Other';
    return {
      ...a,
      subject,
      overdue,
      dueAt: due ? due.toISOString() : null,
    };
  });

  /** @type {Record<string, ProcessedAssignment[]>} */
  const bySubject = {};
  for (const it of items) {
    if (!bySubject[it.subject]) bySubject[it.subject] = [];
    bySubject[it.subject].push(it);
  }

  const overdue = items.filter((i) => i.overdue);
  const deadlineSummary = buildDeadlineSummary(items, now);

  return {
    items,
    bySubject,
    overdue,
    deadlineSummary,
    generatedAt: now.toISOString(),
  };
}

// Named exports for test ergonomics; default export keeps single-import use simple.
export default processAssignments;
