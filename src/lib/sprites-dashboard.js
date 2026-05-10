/**
 * sprites-dashboard.js
 *
 * Lane 6 — Dashboard UI logic.
 *
 * Pure (DOM-free) helpers that the dashboard page composes:
 *   - sortCategories     : returns categories sorted by subject, with each
 *                          assignments[] re-sorted by (priorityRank, dueDate).
 *   - relativeTime       : "Last updated 3 min ago" style string.
 *   - PRIORITY_RANK      : map "high"|"medium"|"low" -> 0|1|2 for stable sort.
 *
 * Plus thin chrome.runtime wrappers that contract-bind to Lane 4's handlers:
 *   - fetchProcessed     : SPRITES_GET_PROCESSED_ASSIGNMENTS (≡ GET /api/assignments/processed)
 *   - refreshAndFetch    : SPRITES_REFRESH_AND_PROCESS       (≡ POST /api/refresh + re-fetch)
 *
 * The DOM render entry point (renderDashboard) takes a plain root element
 * plus a state object so it stays trivially testable in node with a JSDOM
 * stub or by inspecting the produced innerHTML when run in browser/test.
 *
 * Contract for the processed payload (Lane 4 schema, see sprites-llm.js):
 *   {
 *     categories: [
 *       { subject: string,
 *         assignments: [
 *           { title: string, dueDate: ISO8601, overdue: boolean,
 *             priority: "high"|"medium"|"low" }
 *         ]
 *       }
 *     ],
 *     deadlineSummary: string,
 *     fetchedAt: ISO8601
 *   }
 */

export const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2 });

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Compose ordering: overdue items first, then priority rank ascending
 * (high before low), then earliest dueDate first. Ties collapse to title
 * for a stable, deterministic UI.
 */
function compareAssignments(a, b) {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const ra = PRIORITY_RANK[a.priority] ?? 99;
  const rb = PRIORITY_RANK[b.priority] ?? 99;
  if (ra !== rb) return ra - rb;
  const da = Date.parse(a.dueDate);
  const db = Date.parse(b.dueDate);
  if (da !== db) return da - db;
  return String(a.title).localeCompare(String(b.title));
}

/**
 * Returns a new array — does not mutate the input. Subjects sort
 * alphabetically so tabs/accordions render in a stable order across
 * refreshes.
 */
export function sortCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .slice()
    .sort((a, b) => String(a.subject).localeCompare(String(b.subject)))
    .map((cat) => ({
      ...cat,
      assignments: Array.isArray(cat.assignments)
        ? cat.assignments.slice().sort(compareAssignments)
        : [],
    }));
}

/**
 * "Last updated X ago" — kept loose so the dashboard footer can re-render
 * on a 30-second tick without worrying about per-second pluralization.
 */
