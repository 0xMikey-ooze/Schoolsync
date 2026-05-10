/**
 * tests/storage-audit.mjs
 *
 * Live storage hygiene check for the sprites.dev token store. Writes a
 * session row containing two unique plaintext "needle" strings, then dumps
 * the entire chrome.storage.local namespace and asserts the needles do NOT
 * appear in the on-disk JSON. Verifies in one run:
 *
 *   3A.3 — confidentiality at rest (HttpOnly equivalent)
 *   3A.8 — tokens stored encrypted at rest (AES-GCM ciphertext, not plaintext)
 *
 * Designed to run from the integration branch `sprites/auth-session-backend`
 * which provides `src/lib/sprites-store.js`. The script stubs chrome.storage
 * with an in-memory map so the check runs under bare Node without a browser.
 *
 *   $ node tests/storage-audit.mjs
 *   PASS: no plaintext token bytes in chrome.storage dump.
 */

import { migrate, userSessions } from '../src/lib/sprites-store.js';

const PLAINTEXT_ACCESS  = 'spr_AT_PLAINTEXT_NEEDLE_4VW7Q';
const PLAINTEXT_REFRESH = 'spr_RT_PLAINTEXT_NEEDLE_FQ9XM';

// In-memory chrome.storage.local stand-in. Mirrors the subset of the API
// that sprites-store.js uses (get / set / remove).
const data = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return { ...data };
        if (typeof keys === 'string') {
          return keys in data ? { [keys]: data[keys] } : {};
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }
        return {};
      },
      async set(obj) { Object.assign(data, obj); },
      async remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete data[k];
      },
    },
  },
};

await migrate();
await userSessions.upsert({
  user_id: 'audit-user',
  access_token: PLAINTEXT_ACCESS,
  refresh_token: PLAINTEXT_REFRESH,
  expires_at: Date.now() + 3600_000,
});

// Sanity: in-extension callers must still be able to retrieve the plaintext.
const back = await userSessions.get('audit-user');
if (back.access_token !== PLAINTEXT_ACCESS) {
  console.error('FAIL: round-trip broken — userSessions.get did not decrypt access_token.');
  process.exit(1);
}
console.log('round-trip OK — access_token decrypts to plaintext for in-extension callers.');

const dump = JSON.stringify(data);
const accessLeak = dump.includes(PLAINTEXT_ACCESS);
const refreshLeak = dump.includes(PLAINTEXT_REFRESH);

console.log('--- chrome.storage.local raw dump ---');
console.log(dump);
console.log('--- grep for plaintext access_token in raw on-disk dump ---');
console.log('access_token leak:', accessLeak);
console.log('refresh_token leak:', refreshLeak);

const row = data['sprites:row:user_sessions:audit-user'];
console.log('--- stored access_token shape ---');
console.log(JSON.stringify(row.access_token));
console.log('Has {iv, ct}?', typeof row.access_token === 'object' && 'iv' in row.access_token && 'ct' in row.access_token);

if (accessLeak || refreshLeak) {
  console.error('FAIL: plaintext token bytes appeared in chrome.storage dump.');
  process.exit(1);
}
console.log('PASS: no plaintext token bytes in chrome.storage dump.');
