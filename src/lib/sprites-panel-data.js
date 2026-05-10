/**
 * sprites-panel-data.js
 *
 * Lane 4 — UI: SchoolsyncPanel data adapter.
 *
 * The PRD describes a Next.js + tRPC + shadcn/ui dashboard backed by a
 * `getLatestProcessed(userId)` tRPC query and a `schoolsync.refresh` mutation
 * over a SQL `schoolsync_processed` table. Schoolsync is a Chrome MV3
 * extension with no Node server, so this lane mirrors Lanes 1-3 and replaces
 * the tRPC surface with one synchronous data-shaping function callable from
 * the popup, plus one chrome.runtime message handler that exposes it across
 * the service-worker boundary.
 *
 * Contract:
 *   getPanelData({ userId, now? }) -> {
 *     status: 'unauthenticated' | 'empty' | 'ok',
 *     userId: string | null,
 *     lastSyncedAt: string | null,         // ISO timestamp of newest data
 *     lastSyncedSource: 'processed' | 'raw' | null,
 *     categorized: Array<{ subject: string, items: Assignment[] }>,
 *     overdue: Assignment[],
 *     deadlineSummary: string,
 *   }
 *
 * Where Assignment = { id, title, subject, dueDate (ISO) } as produced by
 * sprites-fetcher.js#normalizeAssignments.
 *
 * Data resolution order:
 *   1. processedAssignmentsCache.get(userId).processed_json     (LLM lane)
 *   2. rawAssignmentsCache.get(userId).raw_json.normalized      (polling lane)
 *   3. status='empty' with no items (fresh sign-in, no poll yet)
 *
 * The `processed_json` shape from the LLM lane is the documented
 * ProcessedAssignments schema (`{ categorized: [{subject, items}], overdue,
 * deadlineSummary }`); when present it is returned verbatim. When absent we
 * synthesize an equivalent shape from `normalized[]` using the `subject`
 * field already attached at fetch time and treating `dueDate < now` as
 * overdue. This means the panel renders the moment the polling worker has
 * data, even before the LLM lane has run, which matches the spec's "no
 * silent blank states" requirement.
 */

import { processedAssignmentsCache, rawAssignmentsCache, userSessions } from './sprites-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isAssignmentArray(value) {
  return Array.isArray(value) && value.every(
    (a) => a && typeof a.id === 'string' && typeof a.title === 'string' && typeof a.dueDate === 'string',
  );
}

/**
 * Group an assignments array by subject. Preserves first-seen subject order
 * so render output is stable across identical inputs.
 */
function groupBySubject(assignments) {
  const order = [];
  const map = new Map();
  for (const a of assignments) {
    const subject = a.subject || 'Unknown';
    if (!map.has(subject)) {
      map.set(subject, []);
      order.push(subject);
    }
    map.get(subject).push(a);
  }
  return order.map((subject) => ({ subject, items: map.get(subject) }));
}

function partitionOverdue(assignments, now) {
  const overdue = [];
  const upcoming = [];
  for (const a of assignments) {
    const due = Date.parse(a.dueDate);
    if (Number.isFinite(due) && due < now) overdue.push(a);
    else upcoming.push(a);
  }
  return { overdue, upcoming };
}

function summarizeDeadlines(upcoming, overdue, now) {
  if (overdue.length === 0 && upcoming.length === 0) {
    return 'No assignments on file.';
  }
  const weekHorizon = now + 7 * DAY_MS;
  const dueThisWeek = upcoming.filter((a) => Date.parse(a.dueDate) < weekHorizon).length;
  const parts = [];
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  if (dueThisWeek) parts.push(`${dueThisWeek} due this week`);
  if (!parts.length) parts.push(`${upcoming.length} upcoming`);
  return parts.join(', ') + '.';
}

/**
 * Validate a ProcessedAssignments-shaped object from the LLM lane. Returns
 * the object unchanged when it conforms, or null when it does not (so the
 * caller can fall back to the normalized[] path).
 */
function coerceProcessed(processed_json) {
  if (!processed_json || typeof processed_json !== 'object') return null;
  const { categorized, overdue, deadlineSummary } = processed_json;
  if (!Array.isArray(categorized)) return null;
  if (!Array.isArray(overdue)) return null;
  if (typeof deadlineSummary !== 'string') return null;
  for (const group of categorized) {
    if (!group || typeof group.subject !== 'string') return null;
    if (!isAssignmentArray(group.items)) return null;
  }
  if (!isAssignmentArray(overdue)) return null;
  return { categorized, overdue, deadlineSummary };
}

