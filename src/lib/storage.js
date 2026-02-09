/**
 * SchoolSync Storage — encrypted local storage layer.
 * PII never stored in plaintext. Session tokens stored in memory only.
 */

const STORAGE_KEYS = {
  CAPSULE_ENDPOINT: 'capsule_endpoint',
  ENCRYPTED_TOKEN: 'encrypted_token',
  SYNC_SCHEDULE: 'sync_schedule',
  LAST_SYNC: 'last_sync',
  FIELD_MAP: 'field_map',
  SYNC_LOG: 'sync_log',
  STUDENT_HASHES: 'student_hashes', // hash-only, no PII
};

/** @type {string|null} */
let _sessionToken = null;

/**
 * Store Capsule API token (in-memory only, encrypted copy in storage).
 * @param {string} token
 * @param {string} passphrase
 */
export async function setToken(token, passphrase) {
  const { encrypt } = await import('./crypto.js');
  _sessionToken = token;
  const encrypted = await encrypt(token, passphrase);
  await chrome.storage.local.set({ [STORAGE_KEYS.ENCRYPTED_TOKEN]: encrypted });
}

/**
 * Get Capsule API token from memory, or decrypt from storage.
 * @param {string} [passphrase]
 * @returns {Promise<string|null>}
 */
export async function getToken(passphrase) {
  if (_sessionToken) return _sessionToken;
  if (!passphrase) return null;
  const { decrypt } = await import('./crypto.js');
  const result = await chrome.storage.local.get(STORAGE_KEYS.ENCRYPTED_TOKEN);
  const encrypted = result[STORAGE_KEYS.ENCRYPTED_TOKEN];
  if (!encrypted) return null;
  try {
    _sessionToken = await decrypt(encrypted, passphrase);
    return _sessionToken;
  } catch {
    return null;
  }
}

/** Clear session token from memory. */
export function clearSession() {
  _sessionToken = null;
}

/**
 * Get/set the Capsule API endpoint.
 * @param {string} [url]
 * @returns {Promise<string|null>}
 */
export async function capsuleEndpoint(url) {
  if (url) {
    await chrome.storage.local.set({ [STORAGE_KEYS.CAPSULE_ENDPOINT]: url });
    return url;
  }
  const result = await chrome.storage.local.get(STORAGE_KEYS.CAPSULE_ENDPOINT);
  return result[STORAGE_KEYS.CAPSULE_ENDPOINT] || null;
}

/**
 * Get/set sync schedule.
 * @param {{ enabled: boolean, intervalHours: number }} [schedule]
 * @returns {Promise<{ enabled: boolean, intervalHours: number }>}
 */
export async function syncSchedule(schedule) {
  if (schedule) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_SCHEDULE]: schedule });
    return schedule;
  }
  const result = await chrome.storage.local.get(STORAGE_KEYS.SYNC_SCHEDULE);
  return result[STORAGE_KEYS.SYNC_SCHEDULE] || { enabled: false, intervalHours: 24 };
}

/**
 * Record last sync timestamp + count.
 * @param {{ timestamp: number, studentCount: number, status: string }} entry
 */
export async function recordSync(entry) {
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SYNC]: entry });
  // Append to log (keep last 50)
  const result = await chrome.storage.local.get(STORAGE_KEYS.SYNC_LOG);
  const log = result[STORAGE_KEYS.SYNC_LOG] || [];
  log.unshift(entry);
  await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_LOG]: log.slice(0, 50) });
}

/**
 * Get last sync info.
 * @returns {Promise<{ timestamp: number, studentCount: number, status: string }|null>}
 */
export async function lastSync() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LAST_SYNC);
  return result[STORAGE_KEYS.LAST_SYNC] || null;
}

/**
 * Get sync log.
 * @returns {Promise<Array>}
 */
export async function syncLog() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SYNC_LOG);
  return result[STORAGE_KEYS.SYNC_LOG] || [];
}

/**
 * Store student data hashes (SHA-256 of each row) for diffing.
 * No PII stored — just hashes to detect changes.
 * @param {Record<string, string>} hashes - { sourcedId: hash }
 */
export async function setStudentHashes(hashes) {
  await chrome.storage.local.set({ [STORAGE_KEYS.STUDENT_HASHES]: hashes });
}

/**
 * Get student hashes for diff comparison.
 * @returns {Promise<Record<string, string>>}
 */
export async function getStudentHashes() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.STUDENT_HASHES);
  return result[STORAGE_KEYS.STUDENT_HASHES] || {};
}

export { STORAGE_KEYS };
