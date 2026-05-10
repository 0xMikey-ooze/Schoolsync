/**
 * sprites-store.js
 *
 * Persistence layer for the sprites.dev OAuth + LLM Assignment Intelligence
 * feature. The PRD calls for three "tables" — `user_sessions`,
 * `raw_assignments_cache`, `processed_assignments_cache`. Schoolsync is a
 * Chrome MV3 extension with no server, so the equivalent of a SQL migration
 * is a versioned chrome.storage.local namespace + ORM-style helpers.
 *
 * Token columns are wrapped with AES-256-GCM using an install-bound key that
 * is generated on first use, stored as JWK in chrome.storage.local, and
 * imported as a non-extractable CryptoKey thereafter. The key never leaves
 * the extension and is rotated only by `resetEncryptionKey()` (used by the
 * rollback migration to ensure no stale ciphertext survives a downgrade).
 *
 * Public surface (consumed by Auth, Polling, and Dashboard lanes):
 *   - migrate(), rollback(), getSchemaVersion()
 *   - userSessions.{upsert, get, delete, all}
 *   - rawAssignmentsCache.{upsert, get, delete, all}
 *   - processedAssignmentsCache.{upsert, get, delete, all}
 *   - encryptColumn / decryptColumn  (exposed for tests + advanced callers)
 *
 * No token or assignment data may be persisted outside this module.
 */

const SCHEMA_VERSION = 1;

// chrome.storage.local key namespaces. We keep one entry per "row" keyed by
// `<table>:<user_id>` so reads/writes are O(1) per user without loading the
// whole table — Chrome storage is fast on point reads, slow on full scans.
const NS = {
  META: 'sprites:meta',                    // { schemaVersion }
  KEY:  'sprites:enc_key_v1',              // wrapped AES-256-GCM JWK
  USER_SESSIONS:   'sprites:user_sessions',          // index of user_ids
  RAW_CACHE:       'sprites:raw_assignments_cache',  // index of user_ids
  PROCESSED_CACHE: 'sprites:processed_assignments_cache',
};

const ROW_PREFIX = {
  USER_SESSIONS:   'sprites:row:user_sessions:',
  RAW_CACHE:       'sprites:row:raw_assignments_cache:',
  PROCESSED_CACHE: 'sprites:row:processed_assignments_cache:',
};

const IV_BYTES = 12;

/* ---------- chrome.storage.local thin wrapper (testable) ---------- */

function storage() {
  // The module is bundled into the MV3 service-worker; chrome.storage.local
  // is always present at runtime. Tests inject a mock by stubbing globalThis.
  return globalThis.chrome.storage.local;
}

async function sget(key) {
  const out = await storage().get(key);
  return out[key];
}

async function sset(key, value) {
  await storage().set({ [key]: value });
}

async function sdel(keys) {
  await storage().remove(keys);
}

/* ---------- install-bound AES-256-GCM key ---------- */

let _cachedKey = null;

/**
 * Get-or-create the install-bound AES-256-GCM CryptoKey. The raw JWK is
 * persisted once in chrome.storage.local; subsequent calls re-import it as
 * a non-extractable key so the raw bytes cannot be exfiltrated by other
 * scripts in the same context.
 *
 * Trade-off vs. user-passphrase (src/lib/crypto.js): sprites OAuth tokens
 * must be readable by an unattended polling alarm, so we cannot prompt for a
 * passphrase. Install-bound storage matches the threat model for an
 * extension whose secrets are already scoped to the browser profile.
 */
