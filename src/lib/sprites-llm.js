/**
 * sprites-llm.js
 *
 * Lane 4 — LLM Processing Pipeline. Takes the normalized assignments produced
 * by Lane 3's polling worker and asks Anthropic's `claude-sonnet-4-6` to
 *   1. group assignments by subject,
 *   2. sort each group by dueDate ascending,
 *   3. mark items overdue when dueDate < injected today,
 *   4. write a single deadlineSummary string,
 *   5. emit only valid JSON matching the schema below.
 *
 * The PRD describes a `GET /api/assignments/processed` endpoint and a
 * `POST /api/refresh` hook. SchoolSync is a Chrome MV3 extension with no
 * server, so — mirroring Lane 2/3 — those routes are realised as
 * chrome.runtime message handlers:
 *
 *   SPRITES_GET_PROCESSED_ASSIGNMENTS  (≡ GET  /api/assignments/processed)
 *     payload: { user_id }
 *     reply:   { ok, processed: ProcessedAssignments | null, source: 'cache'|'llm', error? }
 *
 *   SPRITES_REFRESH_AND_PROCESS        (≡ POST /api/refresh chained with LLM)
 *     payload: { user_id }
 *     reply:   { ok, refresh, processed?, error? }
 *
 * Design choices for a service-worker context (no npm deps available):
 *   - Anthropic is called via direct fetch to api.anthropic.com/v1/messages.
 *     This avoids adding @anthropic-ai/sdk + a bundler. The Messages API is
 *     stable; we pin model 'claude-sonnet-4-6' per task spec.
 *   - JSON schema is enforced by (a) a strict system-prompt instruction and
 *     (b) a hand-rolled validator (validateProcessed). No zod/ajv runtime.
 *   - Malformed model output triggers exactly one retry with a stricter
 *     "you returned invalid JSON" reminder, then we log + throw.
 *   - The processed cache row is keyed on the raw row's data_hash; we never
 *     re-call the model when the source hash matches.
 *
 * Forbidden paths avoided:
 *   - sprites-store.js / schema authority: not modified. processedAssignmentsCache
 *     was defined in Lane 1 with the exact required columns; we only consume it.
 *   - migrations: untouched.
 *   - secrets: ANTHROPIC_API_KEY is provisioned at install time via
 *     setLLMConfig({ apiKey }) and stored in chrome.storage.local under a
 *     dedicated key — never read from process.env, never logged, never echoed
 *     back through message replies.
 */

import {
  rawAssignmentsCache,
  processedAssignmentsCache,
} from './sprites-store.js';

const LLM_CONFIG_KEY = 'sprites:llm_config';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 2048;

/* ---------- operator-provisioned LLM config ---------- */

function storage() {
  return globalThis.chrome?.storage?.local;
}

/**
 * Persist the LLM API config. Required:
 *   apiKey  string  ANTHROPIC_API_KEY (operator provides at install time)
 * Optional:
 *   model       string  defaults to 'claude-sonnet-4-6'
 *   maxTokens   number  defaults to 2048
 */
export async function setLLMConfig(config) {
  if (!config?.apiKey) {
    throw new Error('llm config: apiKey is required');
  }
  await storage().set({
    [LLM_CONFIG_KEY]: {
      apiKey: String(config.apiKey),
      model: config.model || DEFAULT_MODEL,
      maxTokens: Number.isFinite(config.maxTokens) ? Number(config.maxTokens) : DEFAULT_MAX_TOKENS,
    },
  });
}

export async function getLLMConfig() {
  const out = (await storage().get(LLM_CONFIG_KEY)) || {};
  return out[LLM_CONFIG_KEY] || null;
}

async function requireLLMConfig() {
  const c = await getLLMConfig();
  if (!c?.apiKey) {
    throw new Error(
      'llm config missing — call setLLMConfig({ apiKey }) with ANTHROPIC_API_KEY before processing.',
    );
  }
  return c;
}

/* ---------- prompt rendering ---------- */

/** YYYY-MM-DD for the host's local day. We compare on a calendar-day basis,
 *  not millisecond, so an assignment due "today" is not flagged overdue. */
