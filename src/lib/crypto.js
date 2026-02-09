/**
 * SchoolSync Crypto — AES-256-GCM encryption for student data at rest.
 * All PII is encrypted before hitting chrome.storage or Capsule API.
 * Key derived from user password via PBKDF2 (100k iterations).
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_LENGTH = 256;

/**
 * Derive an AES-256-GCM key from a password.
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt plaintext. Returns base64 string: salt(16) + iv(12) + ciphertext.
 * @param {string} plaintext
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function encrypt(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext)
  );
  const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64 encrypted string.
 * @param {string} encoded
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function decrypt(encoded, password) {
  const raw = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const salt = raw.slice(0, SALT_BYTES);
  const iv = raw.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const ciphertext = raw.slice(SALT_BYTES + IV_BYTES);
  const key = await deriveKey(password, salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plainBuf);
}