async function getEncryptionKey() {
  if (_cachedKey) return _cachedKey;

  const subtle = globalThis.crypto.subtle;
  const existing = await sget(NS.KEY);
  if (existing) {
    _cachedKey = await subtle.importKey(
      'jwk',
      existing,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return _cachedKey;
  }

  // First run — generate, persist as JWK (extractable=true once), then
  // immediately re-import as non-extractable for use.
  const generated = await subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const jwk = await subtle.exportKey('jwk', generated);
  await sset(NS.KEY, jwk);
  _cachedKey = await subtle.importKey(
    'jwk',
    jwk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return _cachedKey;
}

/** Rotate the install-bound key. All previously encrypted columns become
 *  unrecoverable; only call from rollback or explicit user reset. */
export async function resetEncryptionKey() {
  _cachedKey = null;
  await sdel([NS.KEY]);
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Encrypt a single column value. Returns { iv, ct } base64 strings; null
 * passthrough lets callers store nullable refresh_tokens unchanged.
 * @param {string|null} plaintext
 * @returns {Promise<{iv:string, ct:string}|null>}
 */
export async function encryptColumn(plaintext) {
  if (plaintext == null) return null;
  const key = await getEncryptionKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}

/**
 * Decrypt a column value produced by encryptColumn. Returns null when input
 * is null so callers can round-trip nullable columns without branching.
 * @param {{iv:string, ct:string}|null} encrypted
 * @returns {Promise<string|null>}
 */
export async function decryptColumn(encrypted) {
  if (encrypted == null) return null;
  const key = await getEncryptionKey();
  const iv = b64ToBytes(encrypted.iv);
  const ct = b64ToBytes(encrypted.ct);
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ct
  );
  return new TextDecoder().decode(plain);
}

/* ---------- migrations ---------- */

export async function getSchemaVersion() {
  const meta = await sget(NS.META);
  return meta?.schemaVersion ?? 0;
}

/**
 * Forward migration. Idempotent — safe to call on every extension start.
 * Creates the three table indexes if missing and stamps the schema version.
 */
export async function migrate() {
  const current = await getSchemaVersion();
  if (current >= SCHEMA_VERSION) return current;

  // v0 -> v1: initialize empty indexes for the three tables. We do NOT
  // pre-create the encryption key here; it is lazily generated on first
  // token write so a freshly migrated profile carries no key material until
  // the user actually signs in to sprites.dev.
  for (const k of [NS.USER_SESSIONS, NS.RAW_CACHE, NS.PROCESSED_CACHE]) {
    if ((await sget(k)) === undefined) await sset(k, []);
  }
  await sset(NS.META, { schemaVersion: SCHEMA_VERSION });
  return SCHEMA_VERSION;
}

/**
 * Rollback to schema version 0. Removes every key this module owns,
 * including the encryption key — equivalent to dropping the tables. Safe to
 * call when uninstalling the sprites integration.
 */
export async function rollback() {
  const indexes = [
    [NS.USER_SESSIONS,   ROW_PREFIX.USER_SESSIONS],
    [NS.RAW_CACHE,       ROW_PREFIX.RAW_CACHE],
    [NS.PROCESSED_CACHE, ROW_PREFIX.PROCESSED_CACHE],
  ];
  const toDelete = [NS.META, NS.KEY];
  for (const [indexKey, prefix] of indexes) {
    const ids = (await sget(indexKey)) || [];
    for (const id of ids) toDelete.push(prefix + id);
    toDelete.push(indexKey);
  }
  await sdel(toDelete);
  _cachedKey = null;
}

/* ---------- generic table helper ---------- */

function makeTable({ indexKey, rowPrefix, encryptedCols = [], requiredCols }) {
  return {
    /**
     * Insert or update a row keyed by user_id. created_at is preserved on
     * update; updated_at is always refreshed. Encrypted columns are wrapped
     * before write and round-tripped on read.
     */
    async upsert(row) {
      if (!row || !row.user_id) throw new Error('user_id is required');
      for (const c of requiredCols) {
        if (!(c in row)) throw new Error(`column ${c} is required`);
      }
      await migrate(); // self-heal in case caller forgot to run migrate()
      const key = rowPrefix + row.user_id;
      const now = Date.now();
      const existing = await sget(key);

      const stored = { ...row, updated_at: now };
      stored.created_at = existing?.created_at ?? row.created_at ?? now;

      for (const col of encryptedCols) {
        if (col in stored) stored[col] = await encryptColumn(stored[col]);
      }

      await sset(key, stored);

      // Maintain index for `all()` / rollback. Cheap append-if-missing.
      const ids = (await sget(indexKey)) || [];
      if (!ids.includes(row.user_id)) {
        ids.push(row.user_id);
        await sset(indexKey, ids);
      }
      return row.user_id;
    },

    /**
     * Read a row by user_id, decrypting any wrapped columns. Returns null
     * when the row does not exist.
     */
    async get(user_id) {
      const stored = await sget(rowPrefix + user_id);
      if (!stored) return null;
      const out = { ...stored };
      for (const col of encryptedCols) {
        if (col in out) out[col] = await decryptColumn(out[col]);
      }
      return out;
    },

    async delete(user_id) {
      await sdel([rowPrefix + user_id]);
      const ids = (await sget(indexKey)) || [];
      const filtered = ids.filter((id) => id !== user_id);
      if (filtered.length !== ids.length) await sset(indexKey, filtered);
    },

    /** Enumerate all rows. Used by the polling worker to iterate users. */
    async all() {
      const ids = (await sget(indexKey)) || [];
      const rows = [];
      for (const id of ids) {
        const r = await this.get(id);
        if (r) rows.push(r);
      }
      return rows;
    },
  };
}

/* ---------- table definitions ---------- */

/**
 * user_sessions
 *   user_id        PK         string (sprites.dev account id)
 *   access_token   encrypted  string
 *   refresh_token  encrypted  string|null
 *   expires_at     timestamp  number (ms since epoch)
 *   created_at     timestamp  number (ms since epoch)  — auto
 *   updated_at     timestamp  number (ms since epoch)  — auto
 */
export const userSessions = makeTable({
  indexKey: NS.USER_SESSIONS,
  rowPrefix: ROW_PREFIX.USER_SESSIONS,
  encryptedCols: ['access_token', 'refresh_token'],
  requiredCols: ['access_token', 'expires_at'],
});

/**
 * raw_assignments_cache
 *   user_id     PK         string
 *   data_hash   string     sha256(raw_json) — used to skip reprocessing
 *   raw_json    jsonb      object/array as parsed from sprites.dev API
 *   fetched_at  timestamp  number
 */
export const rawAssignmentsCache = makeTable({
  indexKey: NS.RAW_CACHE,
  rowPrefix: ROW_PREFIX.RAW_CACHE,
  encryptedCols: [],
  requiredCols: ['data_hash', 'raw_json', 'fetched_at'],
});

/**
 * processed_assignments_cache
 *   user_id        PK         string
 *   processed_json jsonb      LLM-categorized output
 *   source_hash    string     matches raw_assignments_cache.data_hash that
 *                             produced this row — lets the pipeline detect
 *                             "raw changed since last LLM run"
 *   processed_at   timestamp  number
 */
export const processedAssignmentsCache = makeTable({
  indexKey: NS.PROCESSED_CACHE,
  rowPrefix: ROW_PREFIX.PROCESSED_CACHE,
  encryptedCols: [],
  requiredCols: ['processed_json', 'source_hash', 'processed_at'],
});

/* ---------- internal symbols exposed for tests only ---------- */

export const __internals = { NS, ROW_PREFIX, SCHEMA_VERSION };