export function todayIso(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Build the system prompt. The schema is repeated inline so the model has no
 * room to invent extra fields, and `today` is injected explicitly so overdue
 * detection is deterministic regardless of model timezone assumptions.
 */
export function buildSystemPrompt(today) {
  return [
    'You are a focused assistant that transforms a flat list of student',
    'assignments into a categorized JSON document. Today\'s date is ' + today + '.',
    '',
    'You must:',
    '  1. Group assignments by subject (one category per distinct subject).',
    '  2. Within each category, sort assignments by dueDate ascending (ISO8601).',
    '  3. Set "overdue": true when an assignment\'s dueDate is strictly before today (' + today + ').',
    '  4. Set "priority" to one of "high" | "medium" | "low" based on proximity to today and overdue status.',
    '  5. Produce a single concise "deadlineSummary" string (e.g. "3 assignments due this week; Math quiz overdue").',
    '',
    'Output schema (return ONLY valid JSON matching this shape — no prose, no markdown fences):',
    '{',
    '  "categories": [',
    '    {',
    '      "subject": string,',
    '      "assignments": [',
    '        { "title": string, "dueDate": string, "overdue": boolean, "priority": "high"|"medium"|"low" }',
    '      ]',
    '    }',
    '  ],',
    '  "deadlineSummary": string,',
    '  "fetchedAt": string  // ISO8601 timestamp of when the raw data was fetched',
    '}',
    '',
    'If the input list is empty, return categories: [], deadlineSummary: "No upcoming assignments.", and the supplied fetchedAt.',
    'Return ONLY the JSON object. No explanation. No code fences.',
  ].join('\n');
}

/** User message: pure data payload for the model. */
export function buildUserPrompt(normalized, fetchedAt) {
  return JSON.stringify({ assignments: normalized, fetchedAt }, null, 2);
}

/* ---------- output validation ---------- */

const PRIORITY_VALUES = new Set(['high', 'medium', 'low']);

/**
 * Hand-rolled validator. Returns { ok: true, value } on success, otherwise
 * { ok: false, error } with the first violation. We surface the path so log
 * lines stay actionable when the model misbehaves.
 */
export function validateProcessed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'root: expected object' };
  }
  if (!Array.isArray(value.categories)) {
    return { ok: false, error: 'categories: expected array' };
  }
  for (let i = 0; i < value.categories.length; i++) {
    const cat = value.categories[i];
    if (!cat || typeof cat !== 'object') {
      return { ok: false, error: `categories[${i}]: expected object` };
    }
    if (typeof cat.subject !== 'string' || cat.subject.trim() === '') {
      return { ok: false, error: `categories[${i}].subject: expected non-empty string` };
    }
    if (!Array.isArray(cat.assignments)) {
      return { ok: false, error: `categories[${i}].assignments: expected array` };
    }
    for (let j = 0; j < cat.assignments.length; j++) {
      const a = cat.assignments[j];
      const path = `categories[${i}].assignments[${j}]`;
      if (!a || typeof a !== 'object') return { ok: false, error: `${path}: expected object` };
      if (typeof a.title !== 'string' || a.title === '') {
        return { ok: false, error: `${path}.title: expected non-empty string` };
      }
      if (typeof a.dueDate !== 'string' || Number.isNaN(Date.parse(a.dueDate))) {
        return { ok: false, error: `${path}.dueDate: expected ISO8601 string` };
      }
      if (typeof a.overdue !== 'boolean') {
        return { ok: false, error: `${path}.overdue: expected boolean` };
      }
      if (typeof a.priority !== 'string' || !PRIORITY_VALUES.has(a.priority)) {
        return { ok: false, error: `${path}.priority: expected one of high|medium|low` };
      }
    }
  }
  if (typeof value.deadlineSummary !== 'string' || value.deadlineSummary.trim() === '') {
    return { ok: false, error: 'deadlineSummary: expected non-empty string' };
  }
  if (typeof value.fetchedAt !== 'string' || Number.isNaN(Date.parse(value.fetchedAt))) {
    return { ok: false, error: 'fetchedAt: expected ISO8601 string' };
  }
  return { ok: true, value };
}

/* ---------- Anthropic Messages API call ---------- */

/**
 * Extract the JSON payload from an Anthropic Messages API response. Tolerates
 * a single ```json fenced block since some models still emit fences despite
 * being told not to.
 */
