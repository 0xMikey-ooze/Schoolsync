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