/**
 * Resolve the active sprites user_id. The popup currently supports a single
 * signed-in user — return the first session in the index, or null.
 */
export async function resolveActiveUserId() {
  const sessions = await userSessions.all();
  if (sessions.length === 0) return null;
  return sessions[0].user_id;
}

/**
 * Build the SchoolsyncPanel render state for a given user_id. The returned
 * object never throws on missing data — callers render based on `status`.
 */
export async function getPanelData({ userId, now } = {}) {
  const ts = Number.isFinite(now) ? now : Date.now();
  if (!userId) {
    return {
      status: 'unauthenticated',
      userId: null,
      lastSyncedAt: null,
      lastSyncedSource: null,
      categorized: [],
      overdue: [],
      deadlineSummary: '',
    };
  }

  const processedRow = await processedAssignmentsCache.get(userId);
  if (processedRow) {
    const shaped = coerceProcessed(processedRow.processed_json);
    if (shaped) {
      return {
        status: 'ok',
        userId,
        lastSyncedAt: new Date(processedRow.processed_at).toISOString(),
        lastSyncedSource: 'processed',
        categorized: shaped.categorized,
        overdue: shaped.overdue,
        deadlineSummary: shaped.deadlineSummary,
      };
    }
    // Malformed processed row falls through to raw — better partial render
    // than a blank state. We do not delete the row; the LLM lane owns it.
  }

  const rawRow = await rawAssignmentsCache.get(userId);
  if (rawRow) {
    const normalized = Array.isArray(rawRow.raw_json?.normalized)
      ? rawRow.raw_json.normalized
      : [];
    const valid = normalized.filter(
      (a) => a && typeof a.id === 'string' && typeof a.title === 'string' && typeof a.dueDate === 'string',
    );
    const { overdue, upcoming } = partitionOverdue(valid, ts);
    return {
      status: valid.length === 0 ? 'empty' : 'ok',
      userId,
      lastSyncedAt: new Date(rawRow.fetched_at).toISOString(),
      lastSyncedSource: 'raw',
      categorized: groupBySubject(upcoming),
      overdue,
      deadlineSummary: summarizeDeadlines(upcoming, overdue, ts),
    };
  }

  return {
    status: 'empty',
    userId,
    lastSyncedAt: null,
    lastSyncedSource: null,
    categorized: [],
    overdue: [],
    deadlineSummary: 'No assignments synced yet. Try Refresh.',
  };
}

/**
 * Format a Date.now() ms timestamp delta as the "Last synced: X min ago"
 * string the spec requires. Pure function so the popup can re-render on a
 * 30s timer without re-fetching.
 */
export function formatLastSynced(lastSyncedAtIso, nowMs) {
  if (!lastSyncedAtIso) return 'Never synced';
  const then = Date.parse(lastSyncedAtIso);
  if (!Number.isFinite(then)) return 'Never synced';
  const deltaMs = Math.max(0, nowMs - then);
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'Last synced: just now';
  if (mins < 60) return `Last synced: ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last synced: ${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `Last synced: ${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * SPRITES_GET_PANEL_DATA  (no HTTP equivalent — replaces the PRD's
 *   `getLatestProcessed(userId)` tRPC query)
 *   payload: { user_id? }   — when omitted, resolves to the active session
 *   reply:   { ok: true, data: <getPanelData return> } | { ok: false, error }
 *
 * The popup talks to the service worker via this message so the data layer
 * stays inside the worker's module graph (matches Lane 3's pattern).
 */
export function attachPanelHandlers(runtime = globalThis.chrome?.runtime) {
  if (!runtime?.onMessage?.addListener) {
    throw new Error('attachPanelHandlers: chrome.runtime unavailable');
  }
  runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'SPRITES_GET_PANEL_DATA') return undefined;
    (async () => {
      const userId = msg.user_id || (await resolveActiveUserId());
      const data = await getPanelData({ userId });
      return { ok: true, data };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
}

export const __internals = {
  groupBySubject,
  partitionOverdue,
  summarizeDeadlines,
  coerceProcessed,
};
