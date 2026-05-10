/**
 * sprites-ui.js
 *
 * Popup-side helpers for the sprites.dev sign-in flow (PRD Lane 4 / "UI —
 * Sign-in Page & OAuth Redirect Flow"). The PRD describes a server with
 * `/signin` and `/dashboard` routes; SchoolSync ships as a Chrome MV3
 * extension, so the equivalent surface is the popup. These helpers do three
 * things:
 *
 *   1. Talk to the service-worker OAuth handlers from `sprites-auth.js` via
 *      runtime messages (`SPRITES_GET_AUTH_URL`, `SPRITES_OAUTH_CALLBACK`,
 *      `SPRITES_GET_VALID_TOKEN`). The popup never sees an access token in
 *      normal flow; it only learns the `user_id` so it can re-issue
 *      authenticated requests through the worker.
 *
 *   2. Drive `chrome.identity.launchWebAuthFlow()` with the URL returned by
 *      the worker, then forward the redirect URL back to the worker's
 *      callback handler. The redirect URL contains the auth code; that
 *      string never appears in popup DOM, page source, or any URL bar the
 *      user controls — `launchWebAuthFlow` opens an isolated chrome auth
 *      window and returns the URL only via callback.
 *
 *   3. Provide a single reauth guard (`withReauthGuard`) that turns any
 *      `{ ok: false, reauth: true }` response from a downstream API call
 *      into a "redirect to sign-in" action. The popup wires this into its
 *      navigation so any 401-equivalent kicks the user back to the
 *      sign-in view.
 *
 * Token-handling contract (verified by tests):
 *   - The `user_id` returned by `runOAuthFlow()` is the *only* identifier
 *     persisted in the popup's storage. `access_token` and `refresh_token`
 *     stay encrypted in the Lane 1 user_sessions store and never cross the
 *     popup boundary.
 *   - Reauth requirements are signalled via a structured response, not via
 *     thrown errors that include the token, so the popup can route on a
 *     boolean without ever logging a credential.
 */

const USER_ID_KEY = 'sprites_user_id';

/* ---------- runtime helpers (testable shims) ---------- */

function getRuntime() {
  return globalThis.chrome?.runtime;
}

function getIdentity() {
  return globalThis.chrome?.identity;
}

function getStorage() {
  return globalThis.chrome?.storage?.local;
}

/**
 * Promise-wrap chrome.runtime.sendMessage. The MV3 callback form is the
 * lowest common denominator: works in both popup contexts and tests where
 * we stub a runtime that calls back synchronously.
 */
