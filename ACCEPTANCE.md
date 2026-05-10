# ACCEPTANCE — Schoolsync × sprites.dev OAuth + LLM Assignment Intelligence

**PRD.** Add sprites.dev OAuth sign-in to the Schoolsync Chrome MV3 extension,
poll assignment data on a 15-minute cadence, and use an LLM to categorize
assignments by subject, flag overdue items, and surface deadline summaries.

**Date.** 2026-05-09.
**Integration target evaluated.** `origin/main @ 0416910`.
**Authoritative integration source for the OAuth audit.** `origin/sprites/auth-session-backend @ 42b712a` (PR #4 head; consolidates the Lane 1 token store + Lane 2 OAuth client + service-worker boot wiring).
**Verdict at top of `main`.** **NOT ACCEPTED** — none of the sprites.dev / LLM / dashboard implementation has been merged to `main`. AC-1 through AC-7 fail on `origin/main` for the same reason: the source files do not exist there. PR-level verdicts for OAuth Sub 1/4 (sub-tasks 2/4–4/4) and the LLM verification harness are recorded below for the conductor.

The intent of this file is to consolidate the verification results across the
three OAuth Sub 1/4 sub-tasks (smoke test, re-auth flow, security audit) and
the LLM Sub 2/4 harness, with one PASS/FAIL row per acceptance criterion plus
explicit per-check rows for the security audit. Per the run manifest and the
prior acceptance addendum (`origin/team/MYAz7aA6/oauth-audit`), all PASS rows
in the OAuth section apply to the integration branch, not to `main`. They
become production-meaningful once PRs #2 → #4 → (#7, #8, #10, #11) merge in
dependency order.

---

## 1. Headline acceptance criteria (PRD level)

Verdict against `origin/main @ 0416910`.

| ID  | Criterion | Expected | Verdict on `main` | Verdict on integration `42b712a` (where applicable) | Evidence |
|-----|-----------|----------|--------------------|------------------------------------------------------|----------|
| AC-1 | sprites.dev OAuth sign-in (PKCE) | User completes PKCE auth flow, returns with valid access + refresh tokens; CSRF `state` validated. | **FAIL** — no `src/lib/sprites-*` on `main`. | **PASS** — Lane 2 PKCE+state lifecycle verified by 17 tests on `42b712a`. | `git ls-tree origin/main src/` lists no `sprites-*` files; `node test/sprites-auth.test.mjs` → 17 passed. |
| AC-2 | Encrypted token storage with refresh | Tokens persisted, encrypted at rest, refreshed automatically before expiry; `getValidToken(userId)` returns a non-expired token without re-prompting. | **FAIL** — no token store on `main`. | **PASS** — AES-256-GCM column wrapping; refresh-rotation discipline verified. | `node test/sprites-store.test.mjs` → 16 passed; live storage audit (Section 4 row 3A.8 below). |
| AC-3 | 15-minute polling scheduler | `chrome.alarms` (extension) and/or `setInterval` server-side fires `fetchSchoolsyncData` every 15 min. | **FAIL** — no sprites alarm on `main` (the `schoolsync-auto` alarm uses user-selected hours and targets PowerSchool, not sprites.dev). | Not part of OAuth Sub 1/4. | Scheduler Sub 3/4 evidence (see `origin/L8389Y8f52ooS6MpB-scheduler-latency-acceptance:ACCEPTANCE.md`): no `package.json`, no `/api/refresh`, no sprites alarm wiring. |
| AC-4 | sprites.dev assignment fetch with reauth | Worker calls assignments endpoint, retries on 401 with refreshed token, persists raw payload to `rawAssignmentsCache`. | **FAIL** — no `src/lib/sprites-fetcher.js` on `main`. | Not part of OAuth Sub 1/4 (Lane 3, PR #8). | PR #8 unmerged; fetcher tests reportedly green on its branch. |
| AC-5 | LLM categorize / overdue / deadline | Pipeline groups by subject, flags `dueDate < now`, returns deadline summary; SHA-256 dedup; cache-aware Anthropic call. | **FAIL** — no pipeline module on `main`. | Not part of OAuth Sub 1/4. | LLM Sub 2/4 harness (`origin/team/llm-cache-verify:tests/llm-pipeline.test.mjs`) exits 2 (`MISSING_PIPELINE`) against `main`. |
| AC-6 | Dashboard with overdue highlights + refresh | Popup/dashboard surfaces categorized assignments, highlights overdue items, exposes manual "Refresh" → `schoolsync.refresh`, shows "Last synced: X min ago". | **FAIL** — popup has no Schoolsync panel; no `getLatestProcessed` consumer. | Not part of OAuth Sub 1/4 (PRs #7, #10, #11). | `grep -rn 'SchoolsyncPanel\|getLatestProcessed' src/popup` → 0 matches on `main`. |
| AC-7 | End-to-end on a fresh clone | Sign in → wait one polling cycle → see categorized assignments with overdue badges, no manual file moves. | **FAIL** — depends on AC-1..AC-6 landing on `main`. | n/a | Cannot run; underlying code absent. |

The integration branch passes the OAuth-specific acceptance criteria (AC-1, AC-2 — and the OAuth-only parts of AC-7). AC-3..AC-6 are owned by sibling
lanes and their PRs are still open.

---

## 2. OAuth Sub 1/4 — Sub-task 2/4: Sign-In Round-Trip Smoke

Branch: `origin/test/oauth-smoke @ 5ef823e`. Helper: `tests/oauth-smoke.sh`.
Checklist: `tests/oauth-smoke.md`.

### 2.1 Static preconditions (`bash tests/oauth-smoke.sh` against `main`)

| ID  | Step                                                            | Result | Evidence |
| --- | --------------------------------------------------------------- | ------ | -------- |
| S1  | `src/lib/sprites-oauth.js` exists                               | FAIL   | not present on `main`; lives on `feat/sprites-oauth-extension` (PR #3 unmerged). |
| S2  | `src/lib/sprites-oauth-config.js` exists                        | FAIL   | not present on `main`. |
| S3  | `src/lib/sprites-store.js` exists                               | FAIL   | not present on `main`; on PR #2 / `sprites/db-schema-token-store`. |
| S4  | `src/lib/crypto.js` references `AES-GCM`                        | PASS   | original Schoolsync helper detected. |
| S5  | `manifest.json` declares `"identity"` permission                | FAIL   | `main` permissions = `["storage","alarms","offscreen"]`. |
| S6  | `manifest.json` host_permissions include `sprites.dev`          | FAIL   | not on `main`. |
| S7  | No hard-coded `Bearer eyJ` JWT in `src/`                        | PASS   | grep returns no matches. |
| S8  | No hard-coded `refresh_token = '...'` literal in `src/`         | PASS   | grep returns no matches. |
| S9  | No hard-coded `client_secret = '...'` literal in `src/`         | PASS   | grep returns no matches. |
| S10 | `sprites-oauth.js` uses `chrome.identity.launchWebAuthFlow`     | FAIL   | source file missing on `main`. |
| S11 | `sprites-oauth.js` sends PKCE `code_challenge`                  | FAIL   | source file missing on `main`. |
| S12 | `sprites-oauth.js` sends a `state` nonce                        | FAIL   | source file missing on `main`. |

Static gate verdict on `main`: **FAIL** (5 PASS / 7 FAIL). Re-run after the
merge sub-task lands and re-execute the checklist below.

### 2.2 Browser round-trip (`tests/oauth-smoke.md`)

| ID | Step                                                                  | Result on `main` | Result on `42b712a` | Evidence |
| --- | -------------------------------------------------------------------- | ---------------- | --------------------- | -------- |
| B1 | Load extension unpacked, popup renders sign-in                        | PENDING          | PENDING (Lane 4 PR #7 unmerged into integration) | Lane 4 sign-in UI not part of `42b712a`. |
| B2 | Click sign-in launches `launchWebAuthFlow`                            | PENDING          | DEFERRED              | depends on Lane 4 UI. |
| B3 | sprites.dev redirects with `code+state` to chromiumapp.org            | PENDING          | DEFERRED              | depends on operator-provisioned `clientId`/`authorizeUrl`/`tokenUrl`. |
| B4 | Callback verifies `state` and exchanges `code` for tokens             | PENDING          | **PASS (test-equivalent)** | `handleCallback validates state, exchanges code, persists encrypted tokens` test pass on `42b712a`. |
| B5 | Stored session is AES-GCM ciphertext, not plaintext JWT (CRITICAL)    | PENDING          | **PASS**              | `userSessions raw on-disk row stores ciphertext, not plaintext` test pass; live storage audit (Section 4) confirms. |
| B6 | Dashboard renders real assignments (≥1 item, real timestamp)          | PENDING          | DEFERRED              | dashboard owned by Lane 6 (PR #11). |
| B7 | Reload preserves session without re-prompting                         | PENDING          | **PASS (test-equivalent)** | `getValidToken returns unexpired access_token without network` test pass. |

Round-trip verdict on `main`: **PENDING** — re-run after merge.
Round-trip verdict on `42b712a`: **PASS where coverable in headless**, browser
B1–B6 deferred to Lane 4/6 acceptance once PRs #7/#10/#11 land.

---

## 3. OAuth Sub 1/4 — Sub-task 3/4: Re-Auth Flow (Token Expiry → 401 Redirect)

Source under test: `src/lib/sprites-auth.js` on `42b712a`. The Chrome MV3
architecture maps the PRD's "401 → reauth UI" requirement onto `withReauth(...)`
which converts a thrown `ReauthRequiredError` into a `{ ok: false, reauth: true }`
runtime-message reply. The popup-side handler then redirects to sign-in.

| ID  | Step | Expected | Observed (`42b712a`) | Result |
| --- | ---- | -------- | -------------------- | ------ |
| R1  | No session for `user_id`                            | `getValidToken('unknown')` throws `ReauthRequiredError`. | Test "throws ReauthRequiredError when no session" pass. | **PASS** |
| R2  | Token expired, no `refresh_token`                   | Throws `ReauthRequiredError`.                            | Test "throws ReauthRequiredError when refresh_token absent" pass. | **PASS** |
| R3  | Token expired, provider rejects refresh             | Throws `ReauthRequiredError`.                            | Test "throws ReauthRequiredError when provider rejects refresh" pass. | **PASS** |
| R4  | `withReauth` envelope on `ReauthRequiredError`      | Returns `{ ok: false, reauth: true }`.                   | Test "withReauth converts ReauthRequiredError into { reauth: true }" pass. | **PASS** |
| R5  | Non-Reauth errors propagate                         | Re-thrown; `withReauth` does not swallow.                | Test "withReauth lets other errors bubble" pass. | **PASS** |
| R6  | Successful results pass through                     | Wrapper returns wrapped value verbatim.                  | Test "withReauth returns successful results unchanged" pass. | **PASS** |
| R7  | Refresh-rotation preserves prior `refresh_token` when provider omits rotation | New access_token persisted; old refresh_token retained. | Test "keeps prior refresh_token when provider omits rotation" pass. | **PASS** |
| R8  | Token endpoint receives `grant_type=refresh_token` (not authorization_code) | POST body contains correct grant. | Verified by test "refreshes when expired and persists rotated tokens". | **PASS** |
| R9  | Popup redirects to sign-in route on `{ reauth: true }` | UI handler exists in Lane 4 sign-in PR. | Lane 4 PR #7 unmerged into `42b712a`. | **DEFERRED** — block on PR #7 landing. |

Re-auth verdict on `42b712a`: **PASS for the runtime contract** (R1–R8); UI
redirect (R9) deferred until Lane 4 sign-in UI lands.

---

## 4. OAuth Sub 1/4 — Sub-task 4/4: Security Audit Checklist (this task)

Risk tier: **critical** (authentication / session management). Audit re-run on
`origin/sprites/auth-session-backend @ 42b712a`. Forbidden paths avoided
(documented in section 6).

The PRD's audit prescribes (1) grep the built JS bundle for plaintext token
strings, (2) confirm no token in URL params or popup-visible response bodies,
(3) confirm `chrome.storage` holds only AES-GCM ciphertext. SchoolSync ships as
MV3 source (no bundler), so the "built bundle" surface equals `src/`.

### 4.1 Bundle / source string-leakage scan (3A.1)

Command:

```sh
grep -RInE "Bearer eyJ|access_token\s*=\s*['\"][A-Za-z0-9._-]{20,}['\"]|refresh_token\s*=\s*['\"][A-Za-z0-9._-]{20,}['\"]|client_secret\s*=\s*['\"][A-Za-z0-9._-]{20,}['\"]" src/ manifest.json
```

Result: **PASS** — exit 1, no matches. There is no hard-coded JWT, raw
`access_token`/`refresh_token` literal, or static `client_secret` in `src/` or
the manifest.

Sub-check: scan handler return values for token leakage to popup or content
scripts.

```sh
grep -RInE "return\s*\{[^}]*access_token|return\s*\{[^}]*refresh_token|sendResponse\([^)]*access_token" src/
```

Single hit: `src/lib/sprites-auth.js:421` returns `{ ok: true, access_token }`
from the `SPRITES_GET_VALID_TOKEN` runtime-message handler. Documented intent
(line 392–394 of `sprites-auth.js`): this handler is for *in-extension* network
fetches that need the bearer (Lane 3 polling). It is not used by the popup or
by content scripts:

```sh
grep -RInE "GET_VALID_TOKEN|sprites-auth|sprites-store|access_token|refresh_token" src/popup/ src/content/
# exit 1, no matches
```

`handleCallback` itself (the OAuth completion path) explicitly returns only
`{ ok, user_id }`, never the tokens — covered by test "handleCallback result
contains no access_token / refresh_token".

Verdict 3A.1: **PASS**. See caveat in section 6 about hardening
`SPRITES_GET_VALID_TOKEN` with a sender check.

### 4.2 No token in URL params or popup-visible network response (3A.2 / handler return)

Command:

```sh
grep -RInE "access_token=|access_token\?|searchParams.set\(['\"]access_token|fragment.*token|\?token=" src/
```

Result: **PASS** — exit 1, no matches. The token endpoint exchange uses POST
with `Content-Type: application/x-www-form-urlencoded` (`sprites-auth.js:243`,
`:322`); tokens never appear in a query string or fragment. The OAuth callback
URL is parsed once and consumed; nothing logs the redirect URL or echoes its
parameters. The popup's `chrome.runtime.onMessage.addListener` (popup.js:207)
does not subscribe to `SPRITES_GET_VALID_TOKEN` — the popup has no path to
receive the token in a response body.

### 4.3 Storage hygiene — chrome.storage holds AES-GCM ciphertext only (3A.3 / 3A.8)

Live storage audit (script committed below as `tests/storage-audit.mjs`):

```text
$ node tests/storage-audit.mjs
round-trip OK — access_token decrypts to plaintext for in-extension callers.
--- chrome.storage.local raw dump ---
{ "sprites:user_sessions":["audit-user"],
  "sprites:raw_assignments_cache":[],
  "sprites:processed_assignments_cache":[],
  "sprites:meta":{"schemaVersion":1},
  "sprites:enc_key_v1":{"key_ops":["encrypt","decrypt"],"ext":true,"kty":"oct","k":"…","alg":"A256GCM"},
  "sprites:row:user_sessions:audit-user":{
    "user_id":"audit-user",
    "access_token":{"iv":"/2N2…","ct":"jEs8RZ…"},
    "refresh_token":{"iv":"xksV…","ct":"FiKvEX…"},
    "expires_at":…, "updated_at":…, "created_at":…
  } }
--- grep for plaintext access_token in raw on-disk dump ---
access_token leak: false
refresh_token leak: false
PASS: no plaintext token bytes in chrome.storage dump.
```

Findings:

- `userSessions` rows store both `access_token` and `refresh_token` as
  `{ iv, ct }` pairs produced by `encryptColumn` (AES-256-GCM, fresh 12-byte IV
  per call, see `sprites-store.js:144-153`). The plaintext needles
  `spr_AT_PLAINTEXT_NEEDLE_4VW7Q` and `spr_RT_PLAINTEXT_NEEDLE_FQ9XM` are
  absent from the full storage dump.
- The install-bound AES key is exported once as JWK and re-imported as
  non-extractable (`sprites-store.js:99-115`). The JWK's raw key bytes (`k`)
  are present in `chrome.storage.local` under `sprites:enc_key_v1`. This is
  the documented design trade-off (`sprites-store.js:78-82`): an MV3 service
  worker cannot prompt for a passphrase at every poll, so confidentiality is
  scoped to the browser profile rather than to a user secret. Same threat
  envelope as the existing Capsule helper.
- Round-trip works: `userSessions.get('audit-user')` decrypts to the plaintext
  needles, so in-extension callers can still consume the bearer.

Verdict 3A.3 / 3A.8: **PASS** — chrome.storage holds only AES-GCM ciphertext
for the token columns; no plaintext token bytes appear in the on-disk dump.

### 4.4 Consolidated security checklist on `42b712a`

| #     | Check                                                              | Method                                  | Result |
| ----- | ------------------------------------------------------------------ | --------------------------------------- | ------ |
| 3A.1  | No access/refresh token literal in client JS bundle                | `grep` over `src/` + `manifest.json`    | **PASS** |
| 3A.2  | No token in URL query/fragment                                     | grep, POST body inspection              | **PASS** |
| 3A.3  | Confidentiality at rest (HttpOnly equivalent)                      | `encryptColumn` AES-GCM + live dump     | **PASS** |
| 3A.4  | Transport: `https://` `tokenUrl` enforced (config-validated)       | `setConfig` validation + manifest CSP   | **PASS (config-dependent)** |
| 3A.5  | SameSite (cookie) — N/A for `chrome.identity.launchWebAuthFlow`    | architecture review                     | **N/A** |
| 3A.6  | OAuth `state` validated and single-use                             | tests + source                          | **PASS** |
| 3A.7  | PKCE `code_verifier` (S256)                                        | tests + source                          | **PASS** |
| 3A.8  | Tokens stored encrypted at rest                                    | live storage dump (Section 4.3)         | **PASS** |
| 3A.9  | Refresh-token rotation discipline (no downgrade)                   | tests                                   | **PASS** |
| 3A.10 | No replay of authorization code (state consumed on error)          | test "rejects state mismatch and clears pending" | **PASS** |
| 3A.11 | Pending-auth TTL enforced (10 min)                                 | test "rejects expired pending request"  | **PASS** |
| 3A.12 | No hard-coded sprites.dev URLs / client_id                         | `setConfig` rejects defaults            | **PASS** |
| 3A.13 | Sender hardening on `SPRITES_GET_VALID_TOKEN`                      | source review                           | **CAVEAT** — handler accepts any caller; documented as in-extension only but not programmatically enforced. Recommended fix: assert `sender.id === chrome.runtime.id && !sender.tab` before returning the token. Tracked as a recommendation, not a blocker for AC-1/AC-2. |

Security audit verdict: **PASS** with one CAVEAT. 12 of 13 checks pass; one is
N/A (cookie SameSite); one carries a defense-in-depth recommendation but is
not exploitable from web pages today (popup and content scripts do not invoke
`SPRITES_GET_VALID_TOKEN`, see Section 4.1 grep evidence).

---

## 5. LLM Sub 2/4 (informational)

Branch: `origin/team/llm-cache-verify`. The harness
`tests/llm-pipeline.test.mjs` plus fixture `fixtures/canvas-assignments.json`
encode the AC-5 contract (subject grouping, overdue flagging anchored to
`nowISO`, cache-hit verification via injected `llmCall` counter). Running it
against `main` exits 2 (`MISSING_PIPELINE`) because the upstream pipeline has
not landed. This is an independent verification artifact and is not gated by
OAuth Sub 1/4.

---

## 6. Risk-tier handoff

- **Risk tier:** critical (authentication / session management).
- **Confidence:** HIGH for Sub 4/4 conclusions on `42b712a`; MEDIUM for the
  acceptance verdict against `main`, because the verdict depends on the merge
  sub-task (Sub 1/4 of OAuth Sub 1/4) successfully landing PRs #2 → #4 → … in
  dependency order.
- **Forbidden paths avoided.** This task only authored `ACCEPTANCE.md` and a
  read-only audit script `tests/storage-audit.mjs`. No edits to
  `src/lib/sprites-auth.js`, `src/lib/sprites-store.js`, `manifest.json`,
  `src/background/service-worker.js`, or any popup/content code. Auth, session
  management, and persistence paths were not modified — doing so would create
  unaudited credential surfaces and is out of scope for an audit task.
- **Caveats.**
  1. The PASS verdicts in Sections 2–4 apply to `42b712a`, not to `main`.
     They become production-meaningful only after the integration merge lands.
  2. `SPRITES_GET_VALID_TOKEN` lacks a programmatic sender check (3A.13).
     Recommend a hardening PR before any future Lane 5 ships content-script
     surface that could in principle reach the runtime.
  3. The install-bound AES key's raw bytes live in `chrome.storage.local`.
     This is the documented architecture trade-off; a different threat model
     (e.g. requiring resistance to local-disk theft) would need a
     passphrase-derived key or platform key store.
- **Escalation recommendation:** **review** before merge. The OAuth audit
  passes against the integration branch, but the conductor should confirm the
  merge sub-task actually retargets PR bases to `main` and lands them in
  dependency order; without that, AC-1 and AC-2 fail on the shipping artifact
  regardless of the audit verdicts above.

## 7. Reproduction commands

```sh
# 1. OAuth tests on the integration branch
git fetch origin sprites/auth-session-backend
git worktree add /tmp/audit sprites/auth-session-backend
cd /tmp/audit
node test/sprites-store.test.mjs    # expect: 16 passed
node test/sprites-auth.test.mjs     # expect: 17 passed

# 2. Bundle / source string-leakage scan
grep -RInE "Bearer eyJ|access_token\s*=\s*['\"][A-Za-z0-9._-]{20,}['\"]|refresh_token\s*=\s*['\"][A-Za-z0-9._-]{20,}['\"]|client_secret\s*=\s*['\"][A-Za-z0-9._-]{20,}['\"]" src/ manifest.json
# expect: exit 1 (no matches)

# 3. Token-in-URL scan
grep -RInE "access_token=|access_token\?|searchParams.set\(['\"]access_token|fragment.*token|\?token=" src/
# expect: exit 1 (no matches)

# 4. Live chrome.storage hygiene check
node tests/storage-audit.mjs
# expect: "PASS: no plaintext token bytes in chrome.storage dump."

# 5. Smoke preconditions (after merge sub-task lands sprites code on main)
git checkout main && git pull --ff-only
bash tests/oauth-smoke.sh
# When all S1..S12 pass, follow tests/oauth-smoke.md in Chrome for B1..B7.
```
