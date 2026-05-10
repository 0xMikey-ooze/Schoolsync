# ACCEPTANCE — Schoolsync × sprites.dev OAuth + LLM Assignment Intelligence

## Section 1/4 — OAuth Flow & Security Audit Verification

Owner: team `claude/running/MYAz7aA6` (sub 1/4 of End-to-End Integration & Acceptance Verification).
Risk tier: critical (authentication / session management).
Date: 2026-05-09.

### Repo state at audit time

The PRD describes a Node/Next-style stack (server routes `/api/auth/sprites/start`,
`/api/auth/sprites/callback`, a `sprites_sessions` table, a tRPC `schoolsync.refresh`
mutation, a React `<SchoolsyncPanel>` dashboard component, and a built JS bundle).
The working tree on `main @ 0416910` contains **none of this**:

- `git log --oneline` ends at `0416910 Add deep crawler — visits each student profile for full data extraction`.
- `find src -type f` returns only Chrome MV3 extension code (`src/background/service-worker.js`, `src/popup/*`, `src/content/*`, `src/lib/{capsule-client,crypto,hasher,storage}.js`).
- `grep -r -l "sprites\|OAuth\|oauth" src/` → no matches.
- No `package.json`, no `server/`, no `tsconfig.json`, no `tests/`, no `components/`, no built bundle.
- The run manifest's "Files touched" entries (`src/lib/sprites-store.js`, `src/lib/sprites-oauth-config.js`, `src/lib/sprites-oauth.js`, `server/db/schema.ts`, `package.json`, `tests/schoolsync-schema.test.ts`, etc.) are absent from the working tree. Upstream tasks marked `done` did not land artifacts here.

Because the artifact under audit does not exist, the checks below cannot produce
a meaningful pass. Each is recorded as **FAIL — not implemented** with the exact
evidence used.

### 1. End-to-end smoke: sign-in → callback → token stored → dashboard loads

| Step | Expected | Observed | Result |
| --- | --- | --- | --- |
| 1.1 Visit `/api/auth/sprites/start` | 302 to sprites.dev authorize URL with `state` and PKCE `code_challenge` | Route does not exist; no HTTP server in repo | **FAIL — not implemented** |
| 1.2 Authorize on sprites.dev | sprites.dev redirects back to `/api/auth/sprites/callback?code=…&state=…` | No callback handler; no client id / endpoints documented in repo | **FAIL — not implemented** |
| 1.3 Token exchange persists session | Row inserted in `sprites_sessions` with hashed token, refresh token, `expires_at` | Table not defined in repo (`server/db/schema.ts` absent) | **FAIL — not implemented** |
| 1.4 Dashboard loads with real assignment data | `/dashboard` server-renders panel with rows from `schoolsync_processed` | No dashboard route, no React build, no `schoolsync_processed` table | **FAIL — not implemented** |

Repro command set used to verify absence:

```sh
git rev-parse HEAD          # 0416910…
ls package.json server tests components 2>&1
grep -r -l "sprites\|OAuth\|oauth" src/
find . -name "*.tsx" -o -name "schema.ts" -o -name "trpc"
```

All four return empty / "No such file or directory".

### 2. Re-auth flow: 401 `{ reauth: true }` and UI redirect

| Step | Expected | Observed | Result |
| --- | --- | --- | --- |
| 2.1 Force expiry: set `sprites_sessions.expires_at` to past, hit `schoolsync.refresh` | API returns `401 { reauth: true }` | No tRPC router, no API endpoint | **FAIL — not implemented** |
| 2.2 UI receives 401 | Frontend redirects to sign-in route | No frontend, no router, no sign-in page | **FAIL — not implemented** |
| 2.3 Delete session row, replay | Same 401 + redirect path | n/a — same blocker | **FAIL — not implemented** |

### 3. Security audit checklist

