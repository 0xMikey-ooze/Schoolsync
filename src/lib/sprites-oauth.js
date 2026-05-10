/**
 * sprites.dev OAuth 2.0 + PKCE flow for SchoolSync (Chrome MV3).
 *
 * Uses chrome.identity.launchWebAuthFlow for the authorization redirect
 * (avoids the need for a server-side callback handler). Tokens are
 * encrypted at rest in chrome.storage.local using the existing crypto.js
 * passphrase scheme; the access token is also held in memory for the
 * lifetime of the service worker.
 *
 * Endpoint URLs and scope strings come from sprites-oauth-config.js,
 * which contains placeholders. assertConfigured() is invoked before any
 * network call so an un-configured build fail-fasts instead of hitting
 * a fabricated URL.
 */

import { SPRITES_OAUTH_CONFIG, assertConfigured } from './sprites-oauth-config.js';
import { encrypt, decrypt } from './crypto.js';

const STORAGE_KEY_ENCRYPTED_TOKENS = 'sprites_oauth_tokens_v1';
const PKCE_VERIFIER_BYTES = 32;
const STATE_BYTES = 16;
const REFRESH_SKEW_SECONDS = 60;

/** @type {{ accessToken: string, refreshToken: string|null, expiresAt: number, scope: string } | null} */
let _memoryTokens = null;

function base64UrlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteCount) {
  const buf = crypto.getRandomValues(new Uint8Array(byteCount));
  return base64UrlEncode(buf);
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function redirectUri() {
  // chrome.identity provides a per-extension https://<id>.chromiumapp.org URL.
  // The trailing path is part of the registered redirect URI on the IdP side.
  return `${chrome.identity.getRedirectURL()}sprites`;
}

function buildAuthorizationUrl({ verifier, state }) {
  const url = new URL(SPRITES_OAUTH_CONFIG.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', SPRITES_OAUTH_CONFIG.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', SPRITES_OAUTH_CONFIG.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  return pkceChallenge(verifier).then(challenge => {
    url.searchParams.set('code_challenge', challenge);
    return url.toString();
  });
}

function parseRedirect(redirectedUrl, expectedState) {
  const url = new URL(redirectedUrl);
  // Code-flow params arrive on the query string. Some IdPs return errors on
  // either query or fragment, so check both sources before giving up.
  const query = url.searchParams;
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const error = query.get('error') || hash.get('error');
  if (error) {
    const desc = query.get('error_description') || hash.get('error_description') || '';
    throw new Error(`sprites.dev authorization error: ${error}${desc ? ` — ${desc}` : ''}`);
  }
  const code = query.get('code');
  const state = query.get('state');
  if (!code) throw new Error('sprites.dev redirect missing authorization code');
  if (state !== expectedState) throw new Error('sprites.dev redirect state mismatch (possible CSRF)');
  return code;
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: SPRITES_OAUTH_CONFIG.clientId,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const res = await fetch(SPRITES_OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sprites.dev token exchange failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: SPRITES_OAUTH_CONFIG.clientId,
  });
  const res = await fetch(SPRITES_OAUTH_CONFIG.refreshEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sprites.dev token refresh failed: ${res.status} ${text}`);
  }
  return res.json();
}

function tokenResponseToRecord(json) {
  if (!json || typeof json.access_token !== 'string') {
    throw new Error('sprites.dev token response missing access_token');
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scope: typeof json.scope === 'string' ? json.scope : SPRITES_OAUTH_CONFIG.scopes.join(' '),
  };
}

async function persistTokens(record, passphrase) {
  const ciphertext = await encrypt(JSON.stringify(record), passphrase);
  await chrome.storage.local.set({ [STORAGE_KEY_ENCRYPTED_TOKENS]: ciphertext });
  _memoryTokens = record;
}

async function loadTokens(passphrase) {
  if (_memoryTokens) return _memoryTokens;
  const result = await chrome.storage.local.get(STORAGE_KEY_ENCRYPTED_TOKENS);
  const ciphertext = result[STORAGE_KEY_ENCRYPTED_TOKENS];
  if (!ciphertext) return null;
  try {
    const json = await decrypt(ciphertext, passphrase);
    _memoryTokens = JSON.parse(json);
    return _memoryTokens;
  } catch {
    return null;
  }
}

/**
 * Begin the OAuth flow. Opens the sprites.dev authorize page in a
 * Chrome-managed window, captures the redirect, exchanges the code
 * for tokens, and persists them encrypted under `passphrase`.
 *
 * @param {string} passphrase - user-supplied passphrase for at-rest encryption.
 * @returns {Promise<{ accessToken: string, expiresAt: number, scope: string }>}
 */
export async function startOAuth(passphrase) {
  assertConfigured();
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('startOAuth requires a non-empty passphrase for at-rest token encryption');
  }
  if (!chrome?.identity?.launchWebAuthFlow) {
    throw new Error('chrome.identity.launchWebAuthFlow unavailable — ensure manifest grants the "identity" permission');
  }

  const verifier = randomBase64Url(PKCE_VERIFIER_BYTES);
  const state = randomBase64Url(STATE_BYTES);
  const authUrl = await buildAuthorizationUrl({ verifier, state });

  const redirected = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message || 'launchWebAuthFlow failed'));
      if (!responseUrl) return reject(new Error('launchWebAuthFlow returned empty response'));
      resolve(responseUrl);
    });
  });

  const code = parseRedirect(redirected, state);
  const tokenJson = await exchangeCode(code, verifier);
  const record = tokenResponseToRecord(tokenJson);
  await persistTokens(record, passphrase);
  return { accessToken: record.accessToken, expiresAt: record.expiresAt, scope: record.scope };
}

/**
 * Return a valid access token, refreshing if expired (with a 60s skew).
 * Returns null if no token is stored or refresh fails irrecoverably.
 *
 * @param {string} passphrase
 * @returns {Promise<string|null>}
 */
export async function getAccessToken(passphrase) {
  assertConfigured();
  const record = await loadTokens(passphrase);
  if (!record) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now < record.expiresAt - REFRESH_SKEW_SECONDS) return record.accessToken;
  if (!record.refreshToken) return null;
  try {
    const json = await refreshAccessToken(record.refreshToken);
    const next = tokenResponseToRecord(json);
    if (!next.refreshToken) next.refreshToken = record.refreshToken;
    await persistTokens(next, passphrase);
    return next.accessToken;
  } catch {
    return null;
  }
}

/**
 * Drop the stored sprites.dev tokens (memory + chrome.storage).
 * @returns {Promise<void>}
 */
export async function signOut() {
  _memoryTokens = null;
  await chrome.storage.local.remove(STORAGE_KEY_ENCRYPTED_TOKENS);
}

export const __test__ = { base64UrlEncode, pkceChallenge, parseRedirect, tokenResponseToRecord, STORAGE_KEY_ENCRYPTED_TOKENS };
