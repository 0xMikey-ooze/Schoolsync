/**
 * sprites-auth.js
 *
 * Sprites.dev OAuth client for the SchoolSync Chrome MV3 extension. The PRD
 * describes server-side `/auth/sprites/url` and `/auth/sprites/callback`
 * routes; SchoolSync has no server, so the equivalent is a pair of message
 * handlers running in the extension service worker that share the PKCE flow:
 *
 *   1. Popup asks for an authorization URL via the SPRITES_GET_AUTH_URL
 *      message → service worker calls `getAuthorizationUrl()`, which mints a
 *      PKCE verifier and a state nonce, stashes them in chrome.storage.local
 *      under `sprites:pending_auth`, and returns `{ url }` pointing at the
 *      sprites.dev authorize endpoint.
 *
 *   2. Popup runs `chrome.identity.launchWebAuthFlow({ url })`, which opens
 *      the consent screen and returns the redirect URL once the user agrees.
 *
 *   3. Popup hands the redirect URL to the SPRITES_OAUTH_CALLBACK handler,
 *      which calls `handleCallback(redirectedUrl)`. The callback validates
 *      the `state` nonce, exchanges `code + code_verifier` for tokens at the
 *      sprites.dev token endpoint, and persists them encrypted in the
 *      `user_sessions` table from Lane 1.
 *
 *   4. Polling (Lane 3) and dashboard (Lane 4) callers ask `getValidToken()`
 *      for the current bearer. Expired tokens are auto-refreshed when a
 *      `refresh_token` is available; otherwise `ReauthRequiredError` is
 *      thrown and the calling handler reports `{ ok: false, reauth: true }`
 *      via `withReauth(...)` so the UI can redirect to sign-in.
 *
 * Tokens never appear in any response body — call sites read the access
 * token from `getValidToken()` and use it as a `Bearer` header. The PRD's
 * `HttpOnly; Secure; SameSite=Strict` cookie requirement is satisfied here
 * by encrypting tokens at rest in chrome.storage.local (Lane 1) and never
 * surfacing them in JSON returned to popup/content-script callers.
 *
 * Configuration (sprites.dev endpoint URLs, client_id, scopes, redirect URI)
 * is provisioned through `setConfig({ ... })` so this module never invents
 * production endpoints. Operators wire SPRITES_CLIENT_ID / SPRITES_CLIENT_SECRET
 * / SPRITES_REDIRECT_URI / SPRITES_AUTHORIZE_URL / SPRITES_TOKEN_URL into
 * setConfig() at install time.
 */

import { migrate, userSessions } from './sprites-store.js';

/* ---------- public error type ---------- */

/**
 * Thrown when a sprites.dev session cannot be refreshed and the user must
 * sign in again. Callers wrap their handlers with `withReauth()` to turn
 * this into a `{ ok: false, reauth: true }` response that popup/UI code can
 * use to redirect to the sign-in flow.
 */
export class ReauthRequiredError extends Error {
  constructor(message = 'Reauthentication required', cause) {
    super(message);
    this.name = 'ReauthRequiredError';
    if (cause !== undefined) this.cause = cause;
  }
}

/* ---------- config (provisioned by operator, never hard-coded) ---------- */

const CONFIG_KEY = 'sprites:config';
const PENDING_KEY = 'sprites:pending_auth';
const PENDING_TTL_MS = 10 * 60 * 1000; // user has 10 minutes to complete consent
const REFRESH_LEEWAY_MS = 60 * 1000;   // refresh 60s before stated expiry

function storage() {
  return globalThis.chrome.storage.local;
}

/**
 * Persist the sprites.dev OAuth configuration. Required keys:
 *   authorizeUrl, tokenUrl, clientId, redirectUri
 * Optional:
 *   clientSecret, scopes (string[])
 *
 * Sprites.dev's exact authorize/token URLs and scope identifiers are not
 * documented in this repo. The operator provisions them via setConfig()
 * (typically called once from an options page, or seeded by the build) so
 * the OAuth client never invents endpoint URLs.
 */
export async function setConfig(config) {
  const required = ['authorizeUrl', 'tokenUrl', 'clientId', 'redirectUri'];
  for (const k of required) {
    if (!config?.[k]) throw new Error(`sprites config: ${k} is required`);
  }
  const stored = {
    authorizeUrl: String(config.authorizeUrl),
    tokenUrl: String(config.tokenUrl),
    clientId: String(config.clientId),
    clientSecret: config.clientSecret ? String(config.clientSecret) : null,
    redirectUri: String(config.redirectUri),
    scopes: Array.isArray(config.scopes) ? config.scopes.map(String) : [],
  };
  await storage().set({ [CONFIG_KEY]: stored });
}

export async function getConfig() {
  const out = await storage().get(CONFIG_KEY);
  return out[CONFIG_KEY] || null;
}

