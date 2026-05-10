# Re-Auth Flow Verification — Checklist

Scenarios that the integrated build must pass before the OAuth & Security
Audit can be marked PASS. Reproducible steps for each scenario; pair with
`test/reauth-flow.test.mjs` for the unit-level contract.

## Contract under test

When an authenticated sprites.dev API call is made and the stored token is
**missing**, **expired**, or **rejected upstream (401)**, the wrapper must:

1. Return a response with HTTP status `401`.
2. Return a JSON body containing `{ "reauth": true }` (additional fields
   such as `reason` are allowed).
3. Clear the stored token from `chrome.storage.local` so the next call
   sees the missing-token state and the UI surfaces sign-in.

The extension UI must, on receiving `{ reauth: true }`, route the user to
the sign-in screen (`popup.html` sign-in view) instead of rendering a
stale dashboard.

## Automated verification

```sh
node --test test/reauth-flow.test.mjs
```

Covers: missing token, expired token, upstream 401, happy path. Currently
exercises a self-contained reference implementation of the contract; once
the integrated `src/lib/sprites-*` modules land on `main`, re-target the
import to the real wrapper and rerun.

## Manual scenarios (extension build)

Prereqs:
- Chrome / Chromium with developer mode enabled.
- The integrated build loaded as an unpacked extension from this repo.
- A real sprites.dev OAuth client + valid signed-in session for happy-path
  baseline.

### 1. First-run: no token at all

1. Open `chrome://extensions` → SchoolSync → "Inspect views: service worker".
2. In the worker DevTools console, run:
   ```js
   await chrome.storage.local.remove('sprites_token');
   ```
3. Open the popup (toolbar icon).
4. Trigger any data fetch (e.g. "Refresh assignments" button).
5. **Expected:** popup shows the sign-in / "Connect sprites.dev" view.
   No assignments rendered. Network tab shows the API call returned
   `401` with body `{ "reauth": true, ... }`.

PASS criteria: UI on sign-in screen + 401/`reauth: true` observed.

### 2. Mid-session expiry

1. Sign in normally so a valid token is stored.
2. In the worker DevTools console:
   ```js
   const { sprites_token } = await chrome.storage.local.get('sprites_token');
   sprites_token.expires_at = Date.now() - 60_000; // force-expire
   await chrome.storage.local.set({ sprites_token });
   ```
3. Open the popup; trigger a refresh.
4. **Expected:**
   - API call short-circuits or returns `401 { reauth: true }`.
   - `chrome.storage.local.sprites_token` is gone after the call.
   - Popup shows sign-in screen.

PASS criteria: token cleared + UI on sign-in screen.

### 3. Upstream revocation (server 401)

1. Sign in normally.
2. Revoke the token server-side (sprites.dev dashboard) or use a tampered
   `access_token`:
   ```js
   const { sprites_token } = await chrome.storage.local.get('sprites_token');
   sprites_token.access_token = 'invalid_' + sprites_token.access_token;
   await chrome.storage.local.set({ sprites_token });
   ```
3. Trigger a refresh.
4. **Expected:** wrapper observes upstream `401`, returns
   `{ reauth: true }`, clears the token, UI redirects to sign-in.

PASS criteria: same as #2.

### 4. Happy path baseline (regression guard)

1. Sign in normally with a valid, non-expired token.
2. Trigger a refresh.
3. **Expected:** request succeeds (HTTP 200), assignments render, no
   sign-in redirect, token still present in storage.

PASS criteria: dashboard renders, no spurious reauth.

## How to record results

Append the table below to `ACCEPTANCE.md` under the **Re-Auth Flow** heading
after each verification run, with PASS/FAIL plus the build SHA tested.