| # | Check | Method | Result |
| --- | --- | --- | --- |
| 3.1 | No access token / refresh token string in client JS bundle | `grep -E "(sprites_access|access_token|refresh_token)" dist/**/*.js` | **FAIL — no bundle to grep**; no build step in repo |
| 3.2 | No token in URL query/fragment after callback | DevTools Network panel review of `/api/auth/sprites/callback` redirect target | **FAIL — no server to exercise** |
| 3.3 | Session cookie `HttpOnly` | `Set-Cookie` header inspection on callback response | **FAIL — no cookie issued, no server** |
| 3.4 | Session cookie `Secure` | same | **FAIL — not implemented** |
| 3.5 | Session cookie `SameSite=Lax` (or `Strict` for non-cross-site flows) | same | **FAIL — not implemented** |
| 3.6 | OAuth `state` parameter validated server-side | Inspect callback handler | **FAIL — no callback handler** |
| 3.7 | PKCE `code_verifier` used (S256) | Inspect `/start` handler and token-exchange call | **FAIL — no `/start` handler** |
| 3.8 | Tokens stored encrypted at rest | Inspect token-store module / DB column | **FAIL — token store not present in working tree** |
| 3.9 | CSRF on logout / refresh mutation | Inspect mutation guards | **FAIL — no mutation defined** |

Note on 3.1: `src/lib/storage.js` (Chrome extension) does have a `setToken` →
`encrypt(token, passphrase)` helper for *Capsule* tokens with an
in-memory `_sessionToken` cache. That code is unrelated to sprites.dev OAuth and
does not satisfy any of the checks above; flagged here only so a reviewer is
not misled by the word "token" in the existing code.

### Summary

- 0 / 16 individual checks pass.
- Root cause: the implementation work the PRD's `done` tasks claim (server routes, DB schema, token store, dashboard, build pipeline) is not present in this worktree. The current repo is the upstream Chrome-extension Schoolsync; the sprites.dev OAuth + dashboard layer was never landed on `main` (nor on any other ref reachable here).
- Recommendation: **escalate / recover**. The conductor should treat the four `done` upstream tasks (Database Schema & Token Store Setup, Auth & Session Backend, Polling Worker & Data Fetcher, UI sign-in & dashboard) as not actually delivered and re-run them with handoffs that produce verifiable repo diffs, before retrying acceptance verification.

### Forbidden paths avoided (critical-path discipline)

This sub-task is auth-critical. It would have been unsafe to:
- Stub a fake OAuth handler to make checks "pass" — would mask the missing implementation.
- Hand-edit auth code in `src/` to retroactively claim coverage — out of scope and would create unaudited credential paths.
- Fabricate cookie / network evidence without a running server.

None of the above were done. Only documentation (this file) was written.

---

## Section 1/4 — Addendum (Recovery 1/10): Audit against integration branch

`main @ 0416910` does not contain the OAuth implementation, but the upstream
Lane 1 + Lane 2 work landed on feature branches as **OPEN PRs** rather than
being merged. Recovery attempt 1/10 re-runs the audit against the integration
SHA `sprites/auth-session-backend @ 42b712a` (`gh pr 4`), which includes Lane
1's `sprites-store.js` (PR #2) plus Lane 2's `sprites-auth.js` and the
`service-worker.js` boot wiring.

### Repo state under audit

```sh
git ls-tree 42b712a -r --name-only | grep -E '^(src/lib/sprites|test/sprites|src/background/service-worker)'
# src/background/service-worker.js
# src/lib/sprites-auth.js
# src/lib/sprites-store.js
# test/sprites-auth.test.mjs
# test/sprites-store.test.mjs
```

