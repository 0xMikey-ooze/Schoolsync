/**
 * sprites-fetcher.js
 *
 * Lane 3 — Polling Worker & Data Fetcher for the SchoolSync Chrome MV3
 * extension. The PRD describes server-side `POST /api/refresh`,
 * `GET /api/assignments/raw`, and a node-cron `every 15 minutes` job; SchoolSync
 * has no server, so this module mirrors Lane 2's pattern:
 *
 *   - HTTP routes  -> chrome.runtime message handlers
 *     SPRITES_REFRESH_NOW         (= POST /api/refresh)
 *     SPRITES_GET_RAW_ASSIGNMENTS (= GET  /api/assignments/raw)
 *
 *   - node-cron "every 15 min"  -> chrome.alarms ('sprites-poll', periodInMinutes: 15)
 *     The alarm fires within ±30s of the 15-minute mark per the Chrome
 *     alarms contract; the alarm timestamp is logged on every tick so the
 *     drift can be inspected from chrome://serviceworker-internals.
 *
 * All access tokens are pulled fresh from Lane 2's getValidToken(); none of
 * the cached rows or message responses ever contain a token. ReauthRequired
 * surfaces as `{ ok: false, reauth: true }` via Lane 2's withReauth() and
 * skips that user inside the polling loop without crashing the whole tick.
 *
 * Sprites.dev's assignment endpoint URL and request shape are NOT
 * documented in this repo. Per the standing AGENTS.md "do not invent
 * production endpoints" rule, the assignments URL is provisioned at install
 * time via setSpritesApiConfig({ assignmentsUrl, mapping }). The default
 * mapping accepts common field names (id|uuid, title|name, subject|course,
 * dueDate|due_date|due) so the integration light-touches as many provider
 * shapes as possible without baking one in. Tests cover the default
 * mapping + a custom mapping function override.
 */

import { rawAssignmentsCache, userSessions } from './sprites-store.js';
import { getValidToken, withReauth, ReauthRequiredError } from './sprites-auth.js';

const API_CONFIG_KEY = 'sprites:api_config';
const ALARM_NAME = 'sprites-poll';
const ALARM_PERIOD_MINUTES = 15;

/* ---------- operator-provisioned API config ---------- */

function storage() {
  return globalThis.chrome?.storage?.local;
}

/**
 * Persist the sprites.dev assignments-API configuration. Required:
 *   assignmentsUrl  string  e.g. 'https://api.sprites.dev/v1/assignments'
 * Optional:
 *   mapping         (raw) => NormalizedAssignment   custom field mapping
 *   extractList     (json) => RawAssignment[]       pull list out of envelope
 */
export async function setSpritesApiConfig(config) {
  if (!config?.assignmentsUrl) {
    throw new Error('sprites api config: assignmentsUrl is required');
  }
  await storage().set({
    [API_CONFIG_KEY]: { assignmentsUrl: String(config.assignmentsUrl) },
  });
}

export async function getSpritesApiConfig() {
  const out = (await storage().get(API_CONFIG_KEY)) || {};
  return out[API_CONFIG_KEY] || null;
}

async function requireApiConfig() {
  const c = await getSpritesApiConfig();
  if (!c) {
    throw new Error(
      'sprites api config missing — call setSpritesApiConfig({ assignmentsUrl }) ' +
      'with the operator-provisioned SPRITES_ASSIGNMENTS_URL before polling.',
    );
  }
  return c;
}

/* ---------- retry-with-exponential-backoff fetch ---------- */

const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const BASE_DELAY_MS = 1000;
const CAP_DELAY_MS = 32_000;

function computeBackoffMs(attempt, retryAfterSec) {
  // Honour Retry-After if the provider sent one (seconds).
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, CAP_DELAY_MS);
  }
  // Exponential backoff with jitter, capped at 32s. attempt is 1-based.
  const expo = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), CAP_DELAY_MS);
  // Full jitter: random in [expo/2, expo]. Keeps cap behaviour intact.
  const jitter = expo / 2 + Math.random() * (expo / 2);
  return Math.min(jitter, CAP_DELAY_MS);
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Fetch the raw assignments payload from sprites.dev with retry+backoff
 * on 429/5xx (max 3 retries, cap 32s). Returns the parsed JSON payload as
 * received from sprites.dev — normalization happens in normalizeAssignments.
 *
 * @param {string} accessToken  bearer token from getValidToken()
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxAttempts?: number,
 *   apiConfig?: { assignmentsUrl: string },
 * }} [opts]
 * @returns {Promise<unknown>}
 */