function extractJsonFromContent(content) {
  if (!Array.isArray(content)) throw new Error('llm response: content array missing');
  let text = '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  text = text.trim();
  // Strip leading ```json / ``` and trailing ``` if present.
  if (text.startsWith('```')) {
    const firstNl = text.indexOf('\n');
    if (firstNl !== -1) text = text.slice(firstNl + 1);
    if (text.endsWith('```')) text = text.slice(0, -3);
    text = text.trim();
  }
  return JSON.parse(text);
}

/**
 * Call Anthropic Messages API once. Returns the parsed (but UNVALIDATED) JSON
 * the model produced. Network/transport errors throw; HTTP non-2xx throws
 * with the body so the caller can log it. Authentication failure (401/403)
 * is wrapped in a clear error since it indicates ANTHROPIC_API_KEY is wrong
 * — not a per-user reauth flow.
 */
export async function callAnthropic({
  apiKey,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  system,
  userMessages,
  fetchImpl,
  url = ANTHROPIC_URL,
}) {
  const fetchFn = fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!fetchFn) throw new Error('callAnthropic: fetch is unavailable');
  if (!apiKey) throw new Error('callAnthropic: apiKey required');

  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: userMessages,
    }),
  });

  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`anthropic ${resp.status}: ${body.slice(0, 300)}`);
  }
  const json = await resp.json();
  return extractJsonFromContent(json?.content);
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

/* ---------- main pipeline: process one user ---------- */

/**
 * Run normalize-aware LLM processing for a single user.
 *
 * Decision tree:
 *   1. Read raw_assignments_cache row. If missing -> { ok: false, reason: 'no-raw' }.
 *   2. Read processed_assignments_cache row. If source_hash === raw.data_hash
 *      AND no force flag -> return cached, source: 'cache'.
 *   3. Else: build prompt, call LLM, validate output, retry once on
 *      malformed output (with a "you returned invalid JSON" reminder), then
 *      persist + return source: 'llm'.
 *
 * Errors during the LLM call (transport / persistent invalid output) are
 * logged with `[sprites-llm]` prefix and re-thrown so message handlers can
 * report `{ ok: false, error }` without crashing the worker.
 *
 * @param {string} user_id
 * @param {{
 *   force?: boolean,
 *   now?: number,
 *   fetchImpl?: typeof fetch,
 *   llmClient?: (args: { system: string, userMessages: any[] }) => Promise<unknown>,
 *   log?: { info?: Function, warn?: Function, error?: Function },
 * }} [opts]
 * @returns {Promise<{ ok: true, processed: object, source: 'cache'|'llm' } | { ok: false, reason: string }>}
 */