function sendRuntimeMessage(msg, runtime = getRuntime()) {
  if (!runtime?.sendMessage) {
    return Promise.reject(new Error('chrome.runtime.sendMessage unavailable'));
  }
  return new Promise((resolve, reject) => {
    try {
      runtime.sendMessage(msg, (response) => {
        const lastError = runtime.lastError || globalThis.chrome?.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message || String(lastError)));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Promise-wrap chrome.identity.launchWebAuthFlow. The `interactive: true`
 * flag is mandatory for sign-in — non-interactive only re-issues an
 * existing session and is wrong for the first connect.
 */
function launchWebAuthFlow(url, identity = getIdentity()) {
  if (!identity?.launchWebAuthFlow) {
    return Promise.reject(new Error('chrome.identity.launchWebAuthFlow unavailable'));
  }
  return new Promise((resolve, reject) => {
    try {
      identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'launchWebAuthFlow failed'));
          return;
        }
        if (!redirectUrl) {
          reject(new Error('sprites.dev sign-in cancelled'));
          return;
        }
        resolve(redirectUrl);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/* ---------- public popup API ---------- */

/**
 * Fetch a sprites.dev authorization URL from the service worker. Used by
 * the popup directly when a UI wants to render the URL (e.g. for a "copy
 * link" affordance), but most callers should use `runOAuthFlow()` which
 * does the full launch+callback round-trip.
 *
 * @returns {Promise<{ url: string, state: string }>}
 */
export async function fetchAuthorizationUrl() {
  const resp = await sendRuntimeMessage({ type: 'SPRITES_GET_AUTH_URL' });
  if (!resp?.ok) {
    throw new Error(resp?.error || 'Failed to fetch sprites.dev sign-in URL');
  }
  return { url: resp.url, state: resp.state };
}

/**
 * Run the full popup sign-in flow:
 *   1. Ask the service worker for an authorize URL.
 *   2. Open it via `chrome.identity.launchWebAuthFlow` (sprites.dev consent).
 *   3. Forward the redirected URL to the worker's callback handler.
 *   4. Persist the resulting `user_id` so the popup knows who is signed in.
 *
 * Optional `onAuthorizing` callback fires after a 500ms delay if the
 * callback handler hasn't returned yet, so the popup can swap to an
 * "Authorizing…" state per the PRD.
 *
 * @param {{ onAuthorizing?: () => void, authorizingDelayMs?: number }} [opts]
 * @returns {Promise<{ user_id: string }>}
 */
export async function runOAuthFlow(opts = {}) {
  const { onAuthorizing, authorizingDelayMs = 500 } = opts;
  const { url } = await fetchAuthorizationUrl();
  const redirectUrl = await launchWebAuthFlow(url);

  let authorizingTimer = null;
  if (typeof onAuthorizing === 'function') {
    authorizingTimer = setTimeout(onAuthorizing, authorizingDelayMs);
  }
  try {
    const cbResp = await sendRuntimeMessage({
      type: 'SPRITES_OAUTH_CALLBACK',
      url: redirectUrl,
    });
    if (!cbResp?.ok) {
      throw new Error(cbResp?.error || 'sprites.dev callback failed');
    }
    await getStorage()?.set({ [USER_ID_KEY]: cbResp.user_id });
    return { user_id: cbResp.user_id };
  } finally {
    if (authorizingTimer) clearTimeout(authorizingTimer);
  }
}

/**
 * Read the persisted sprites.dev `user_id` for the popup. Returns null if
 * the user has never completed the OAuth flow on this device. Note: the
 * presence of a `user_id` does not by itself prove the session is still
 * valid — every authenticated call should still go through `withReauthGuard`.
 */
export async function getSpritesUserId() {
  const out = await getStorage()?.get(USER_ID_KEY);
  return out?.[USER_ID_KEY] || null;
}

/**
 * Forget the popup's persisted `user_id`. The encrypted token blob in the
 * Lane 1 user_sessions store is left intact (refresh tokens may still be
 * valid); call this for "sign out of this popup" rather than full session
 * revocation.
 */
export async function clearSpritesUserId() {
  await getStorage()?.remove(USER_ID_KEY);
}

/**
 * Wrap an async API call so a `{ ok: false, reauth: true }` response
 * triggers `onReauth()` and re-throws a sentinel `ReauthRequiredError`.
 * The popup typically passes `onReauth: () => showSigninView()` so any
 * 401-equivalent immediately routes the user back to sign-in — this is
 * the PRD's "unauthenticated guard" requirement.
 *
 * Non-reauth errors propagate unchanged so the caller can render a normal
 * error state.
 *
 * @param {() => Promise<any>} call
 * @param {{ onReauth?: () => void | Promise<void> }} [opts]
 */
export async function withReauthGuard(call, { onReauth } = {}) {
  const resp = await call();
  if (resp && resp.ok === false && resp.reauth === true) {
    if (typeof onReauth === 'function') {
      await onReauth();
    }
    await clearSpritesUserId();
    const err = new Error('sprites.dev session expired — please sign in again');
    err.reauth = true;
    throw err;
  }
  return resp;
}

/* ---------- exposed for tests ---------- */

export const __internals = {
  USER_ID_KEY,
  sendRuntimeMessage,
  launchWebAuthFlow,
};