export function relativeTime(fromIso, now = Date.now()) {
  if (!fromIso) return 'never';
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return 'never';
  const diff = now - t;
  if (diff < 30_000) return 'just now';
  if (diff < MS_PER_HOUR) {
    const m = Math.round(diff / MS_PER_MIN);
    return `${m} min ago`;
  }
  if (diff < MS_PER_DAY) {
    const h = Math.round(diff / MS_PER_HOUR);
    return `${h} hr ago`;
  }
  const d = Math.round(diff / MS_PER_DAY);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/* ---------- chrome.runtime contract wrappers ---------- */

function sendMessage(message) {
  // Wrap chrome.runtime.sendMessage in a Promise; service workers in MV3
  // already return a Promise when a callback is omitted, but Lane 4's
  // handler set is consistent with the older callback shape we've used
  // elsewhere in the codebase, so support both.
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) {
    return Promise.reject(new Error('chrome.runtime.sendMessage unavailable'));
  }
  return new Promise((resolve, reject) => {
    try {
      const maybe = runtime.sendMessage(message, (reply) => {
        const err = runtime.lastError;
        if (err) return reject(new Error(err.message || String(err)));
        resolve(reply);
      });
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * GET /api/assignments/processed (mapped to SPRITES_GET_PROCESSED_ASSIGNMENTS).
 * Resolves with { ok, processed, source, error? } shape from Lane 4.
 */
export async function fetchProcessed(userId, sender = sendMessage) {
  if (!userId) throw new Error('fetchProcessed: userId is required');
  return sender({ type: 'SPRITES_GET_PROCESSED_ASSIGNMENTS', user_id: userId });
}

/**
 * POST /api/refresh chained with LLM (mapped to SPRITES_REFRESH_AND_PROCESS).
 * Resolves with { ok, refresh, processed?, error? }.
 */
export async function refreshAndFetch(userId, sender = sendMessage) {
  if (!userId) throw new Error('refreshAndFetch: userId is required');
  return sender({ type: 'SPRITES_REFRESH_AND_PROCESS', user_id: userId });
}

/* ---------- DOM rendering ---------- */

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return node;
}

function formatDueDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Renders the entire dashboard into `root`. The view is recomputed on every
 * call (declarative — no diffing) because a Chrome extension popup/tab page
 * is small enough that tearing matters less than render-path simplicity.
 *
 * State shape:
 *   {
 *     loading:   boolean      // refresh in flight
 *     error:     string|null  // last error message
 *     processed: { categories, deadlineSummary, fetchedAt } | null
 *     now:       number       // Date.now() at render time, for relativeTime()
 *     onRefresh: () => void   // click handler for the refresh button
 *     onRetry:   () => void   // click handler for the error retry button
 *   }
 */
export function renderDashboard(root, state) {
  const doc = root.ownerDocument || globalThis.document;
  root.innerHTML = '';

  const header = el(doc, 'header', { class: 'sprites-dashboard__header' }, [
    el(doc, 'h1', { class: 'sprites-dashboard__title' }, ['Schoolsync Assignments']),
    el(
      doc,
      'button',
      {
        type: 'button',
        class: 'sprites-dashboard__refresh',
        'data-testid': 'refresh-button',
        ...(state.loading ? { disabled: 'disabled' } : {}),
        onClick: state.onRefresh || (() => {}),
      },
      [
        state.loading
          ? el(doc, 'span', {
              class: 'sprites-dashboard__spinner',
              'data-testid': 'refresh-spinner',
              'aria-label': 'Refreshing',
            })
          : null,
        state.loading ? 'Refreshing…' : 'Refresh',
      ],
    ),
  ]);
  root.appendChild(header);

  // Banner: deadline summary (only when we have processed data).
  const summaryText = state.processed?.deadlineSummary || '';
  if (summaryText) {
    root.appendChild(
      el(
        doc,
        'div',
        {
          class: 'sprites-dashboard__summary',
          role: 'status',
          'data-testid': 'deadline-summary',
        },
        [summaryText],
      ),
    );
  }

  // Error state.
  if (state.error) {
    root.appendChild(
      el(doc, 'div', { class: 'sprites-dashboard__error', 'data-testid': 'error-state' }, [
        el(doc, 'p', {}, [state.error]),
        el(
          doc,
          'button',
          {
            type: 'button',
            'data-testid': 'retry-button',
            onClick: state.onRetry || state.onRefresh || (() => {}),
          },
          ['Retry'],
        ),
      ]),
    );
  }

  const sections = sortCategories(state.processed?.categories || []);

  // Empty state — only meaningful once we have a processed reply with no items.
  if (!state.error && state.processed && sections.length === 0) {
    root.appendChild(
      el(doc, 'div', { class: 'sprites-dashboard__empty', 'data-testid': 'empty-state' }, [
        'No assignments found',
      ]),
    );
  }

  // Subject sections (accordion via <details>/<summary> for keyboard a11y).
  const main = el(doc, 'main', { class: 'sprites-dashboard__main' }, []);
  for (const cat of sections) {
    const details = el(
      doc,
      'details',
      {
        class: 'sprites-dashboard__subject',
        'data-testid': 'subject-section',
        'data-subject': cat.subject,
        open: 'open',
      },
      [
        el(doc, 'summary', { class: 'sprites-dashboard__subject-summary' }, [
          el(doc, 'span', { class: 'sprites-dashboard__subject-name' }, [cat.subject]),
          el(doc, 'span', { class: 'sprites-dashboard__subject-count' }, [
            `${cat.assignments.length} item${cat.assignments.length === 1 ? '' : 's'}`,
          ]),
        ]),
      ],
    );
    const list = el(doc, 'ul', { class: 'sprites-dashboard__assignments' }, []);
    for (const a of cat.assignments) {
      const overdueClass = a.overdue ? ' sprites-dashboard__row--overdue' : '';
      const row = el(
        doc,
        'li',
        {
          class: `sprites-dashboard__row sprites-dashboard__row--${a.priority}${overdueClass}`,
          'data-testid': 'assignment-row',
          'data-overdue': a.overdue ? 'true' : 'false',
          'data-priority': a.priority,
        },
        [
          el(doc, 'span', { class: 'sprites-dashboard__row-title' }, [a.title]),
          el(doc, 'span', { class: 'sprites-dashboard__row-due' }, [
            (a.overdue ? 'Overdue · ' : 'Due ') + formatDueDate(a.dueDate),
          ]),
          a.overdue
            ? el(
                doc,
                'span',
                {
                  class: 'sprites-dashboard__badge sprites-dashboard__badge--overdue',
                  'data-testid': 'overdue-badge',
                },
                ['OVERDUE'],
              )
            : null,
        ],
      );
      list.appendChild(row);
    }
    details.appendChild(list);
    main.appendChild(details);
  }
  root.appendChild(main);

  // Footer — fetchedAt timestamp must always be visible when present so
  // the operator can never confuse stale cache for fresh data.
  const footer = el(doc, 'footer', { class: 'sprites-dashboard__footer' }, [
    el(doc, 'span', { 'data-testid': 'fetched-at' }, [
      state.processed?.fetchedAt
        ? `Last updated ${relativeTime(state.processed.fetchedAt, state.now || Date.now())}`
        : 'Never updated',
    ]),
  ]);
  root.appendChild(footer);
}