export async function processUserAssignments(user_id, opts = {}) {
  if (!user_id) throw new Error('processUserAssignments: user_id required');
  const log = opts.log || console;
  const now = opts.now ?? Date.now();

  const raw = await rawAssignmentsCache.get(user_id);
  if (!raw) {
    return { ok: false, reason: 'no-raw' };
  }

  const cached = await processedAssignmentsCache.get(user_id);
  if (!opts.force && cached && cached.source_hash === raw.data_hash) {
    log.info?.(`[sprites-llm] user=${user_id} cache-hit hash=${raw.data_hash.slice(0, 8)}`);
    return { ok: true, processed: cached.processed_json, source: 'cache' };
  }

  const normalized = raw.raw_json?.normalized || [];
  const fetchedAt = new Date(raw.fetched_at).toISOString();
  const today = todayIso(now);
  const system = buildSystemPrompt(today);
  const userText = buildUserPrompt(normalized, fetchedAt);

  // Allow tests to inject a stubbed client so we never hit the network.
  const callClient = opts.llmClient || (async ({ system: s, userMessages }) => {
    const cfg = await requireLLMConfig();
    return callAnthropic({
      apiKey: cfg.apiKey,
      model: cfg.model || DEFAULT_MODEL,
      maxTokens: cfg.maxTokens || DEFAULT_MAX_TOKENS,
      system: s,
      userMessages,
      fetchImpl: opts.fetchImpl,
    });
  });

  const userMessages = [{ role: 'user', content: userText }];

  let parsed, lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await callClient({ system, userMessages });
      const validation = validateProcessed(out);
      if (validation.ok) {
        parsed = validation.value;
        break;
      }
      lastError = new Error(`schema validation failed: ${validation.error}`);
      log.warn?.(`[sprites-llm] user=${user_id} attempt=${attempt} invalid output: ${validation.error}`);
      // Append a corrective turn for the retry. This mirrors the LLM lessons
      // from the run manifest: keep the original payload visible, but tell
      // the model exactly what was wrong with its prior reply.
      userMessages.push(
        { role: 'assistant', content: typeof out === 'string' ? out : JSON.stringify(out) },
        {
          role: 'user',
          content:
            'Your previous reply did not satisfy the schema (' + validation.error + '). ' +
            'Reply ONLY with valid JSON matching the schema. No prose. No code fences.',
        },
      );
    } catch (err) {
      lastError = err;
      log.warn?.(`[sprites-llm] user=${user_id} attempt=${attempt} error: ${err?.message || err}`);
      // Transport/parse errors also get one retry with the original payload.
      if (attempt === 1) continue;
    }
  }

  if (!parsed) {
    log.error?.(`[sprites-llm] user=${user_id} giving up after retry: ${lastError?.message || lastError}`);
    throw lastError || new Error('llm processing failed');
  }

  // The model is told to echo fetchedAt; defensively overwrite to the source
  // value so the cache row's `processed_json.fetchedAt` always matches the
  // raw row that produced it.
  parsed.fetchedAt = fetchedAt;

  await processedAssignmentsCache.upsert({
    user_id,
    processed_json: parsed,
    source_hash: raw.data_hash,
    processed_at: now,
  });
  log.info?.(`[sprites-llm] user=${user_id} cache-miss fresh hash=${raw.data_hash.slice(0, 8)}`);
  return { ok: true, processed: parsed, source: 'llm' };
}

/* ---------- chained refresh + process (replaces POST /api/refresh hook) ---------- */

/**
 * Run Lane 3's refreshUserAssignments and, if `changed: true`, immediately
 * run the LLM pipeline. We import the refresher lazily so test files can
 * stub it without circular import side-effects at module load time.
 *
 * @param {string} user_id
 * @param {{
 *   refreshFn?: (user_id: string, opts?: any) => Promise<any>,
 *   processFn?: (user_id: string, opts?: any) => Promise<any>,
 * }} [opts]
 */
export async function refreshAndProcess(user_id, opts = {}) {
  const refreshFn = opts.refreshFn || (await import('./sprites-fetcher.js')).refreshUserAssignments;
  const processFn = opts.processFn || processUserAssignments;

  const refresh = await refreshFn(user_id, opts);
  if (!refresh?.ok) {
    return { ok: false, refresh };
  }
  if (!refresh.changed) {
    // Raw is unchanged; serve cached processed if it exists, else run LLM
    // (can happen when a user signs in but has not yet been processed).
    const processed = await processUserAssignments(user_id, opts);
    return { ok: true, refresh, processed };
  }
  const processed = await processFn(user_id, opts);
  return { ok: true, refresh, processed };
}

/* ---------- runtime message handlers ---------- */

/**
 * Bind chrome.runtime.onMessage handlers for the LLM lane. Idempotent only
 * to the extent the runtime allows — call once at service-worker boot.
 */
export function attachLLMHandlers(runtime = globalThis.chrome?.runtime) {
  if (!runtime?.onMessage?.addListener) {
    throw new Error('attachLLMHandlers: chrome.runtime unavailable');
  }
  runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'SPRITES_GET_PROCESSED_ASSIGNMENTS') {
      processUserAssignments(msg.user_id, { force: !!msg.force })
        .then((r) => {
          if (r.ok) sendResponse({ ok: true, processed: r.processed, source: r.source });
          else sendResponse({ ok: false, reason: r.reason });
        })
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    if (msg?.type === 'SPRITES_REFRESH_AND_PROCESS') {
      refreshAndProcess(msg.user_id)
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }
    return undefined;
  });
}

/* ---------- internals exposed for tests ---------- */

export const __internals = {
  LLM_CONFIG_KEY,
  DEFAULT_MODEL,
  ANTHROPIC_URL,
  ANTHROPIC_VERSION,
  extractJsonFromContent,
};