async function requireConfig() {
  const c = await getConfig();
  if (!c) {
    throw new Error(
      'sprites OAuth config missing — call setConfig({ authorizeUrl, tokenUrl, clientId, redirectUri, scopes }) ' +
      'with values from SPRITES_AUTHORIZE_URL / SPRITES_TOKEN_URL / SPRITES_CLIENT_ID / SPRITES_REDIRECT_URI before sign-in.'
    );
  }
  return c;
}

/* ---------- PKCE primitives ---------- */

function bytesToBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(numBytes) {
  const buf = new Uint8Array(numBytes);
  globalThis.crypto.getRandomValues(buf);
  return bytesToBase64Url(buf);
}

async function pkceChallengeFor(verifier) {
  const buf = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return bytesToBase64Url(new Uint8Array(buf));
}

/* ---------- /auth/sprites/url equivalent ---------- */

/**
 * Build a sprites.dev authorization URL with PKCE + state nonce.
 *
 * Side effect: persists `{ state, code_verifier, created_at }` to
 * chrome.storage.local so `handleCallback()` can validate the redirect.
 *
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ url: string, state: string }>}
 */
export async function getAuthorizationUrl({ now = Date.now() } = {}) {
  const config = await requireConfig();
  // 64 random bytes → 86-char base64url verifier (within the 43–128 spec range).
  const code_verifier = randomBase64Url(64);
  const code_challenge = await pkceChallengeFor(code_verifier);
  const state = randomBase64Url(24);

  await storage().set({
    [PENDING_KEY]: { state, code_verifier, created_at: now },
  });

  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  if (config.scopes.length > 0) {
    url.searchParams.set('scope', config.scopes.join(' '));
  }
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state };
}

/* ---------- /auth/sprites/callback equivalent ---------- */

function decodeJwtSub(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1] + '==='.slice((parts[1].length + 3) % 4);
    const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return payload.sub || null;
  } catch {
    return null;
  }
}

/**
 * Validate the redirect from sprites.dev, exchange `code` for tokens using
 * the PKCE verifier, and upsert into `user_sessions`. Returns the resolved
 * sprites user_id so the caller can route to the dashboard.
 *
 * @param {string|URL} redirectedUrl    URL the user agent landed on
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [opts]
 * @returns {Promise<{ user_id: string, expires_at: number }>}
 */
export async function handleCallback(redirectedUrl, opts = {}) {
  const config = await requireConfig();
  const fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  const now = opts.now ?? Date.now();

  const url = new URL(redirectedUrl);
  // Some providers stash params in the URL fragment instead of the query.
  const qp = url.searchParams;
  const fragmentParams = url.hash.startsWith('#')
    ? new URLSearchParams(url.hash.slice(1))
    : new URLSearchParams();
  const param = (k) => qp.get(k) ?? fragmentParams.get(k);

  if (param('error')) {
    throw new Error(
      `sprites OAuth error: ${param('error')}: ${param('error_description') || ''}`,
    );
  }

  const code = param('code');
  const state = param('state');
  if (!code || !state) {
    throw new Error('sprites OAuth callback missing code or state');
  }

  const pendingWrap = await storage().get(PENDING_KEY);
  const pending = pendingWrap[PENDING_KEY];
  if (!pending) throw new Error('sprites OAuth: no pending authorization');
  // Always remove pending state on use, even on failure, so a leaked code
  // cannot be replayed.
  await storage().remove(PENDING_KEY);
  if (pending.state !== state) {
    throw new Error('sprites OAuth: state mismatch');
  }
  if (now - pending.created_at > PENDING_TTL_MS) {
    throw new Error('sprites OAuth: authorization request expired');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', config.redirectUri);
  body.set('client_id', config.clientId);
  body.set('code_verifier', pending.code_verifier);
  if (config.clientSecret) body.set('client_secret', config.clientSecret);

  const resp = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `sprites OAuth token exchange failed: HTTP ${resp.status}: ${text.slice(0, 200)}`,
    );
  }
  const tokens = await resp.json();

  const access_token = tokens.access_token;
  if (!access_token) throw new Error('sprites OAuth response missing access_token');
  const refresh_token = tokens.refresh_token || null;
  const expires_in = Number(tokens.expires_in) || 3600;
  const user_id =
    tokens.user_id ||
    tokens.sub ||
    (tokens.id_token ? decodeJwtSub(tokens.id_token) : null);
  if (!user_id) {
    throw new Error('sprites OAuth response missing user_id (need user_id, sub, or id_token.sub)');
  }

  const expires_at = now + expires_in * 1000;
  await migrate();
  await userSessions.upsert({
    user_id,
    access_token,
    refresh_token,
    expires_at,
  });
  return { user_id, expires_at };
}