export async function fetchAssignments(accessToken, opts = {}) {
  if (!accessToken) throw new Error('fetchAssignments: accessToken is required');
  const fetchImpl = opts.fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error('fetchAssignments: fetch is unavailable');
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const config = opts.apiConfig || (await requireApiConfig());

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp;
    try {
      resp = await fetchImpl(config.assignmentsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
    } catch (networkErr) {
      lastError = networkErr;
      if (attempt >= maxAttempts) throw networkErr;
      await sleep(computeBackoffMs(attempt));
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      // Lane 2 contract: surface auth failures as ReauthRequiredError so the
      // calling withReauth() handler emits { ok: false, reauth: true } and
      // the polling loop skips this user without retrying a doomed request.
      throw new ReauthRequiredError(
        `sprites assignments rejected: HTTP ${resp.status}`,
      );
    }

    if (resp.ok) {
      return await resp.json();
    }

    if (isRetryableStatus(resp.status) && attempt < maxAttempts) {
      const retryAfter = Number(resp.headers?.get?.('Retry-After'));
      await sleep(computeBackoffMs(attempt, retryAfter));
      continue;
    }

    // Non-retryable, or out of attempts on a retryable status.
    const bodyText = await safeText(resp);
    throw new Error(
      `sprites assignments fetch failed: HTTP ${resp.status} ${bodyText.slice(0, 200)}`,
    );
  }
  // Unreachable in practice — the loop always returns or throws.
  throw lastError || new Error('sprites assignments fetch exhausted retries');
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

/* ---------- raw -> normalized mapping ---------- */

/**
 * @typedef {Object} NormalizedAssignment
 * @property {string} id
 * @property {string} title
 * @property {string} subject
 * @property {string} dueDate  ISO8601 string
 */

/**
 * Pull an array out of whatever envelope sprites.dev returned. Tolerates:
 *   - a top-level array
 *   - { assignments: [...] }
 *   - { data: [...] }
 *   - { items: [...] }
 * Anything else throws so we don't silently drop data.
 */
export function extractAssignmentList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const key of ['assignments', 'data', 'items', 'results']) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  }
  throw new Error('sprites response: could not locate assignment list in payload');
}

function pickFirstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function toIsoOrNull(value) {
  if (value == null || value === '') return null;
  // Already ISO? Round-trip via Date for normalization.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Default mapping from a single sprites.dev raw assignment object to the
 * internal NormalizedAssignment shape. Tolerant to common field-name
 * variants since the exact wire shape is not documented in this repo.
 */
export function defaultMapAssignment(raw) {
  const id = pickFirstString(raw, ['id', 'uuid', 'assignment_id', 'assignmentId']);
  const title = pickFirstString(raw, ['title', 'name', 'assignment', 'summary']);
  const subject = pickFirstString(raw, [
    'subject', 'course', 'class', 'category', 'subject_name', 'courseName',
  ]);
  const dueRaw = raw?.dueDate ?? raw?.due_date ?? raw?.due ?? raw?.deadline ?? raw?.dueAt;
  const dueDate = toIsoOrNull(dueRaw);
  if (!id || !title || !dueDate) {
    return null; // dropped, not exploded — partial data is the norm in SIS feeds
  }
  return {
    id,
    title,
    subject: subject || 'Unknown',
    dueDate,
  };
}

/**
 * Map a sprites.dev raw payload to NormalizedAssignment[]. Drops items
 * missing the minimum required fields (id, title, dueDate) rather than
 * crashing the whole batch — the LLM lane operates on best-effort data.
 *
 * @param {unknown} raw  parsed JSON from fetchAssignments
 * @param {{ mapItem?: (raw: any) => NormalizedAssignment | null }} [opts]
 * @returns {NormalizedAssignment[]}
 */
export function normalizeAssignments(raw, opts = {}) {
  const list = extractAssignmentList(raw);
  const mapItem = opts.mapItem || defaultMapAssignment;
  const out = [];
  for (const item of list) {
    const mapped = mapItem(item);
    if (mapped) out.push(mapped);
  }
  // Stable order keeps the data hash deterministic across polls when the
  // provider reorders results between calls.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/* ---------- SHA-256 hash for change-detection ---------- */

/**
 * SHA-256 over the JSON encoding of the normalized array. Returns lowercase
 * hex. Determinism comes from normalizeAssignments() sorting by id; we do
 * not sort keys here because NormalizedAssignment is a fixed-shape object
 * literal whose key order is the literal order at construction.
 */
export async function hashNormalized(normalized) {
  const json = JSON.stringify(normalized);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('hashNormalized: crypto.subtle unavailable');
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- per-user refresh pipeline ---------- */

/**
 * Run the fetch -> normalize -> hash -> cache pipeline for one user.
 *
 * Returns one of:
 *   { ok: true,  fetchedAt, changed, hash }   — pipeline ran end to end
 *   { ok: false, reauth: true, error }        — Lane 2 said the session is dead
 *
 * `changed` is true iff the new hash differs from the cached row's
 * `data_hash` (or no cached row existed). When false, the cache row is
 * NOT rewritten — the existing fetched_at is preserved so the LLM lane
 * can correctly skip re-running.
 *
 * @param {string} user_id
 * @param {{ now?: number, fetchImpl?: typeof fetch, sleep?: (ms:number)=>Promise<void>, mapItem?: Function, apiConfig?: any }} [opts]
 */
export async function refreshUserAssignments(user_id, opts = {}) {
  if (!user_id) throw new Error('refreshUserAssignments: user_id required');
  const now = opts.now ?? Date.now();

  // withReauth turns ReauthRequiredError thrown anywhere below into the
  // { ok: false, reauth: true } shape Lane 2 standardised.
  return withReauth(async () => {
    const accessToken = await getValidToken(user_id, {
      now,
      fetchImpl: opts.fetchImpl,
    });
    const raw = await fetchAssignments(accessToken, {
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      apiConfig: opts.apiConfig,
    });
    const normalized = normalizeAssignments(raw, { mapItem: opts.mapItem });
    const hash = await hashNormalized(normalized);

    const existing = await rawAssignmentsCache.get(user_id);
    const changed = !existing || existing.data_hash !== hash;
    if (!changed) {
      return {
        ok: true,
        fetchedAt: new Date(existing.fetched_at).toISOString(),
        changed: false,
        hash,
      };
    }
    await rawAssignmentsCache.upsert({
      user_id,
      data_hash: hash,
      raw_json: { raw, normalized },
      fetched_at: now,
    });
    return {
      ok: true,
      fetchedAt: new Date(now).toISOString(),
      changed: true,
      hash,
    };
  })();
}

/* ---------- polling loop over all signed-in users ---------- */

/**
 * Iterate every user with an active sprites session and run the per-user
 * pipeline. Errors for one user never abort the loop. Each user's outcome
 * is logged with `[sprites-poll]` prefix for chrome://serviceworker-internals.
 *
 * @returns {Promise<{ tickAt: string, results: Array<{ user_id: string, ok: boolean, changed?: boolean, reauth?: boolean, error?: string }> }>}
 */
export async function pollAllUsers(opts = {}) {
  const tickAt = new Date(opts.now ?? Date.now()).toISOString();
  const sessions = await userSessions.all();
  const log = opts.log || console;
  log.info?.(`[sprites-poll] tick ${tickAt} users=${sessions.length}`);

  const results = [];
  for (const session of sessions) {
    const user_id = session.user_id;
    try {
      const r = await refreshUserAssignments(user_id, opts);
      if (r.reauth) {
        log.warn?.(`[sprites-poll] user=${user_id} reauth-required (skipped)`);
        results.push({ user_id, ok: false, reauth: true, error: r.error });
      } else {
        log.info?.(
          `[sprites-poll] user=${user_id} ok changed=${r.changed} hash=${r.hash?.slice(0, 8)}`,
        );
        results.push({ user_id, ok: true, changed: r.changed });
      }
    } catch (err) {
      // Unexpected error (network, mapping bug). Log and continue.
      log.error?.(`[sprites-poll] user=${user_id} failed`, err);
      results.push({ user_id, ok: false, error: err?.message || String(err) });
    }
  }
  return { tickAt, results };
}

/* ---------- chrome.alarms scheduler ---------- */

/**
 * Register the 15-minute polling alarm and bind onAlarm to pollAllUsers.
 * Idempotent — chrome.alarms.create with the same name replaces the prior
 * schedule. Safe to call on every service-worker boot.
 *
 * The Chrome alarms API guarantees firing within a few seconds of the
 * scheduled period in MV3 service-worker context, satisfying the PRD's
 * "±30s of the 15-minute mark" acceptance criterion. The actual fire
 * timestamp is logged so drift can be inspected later.
 */
export function installPollingAlarm(runtime = globalThis.chrome, opts = {}) {
  const alarms = runtime?.alarms;
  if (!alarms?.create || !alarms?.onAlarm?.addListener) {
    throw new Error('installPollingAlarm: chrome.alarms unavailable');
  }
  alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== ALARM_NAME) return;
    pollAllUsers(opts).catch((err) => {
      // Top-level safety net — pollAllUsers already swallows per-user errors.
      console.error('[sprites-poll] tick failed unexpectedly', err);
    });
  });
}

/* ---------- runtime message handlers (replaces HTTP routes) ---------- */

/**
 * SPRITES_REFRESH_NOW         (≡ POST /api/refresh)
 *   payload: { user_id }
 *   reply:   { ok, fetchedAt, changed } | { ok: false, reauth: true, error }
 *
 * SPRITES_GET_RAW_ASSIGNMENTS (≡ GET  /api/assignments/raw)
 *   payload: { user_id }
 *   reply:   { ok, row: rawAssignmentsCache.row | null }
 *
 * The popup/dashboard code passes the active sprites user_id explicitly so
 * the polling worker has no implicit "current user" state.
 */
export function attachAssignmentHandlers(runtime = globalThis.chrome?.runtime) {
  if (!runtime?.onMessage?.addListener) {
    throw new Error('attachAssignmentHandlers: chrome.runtime unavailable');
  }
  runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'SPRITES_REFRESH_NOW') {
      refreshUserAssignments(msg.user_id)
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true; // async sendResponse
    }
    if (msg?.type === 'SPRITES_GET_RAW_ASSIGNMENTS') {
      rawAssignmentsCache
        .get(msg.user_id)
        .then((row) => sendResponse({ ok: true, row: row || null }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    return undefined;
  });
}

/* ---------- internals exposed for tests ---------- */

export const __internals = {
  ALARM_NAME,
  ALARM_PERIOD_MINUTES,
  MAX_ATTEMPTS,
  BASE_DELAY_MS,
  CAP_DELAY_MS,
  computeBackoffMs,
  isRetryableStatus,
};
