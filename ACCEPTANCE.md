# ACCEPTANCE — Schoolsync × sprites.dev OAuth + LLM Assignment Intelligence

**PRD:** Add sprites.dev OAuth sign-in to Schoolsync, poll assignment data every 15 min, and use an LLM to categorize by subject, flag overdue items, and surface deadline summaries.

**Evaluation date:** 2026-05-09
**Evaluation target:** `origin/main` at commit `0416910` ("Add deep crawler — visits each student profile for full data extraction").
**Verdict:** **NOT ACCEPTED** — 0 of 7 criteria pass on `main`.

## Headline finding

Eleven PRs (#1–#11) implementing the PRD slices are **OPEN and unmerged**. None of the sprites.dev / OAuth / LLM / dashboard code has landed on `main`, so end-to-end acceptance verification cannot succeed against the integration target. Every criterion below is therefore marked **FAIL** with the unmerged-PR evidence noted.

The verification sub-tasks for OAuth, LLM, and Scheduler (siblings 1/4–3/4) reached the same conclusion in their team heartbeats: the working tree on `main` is the original Chrome extension only — no `package.json`, no `server/`, no `src/lib/sprites-*`, no `/api/refresh`, no LLM pipeline.

## Open PRs (none merged)

| PR | Lane | Base | Head | Status |
|----|------|------|------|--------|
| [#1](https://github.com/0xMikey-ooze/Schoolsync/pull/1) | LLM schema/prompt/DB table (t3) | `main` | `team-dOYOgjJ2b0t-llm-schema` | OPEN |
| [#2](https://github.com/0xMikey-ooze/Schoolsync/pull/2) | Lane 1 token store + assignment cache schema | `main` | `sprites/db-schema-token-store` | OPEN |
| [#3](https://github.com/0xMikey-ooze/Schoolsync/pull/3) | sprites.dev OAuth (PKCE) for MV3 | `main` | `feat/sprites-oauth-extension` | OPEN |
| [#4](https://github.com/0xMikey-ooze/Schoolsync/pull/4) | Lane 2 OAuth client (PKCE + refresh) | `sprites/db-schema-token-store` | `sprites/auth-session-backend` | OPEN |
| [#5](https://github.com/0xMikey-ooze/Schoolsync/pull/5) | Periodic + on-demand snapshot poll (chrome.alarms) | `main` | `sonicswarm/schoolsync-periodic-poll` | OPEN |
| [#6](https://github.com/0xMikey-ooze/Schoolsync/pull/6) | LLM execution: processSchoolsyncData + dedup | `main` | `team-llm-execution` | OPEN |
| [#7](https://github.com/0xMikey-ooze/Schoolsync/pull/7) | Sign-in UI + reauth guard | `sprites/auth-session-backend` | `sprites/signin-ui` | OPEN |
| [#8](https://github.com/0xMikey-ooze/Schoolsync/pull/8) | Lane 3 polling worker, fetcher, refresh + raw endpoints | `sprites/auth-session-backend` | `sprites/polling-worker` | OPEN |
| [#9](https://github.com/0xMikey-ooze/Schoolsync/pull/9) | Lane 4 LLM pipeline (claude-sonnet-4-6) cache-aware | `sprites/polling-worker` | `sprites/llm-pipeline` | OPEN |
| [#10](https://github.com/0xMikey-ooze/Schoolsync/pull/10) | SchoolsyncPanel — popup dashboard | `sprites/polling-worker` | `team-schoolsync-panel-ui` | OPEN |
| [#11](https://github.com/0xMikey-ooze/Schoolsync/pull/11) | Lane 6 assignment dashboard UI | `main` | `sprites/dashboard-ui` | OPEN |

## Acceptance criteria

### AC-1 — sprites.dev OAuth sign-in (PKCE) — **FAIL**
**Expected:** A user clicks "Sign in with sprites.dev", completes the OAuth (PKCE) authorization flow, and is returned to the extension/app with a valid access + refresh token. CSRF state is verified; auth errors surface to the UI.
**Observed on main:**
- `git ls-tree -r origin/main` returns no `src/lib/sprites-oauth*.js`, no `feat/sprites-oauth-extension` content, and `manifest.json` does not declare the redirect handler.
- `grep -r sprites src/` on `origin/main` returns 0 matches.
**Evidence trail:** Implementation exists on PR #3 (MV3 PKCE) and PR #4 (server-side OAuth client), neither merged.
**Reproduction:**
```bash
git checkout main
grep -r 'sprites' src/ manifest.json    # expect hits, get none
```

### AC-2 — Encrypted token storage with refresh — **FAIL**
**Expected:** Access + refresh tokens are persisted (Lane 1 token store / `sprites_sessions`), encrypted at rest, and refreshed automatically before expiry; `getValidToken(userId)` returns a non-expired token without prompting the user again.
**Observed on main:** No `src/lib/sprites-store.js`, no `server/db/schema.ts`, no `sprites_sessions` table, no `getValidToken` function. PR #2 (token store) and PR #4 (refresh client) define this surface but are unmerged.
**Reproduction:**
```bash
git checkout main && grep -r 'sprites_sessions\|getValidToken' .   # 0 matches
```

### AC-3 — 15-minute polling scheduler — **FAIL**
**Expected:** A background scheduler triggers `fetchSchoolsyncData` every 15 minutes (chrome.alarms in the extension and/or `setInterval` in `instrumentation.ts` server-side). On-demand `schoolsync.refresh` mutation is also wired.
**Observed on main:** Service worker (`src/background/service-worker.js`) has the original sync alarms but no sprites polling alarm. PR #5 (chrome.alarms periodic poll), PR #8 (server polling worker), and PR #6 (LLM execution path) are all unmerged.
**Sibling note:** Scheduler Timing & API Latency Verification (team-L8389Y8f52ooS6MpB_0q3) found no `package.json`, no server entrypoint, and no `/api/refresh` route on disk.
**Reproduction:**
```bash
git checkout main && grep -rn '15.*60.*1000\|setInterval\|sprites' src/background/   # nothing matches sprites polling
```

### AC-4 — sprites.dev assignment fetch with reauth — **FAIL**
**Expected:** Worker calls the sprites.dev assignments endpoint, retries with refreshed token on 401, normalizes the response, and writes the raw payload to `rawAssignmentsCache`.
**Observed on main:** No `src/lib/sprites-fetcher.js`, no `rawAssignmentsCache`. PR #8 implements the lane (19 fetcher tests reportedly green per team-d8Gq4MXqcMrBasAIzVdND heartbeat) but is stacked on PR #4 → #2 and remains unmerged.
**Reproduction:**
```bash
git checkout main && grep -rn 'rawAssignmentsCache\|sprites-fetcher' .   # 0 matches
```

### AC-5 — LLM categorization, overdue flagging, deadline summaries — **FAIL**
**Expected:** A processing pipeline (1) groups assignments by subject, (2) flags items with `dueDate < now` as overdue, and (3) returns a deadline summary structured for UI consumption. SHA-256 dedup avoids reprocessing unchanged payloads. Anthropic call uses prompt caching where applicable (PRD lessons-learned).
**Observed on main:** No `src/lib/sprites-llm.js`, no LLM pipeline module, no `schoolsync_processed` table. PR #1 (schema/prompt), PR #6 (execution + dedup), and PR #9 (cache-aware Anthropic call, claude-sonnet-4-6) are all unmerged.
**Sibling note:** LLM Pipeline Correctness sub-task (team-DQoj9rzYaNSsyrBKye1h2) authored a contract test against the (missing) module and reports it runs red against `main`.
**Reproduction:**
```bash
git checkout main && grep -rn 'sprites-llm\|processSchoolsyncData\|schoolsync_processed' .   # 0 matches
```

### AC-6 — Assignment dashboard UI with overdue highlights and refresh control — **FAIL**
**Expected:** Popup/dashboard surfaces categorized assignments, highlights overdue items, exposes a manual "Refresh" button bound to `schoolsync.refresh`, and shows "Last synced: X min ago".
**Observed on main:** `src/popup/popup.html` has no Schoolsync panel; `components/dashboard/harness-shell.tsx` and `server/trpc/routers/` do not exist; popup contains no `getLatestProcessed` consumer. PR #7 (sign-in UI), PR #10 (popup SchoolsyncPanel), and PR #11 (dashboard UI) are unmerged.
**Reproduction:**
```bash
git checkout main && grep -rn 'SchoolsyncPanel\|getLatestProcessed\|Last synced' src/popup   # 0 matches
```

### AC-7 — End-to-end integration on a fresh clone — **FAIL**
**Expected:** A fresh clone of `main` allows: (a) build/load the extension or start the server, (b) sign in with sprites.dev, (c) wait one polling cycle, (d) see categorized assignments with overdue badges in the UI — with no manual file moves or branch switches required.
**Observed on main:** Steps (b)–(d) cannot run because the underlying code (AC-1 through AC-6) is not on `main`. There is no `package.json` and no server runtime. The OAuth Flow & Security Audit sibling (team-PHEvEHYflQgUrQ2dB0T1H) reached the same conclusion: "cannot smoke-test sign-in → callback → token store → dashboard."
**Reproduction:**
```bash
git clone https://github.com/0xMikey-ooze/Schoolsync && cd Schoolsync
ls package.json server/   # both missing
```

## Filed issues

GitHub issues filed for every failing criterion (links inserted on creation):

- AC-1: https://github.com/0xMikey-ooze/Schoolsync/issues/16
- AC-2: https://github.com/0xMikey-ooze/Schoolsync/issues/17
- AC-3: https://github.com/0xMikey-ooze/Schoolsync/issues/18
- AC-4: https://github.com/0xMikey-ooze/Schoolsync/issues/19
- AC-5: https://github.com/0xMikey-ooze/Schoolsync/issues/20
- AC-6: https://github.com/0xMikey-ooze/Schoolsync/issues/21
- AC-7: https://github.com/0xMikey-ooze/Schoolsync/issues/22

## Recommended path to acceptance

The 11 PRs form a stacked DAG (e.g. #4 → #2, #8 → #4 → #2, #9 → #8, #10 → #8). To unblock acceptance:

1. Land base lanes onto `main` first: PR #2 (schema/token store), PR #1 (LLM schema), PR #5 (chrome.alarms periodic poll).
2. Retarget and merge PR #4 (OAuth client) to `main`.
3. Retarget and merge PR #8 (polling worker) to `main`.
4. Merge PRs #6 / #9 (LLM pipeline).
5. Retarget and merge PRs #7, #10, #11 (UI + sign-in).
6. Re-run acceptance against the post-merge `main`.

Until then, this run cannot be marked accepted regardless of the green test status reported on individual PR branches.
