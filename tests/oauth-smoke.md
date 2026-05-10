# OAuth Smoke Test — sprites.dev Sign-In Round-Trip

Reproducible checklist for verifying the full sprites.dev OAuth round-trip on
the integrated `main` build of the Schoolsync Chrome extension. Run this against
a build where the merge from sub-task 1 ("Merge Feature Branches to Main") has
landed and the extension has been loaded unpacked into Chrome.

Each step is intentionally small and observable. Record PASS / FAIL / N/A in
`ACCEPTANCE.md` with a one-line note (timestamp, observed value, or error text).

---

## Preconditions

P1. **Working tree on integrated `main`** with merged feature branches:
    ```bash
    git rev-parse --abbrev-ref HEAD   # expect: main
    git log --oneline -5
    ```
    Confirm commits from the merged auth + polling + LLM + UI feature branches
    appear in the log.

P2. **Static preconditions** (run from repo root):
    ```bash
    bash tests/oauth-smoke.sh
    ```
    The script asserts the static surface area required for the round-trip:
    OAuth source files exist, manifest declares `identity` permission, AES-GCM
    helper is present, and no plaintext token markers leak into the bundle.
    Exit code 0 = all preconditions PASS.

P3. **Required environment**
    - Chrome (or Chromium) ≥ 119.
    - Test sprites.dev account with at least one Schoolsync-linked roster.
    - `chrome://extensions` → Developer mode ON.

---

## Round-Trip Steps

### Step 1 — Load extension
1. `chrome://extensions` → **Load unpacked** → select repo root.
2. Verify the extension card shows name `SchoolSync` and no errors badge.
3. Open the popup (`chrome.action`).

**Expected:** Popup renders the sprites.dev sign-in CTA (no spinner stuck,
no console errors in the popup devtools).

### Step 2 — Trigger sign-in
1. Open the service worker devtools: extension card → **service worker**.
2. In the popup, click **Sign in with sprites.dev**.
3. The browser launches a new tab to the sprites.dev authorization endpoint.

**Expected:** Network log in service worker shows a single call to
`chrome.identity.launchWebAuthFlow` (or equivalent helper). The opened URL
includes `client_id`, `redirect_uri=https://<extension-id>.chromiumapp.org/*`,
`response_type=code`, `state=<nonce>`, and `code_challenge` (PKCE).

### Step 3 — Authorize on sprites.dev
1. Sign in to the sprites.dev test account.
2. Approve the requested scopes.

**Expected:** sprites.dev redirects back to the chromiumapp.org redirect URI
with `?code=...&state=<same-nonce>`. The extension closes the auth tab.

### Step 4 — Callback handling
1. Watch the service worker console for the callback handler trace.

**Expected:**
- `state` is verified against the stored nonce; mismatch aborts.
- Authorization code is exchanged at the sprites.dev token endpoint.
- Response includes `access_token`, `refresh_token`, `expires_in`.
- No tokens are logged in plaintext (only `[redacted]` markers).

### Step 5 — Token storage hygiene (CRITICAL)
1. In service worker devtools console:
    ```js
    const all = await chrome.storage.local.get(null);
    console.log(JSON.stringify(all, null, 2));
    ```
2. Inspect every value.

**Expected:**
- The sprites session entry stores AES-GCM ciphertext: an object with
  `iv`, `ciphertext`, `tag` (or equivalent base64 fields) — NOT a raw JWT
  or `Bearer ...` string.
- No key `access_token`, `refresh_token`, `id_token`, or `password` exists at
  the top level holding a plaintext value.
- A grep over the dump for `eyJ` (JWT prefix), `Bearer `, or the literal
  account email returns no matches.

### Step 6 — Dashboard loads with real data
1. Reopen the popup.
2. Wait for the assignment dashboard to render.

**Expected:**
- Dashboard shows the signed-in account identifier.
- Assignment list contains ≥ 1 item retrieved from the sprites.dev Schoolsync
  endpoint (not a mock placeholder).
- Overdue items are visually highlighted.
- "Last synced" timestamp is within the last minute.

### Step 7 — Re-render survives reload
1. Close and reopen the popup.
2. Reload the service worker (chrome://extensions → reload arrow).

**Expected:** Dashboard re-renders without re-prompting for sign-in. Token is
read from `chrome.storage.local`, decrypted, and used to fetch fresh data.

---

## Failure-Reporting Template

For every FAIL, paste the following into the ACCEPTANCE.md entry:

```
- Step <N> FAIL — <one-line symptom>
  - Observed: <exact text/screenshot path>
  - Expected: <quoted from this checklist>
  - Repro: <minimal reproduction steps if non-obvious>
  - Suspected file: <path>
```

## Notes

- This checklist is the source of truth for the smoke test. The companion
  `tests/oauth-smoke.sh` only covers static preconditions because the
  round-trip is browser-bound and cannot be fully scripted in bash.
- Do NOT commit captured tokens, decrypted plaintext, or screenshots that
  expose them. Use `[REDACTED]` placeholders.