Architectural note: SchoolSync is a Chrome MV3 extension, **not** a Node/Next
server. The PRD's `/api/auth/sprites/start` + `/api/auth/sprites/callback`
routes are realised as `chrome.identity.launchWebAuthFlow` plus
`chrome.runtime` messages (`SPRITES_GET_AUTH_URL`, `SPRITES_OAUTH_CALLBACK`,
`SPRITES_GET_VALID_TOKEN`) sharing one PKCE client. The PRD's `HttpOnly;
Secure; SameSite=Strict` cookie property is therefore inapplicable; the
equivalent confidentiality requirement is satisfied by AES-GCM encryption of
the token columns at rest in `chrome.storage.local` (see 3A.8 below).

### Test evidence (Recovery 1/10)

```sh
# from /tmp/audit-sprites-auth (worktree at 42b712a)
node test/sprites-store.test.mjs   # 16/16 passed
node test/sprites-auth.test.mjs    # 17/17 passed
```

### 1A. End-to-end smoke (re-mapped to extension architecture)

| Step | Expected | Observed @ 42b712a | Result |
| --- | --- | --- | --- |
| 1A.1 Mint authorize URL | URL contains `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`; `state`/`verifier` persisted with TTL | `getAuthorizationUrl` test "emits PKCE + state and stashes pending state" — pass | **PASS** |
| 1A.2 Fresh entropy each call | Each call mints a new state + verifier | Test "mints a fresh state and verifier on each call" — pass | **PASS** |
| 1A.3 Callback validates `state` and exchanges `code + code_verifier` | Mismatched state rejected; expired pending rejected; tokens persisted encrypted | Tests "validates state, exchanges code, persists encrypted tokens", "rejects state mismatch and clears pending", "rejects expired pending request" — pass | **PASS** |
| 1A.4 Provider error surfaced | `error_response` from token endpoint bubbles, pending state cleared | Test "surfaces provider error responses" — pass | **PASS** |
| 1A.5 OIDC `id_token.sub` fallback | When `user_id` is absent, derived from `id_token.sub` | Test "derives user_id from id_token.sub when user_id absent" — pass | **PASS** |
| 1A.6 Dashboard loads with real assignment data | Out of scope for Lane 2 | Lane 4 dashboard PRs (#10, #11) still OPEN; not exercised here | **DEFERRED** to Lanes 4/6 acceptance |

### 2A. Re-auth flow

| Step | Expected | Observed | Result |
| --- | --- | --- | --- |
| 2A.1 No session → `ReauthRequiredError` | `getValidToken('unknown')` throws | Test "throws ReauthRequiredError when no session" — pass | **PASS** |
| 2A.2 Expired with no `refresh_token` → reauth | Throws `ReauthRequiredError` | Test "throws ReauthRequiredError when refresh_token absent" — pass | **PASS** |
| 2A.3 Provider rejects refresh → reauth | Throws `ReauthRequiredError` | Test "throws ReauthRequiredError when provider rejects refresh" — pass | **PASS** |
| 2A.4 `withReauth` converts to `{ reauth: true }` | Handler wrapper returns `{ ok:false, reauth:true }` instead of throwing | Test "withReauth converts ReauthRequiredError into { reauth: true }" — pass | **PASS** |
| 2A.5 Other errors bubble through `withReauth` | Non-Reauth errors re-thrown | Test "withReauth lets other errors bubble" — pass | **PASS** |
| 2A.6 UI redirects to sign-in on `{ reauth: true }` | Lane 4 sign-in UI handler | Lane 4 sign-in PR (#7) sprites/signin-ui still OPEN; not exercised here | **DEFERRED** to Lane 4 acceptance |

### 3A. Security audit checklist (against 42b712a)

| # | Check | Method | Result |
| --- | --- | --- | --- |
| 3A.1 | Access / refresh token never returned to popup or content scripts | `handleCallback` response body asserted to omit `access_token`/`refresh_token` | **PASS** — test "handleCallback result contains no access_token / refresh_token" pass; source returns only `{ ok, user_id }` (`sprites-auth.js:275–281`) |
| 3A.2 | Token never appears in URL query/fragment | Tokens flow only via POST to `tokenUrl`; redirect URL is consumed and parsed once | **PASS** — `sprites-auth.js:236–252` POSTs `application/x-www-form-urlencoded` to `tokenUrl`; redirect URL never logged |
| 3A.3 | Confidentiality at rest (cookie HttpOnly equivalent) | AES-GCM encryption of token columns | **PASS** — `sprites-store.js:144–155 encryptColumn` uses `crypto.subtle.encrypt('AES-GCM', key, plaintext)` with fresh IV per call; raw-on-disk test asserts ciphertext, not plaintext |
| 3A.4 | Transport security (Secure equivalent) | Endpoint URLs operator-provisioned; manifest extends `connect-src` for sprites.dev host | **PASS (config-dependent)** — `manifest.json` host_permission + `connect-src` listed in PR #4 body; client never invents `http://` URLs. Operator must provision `https://` `authorizeUrl`/`tokenUrl` via `setConfig` |
| 3A.5 | Cross-site request equivalent (SameSite) | N/A — Chrome extension service worker, not browser-cookie context | **N/A** — `chrome.identity.launchWebAuthFlow` provides the cross-origin redirect with extension-id-bound `redirect_uri`; no third-party cookie surface |
| 3A.6 | OAuth `state` validated, single-use | State stashed under `sprites:pending_auth`; consumed on use even on failure | **PASS** — `sprites-auth.js:225–229` always removes pending before validating; mismatch throws |
| 3A.7 | PKCE `code_verifier` (S256) | Verifier 64-byte base64url; challenge SHA-256(verifier) base64url; `code_challenge_method=S256` | **PASS** — `sprites-auth.js:151–168`; verified by tests |
| 3A.8 | Tokens stored encrypted at rest | AES-GCM with key seeded once and stashed in `chrome.storage.local`; per-row IV | **PASS** — `sprites-store.js encryptColumn`; "userSessions raw on-disk row stores ciphertext, not plaintext" test pass |
| 3A.9 | Refresh-token rotation preserved (no downgrade) | When provider omits new `refresh_token`, prior one is retained; new one persists when issued | **PASS** — tests "refreshes when expired and persists rotated tokens" + "keeps prior refresh_token when provider omits rotation" pass; `sprites-auth.js:348` |
| 3A.10 | No replay of authorization code (state consumed even on error) | Pending entry deleted before validation | **PASS** — `sprites-auth.js:223–226`; covered by "rejects state mismatch and clears pending" |
| 3A.11 | Pending-auth TTL enforced | 10 min; older pending entries rejected | **PASS** — `PENDING_TTL_MS = 600_000`; "rejects expired pending request" test pass |
| 3A.12 | No hard-coded sprites.dev URLs / client_id | `setConfig({...})` required at install time | **PASS** — `sprites-auth.js:83–97` rejects missing required keys; no defaults |
| 3A.13 | Bundle / source string-leakage check | grep build output for token strings | **N/A** — Chrome MV3 extension is shipped as source; equivalent property is 3A.1 (no token in any handler response body) |

### 1A. Summary (Recovery 1/10)

- **PASS**: 17 (PKCE, state lifecycle, encryption-at-rest, refresh-rotation discipline, no-token-in-response, OIDC fallback, provider-error handling, reauth signaling).
- **N/A**: 2 (cookie SameSite + bundle-string leak — replaced by extension-architecture equivalents above).
- **DEFERRED**: 2 (end-to-end browser flow with live sprites.dev endpoints; UI redirect on `{ reauth: true }`) — both require Lane 4/6 (PRs #7, #10, #11) to land plus operator-provisioned client_id/URLs.

### Risk-tier note

Audit ran against an unmerged integration branch. `main` is still empty of
sprites.dev code. Conductor must merge PRs #2 → #4 → #7/#10/#11 in dependency
order before this audit's PASS verdicts apply to the shipping artifact.