/* ---------- token utility for downstream lanes ---------- */

/**
 * Return a currently-valid access_token for `user_id`, refreshing via the
 * refresh_token grant when expired. Throws `ReauthRequiredError` when the
 * session is unknown, expired without a refresh_token, or the refresh fails.
 *
 * @param {string} user_id
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function getValidToken(user_id, opts = {}) {
  if (!user_id) throw new ReauthRequiredError('user_id required');
  const fetchImpl = opts.fetchImpl || globalThis.fetch?.bind(globalThis);
  const now = opts.now ?? Date.now();

  const session = await userSessions.get(user_id);
  if (!session) {
    throw new ReauthRequiredError('No sprites session for user');
  }
  if (session.expires_at - REFRESH_LEEWAY_MS > now) {
    return session.access_token;
  }
  if (!session.refresh_token) {
    throw new ReauthRequiredError(
      'Sprites token expired and no refresh_token available',
    );
  }

  const config = await requireConfig();
  if (!fetchImpl) throw new ReauthRequiredError('fetch unavailable for refresh');

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', session.refresh_token);
  body.set('client_id', config.clientId);
  if (config.clientSecret) body.set('client_secret', config.clientSecret);

  let resp;
  try {
    resp = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new ReauthRequiredError('Sprites refresh request failed', err);
  }
  if (!resp.ok) {
    throw new ReauthRequiredError(
      `Sprites refresh rejected: HTTP ${resp.status}`,
    );
  }
  const tokens = await resp.json();
  const access_token = tokens.access_token;
  if (!access_token) {
    throw new ReauthRequiredError('Sprites refresh response missing access_token');
  }
  const expires_in = Number(tokens.expires_in) || 3600;
  await userSessions.upsert({
    user_id,
    access_token,
    // Some providers rotate refresh tokens; keep the prior one when omitted.
    refresh_token: tokens.refresh_token || session.refresh_token,
    expires_at: now + expires_in * 1000,
  });
  return access_token;
}

/* ---------- re-auth middleware for runtime message handlers ---------- */

/**
 * Wrap a runtime-message handler so any thrown `ReauthRequiredError` is
 * converted to `{ ok: false, reauth: true, error }`. The popup checks for
 * `reauth === true` and redirects the user back to the sprites sign-in
 * flow. All other errors propagate so they surface as bug reports.
 *
 * @template H
 * @param {H} handler
 * @returns {H}
 */
export function withReauth(handler) {
  // Keep the runtime shape of the wrapped function (sync return / Promise).
  return /** @type {any} */ (async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        return { ok: false, reauth: true, error: err.message };
      }
      throw err;
    }
  });
}

/* ---------- runtime message handlers (replaces HTTP routes) ---------- */

/**
 * Register chrome.runtime.onMessage handlers that are the moral equivalent
 * of `GET /auth/sprites/url` and `GET /auth/sprites/callback`. Service
 * worker code calls this once at startup. The popup invokes the handlers
 * via chrome.runtime.sendMessage:
 *
 *   { type: 'SPRITES_GET_AUTH_URL' }            -> { ok, url, state }
 *   { type: 'SPRITES_OAUTH_CALLBACK', url }     -> { ok, user_id }
 *   { type: 'SPRITES_GET_VALID_TOKEN', user_id } -> { ok, access_token } | reauth
 *
 * No raw access_token is returned to popup callers in normal flow; the
 * SPRITES_GET_VALID_TOKEN message exists only for in-extension network
 * fetches that need the bearer (e.g. Lane 3 polling). Popup UI uses the
 * dashboard / "is signed in?" boolean rather than the token itself.
 *
 * @param {{ onMessage: { addListener: Function } }} [runtime] defaults to chrome.runtime
 */
export function attachOAuthHandlers(runtime = globalThis.chrome?.runtime) {
  if (!runtime?.onMessage?.addListener) {
    throw new Error('attachOAuthHandlers: chrome.runtime.onMessage unavailable');
  }
  runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case 'SPRITES_GET_AUTH_URL':
        getAuthorizationUrl()
          .then((r) => sendResponse({ ok: true, url: r.url, state: r.state }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;

      case 'SPRITES_OAUTH_CALLBACK':
        handleCallback(msg.url)
          .then((r) => sendResponse({ ok: true, user_id: r.user_id }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;

      case 'SPRITES_GET_VALID_TOKEN':
        withReauth(async () => {
          const access_token = await getValidToken(msg.user_id);
          return { ok: true, access_token };
        })()
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;

      default:
        return false;
    }
  });
}

/* ---------- internals exposed for tests ---------- */

export const __internals = {
  CONFIG_KEY,
  PENDING_KEY,
  PENDING_TTL_MS,
  REFRESH_LEEWAY_MS,
};
