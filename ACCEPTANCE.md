# ACCEPTANCE — Schoolsync × sprites.dev OAuth

This document records PASS / FAIL / PENDING for each acceptance step run by
the verification sub-tasks. Each entry includes evidence (command output,
observed value, or a path to a captured artifact). Append new sections; do
not overwrite prior runs.

---

## OAuth Smoke Test — Sign-In Round-Trip

- Source checklist: `tests/oauth-smoke.md`
- Static helper: `tests/oauth-smoke.sh`
- Run on branch / commit: `test/oauth-smoke` @ initial run before sub-task 1 merge
- Date: 2026-05-09
- Tester: SonicSwarm local Claude team (auth-smoke sub-task 2/4)

### Static preconditions (`bash tests/oauth-smoke.sh`)

| ID  | Step                                                             | Result  | Evidence |
| --- | ---------------------------------------------------------------- | ------- | -------- |
| S1  | `src/lib/sprites-oauth.js` exists                                | FAIL    | Script exit 1; file not present on `main` (sub-task 1 "Merge Feature Branches to Main" still running). |
| S2  | `src/lib/sprites-oauth-config.js` exists                         | FAIL    | Same — feature branch unmerged. |
| S3  | `src/lib/sprites-store.js` exists                                | FAIL    | Same — feature branch unmerged. |
| S4  | `src/lib/crypto.js` exists and references `AES-GCM`              | PASS    | Existing helper detected. |
| S5  | `manifest.json` declares `"identity"` permission                 | FAIL    | Permission list in `main` is `["storage","alarms","offscreen"]`. |
| S6  | `manifest.json` host_permissions include `sprites.dev`           | FAIL    | Not present on unmerged `main`. |
| S7  | No hard-coded `Bearer eyJ` JWT in `src/`                          | PASS    | grep returns no matches. |
| S8  | No hard-coded `refresh_token = '...'` literal in `src/`           | PASS    | grep returns no matches. |
| S9  | No hard-coded `client_secret = '...'` literal in `src/`           | PASS    | grep returns no matches. |
| S10 | `sprites-oauth.js` uses `chrome.identity.launchWebAuthFlow`       | FAIL    | Source file missing. |
| S11 | `sprites-oauth.js` sends PKCE `code_challenge`                    | FAIL    | Source file missing. |
| S12 | `sprites-oauth.js` sends a `state` nonce                          | FAIL    | Source file missing. |

**Static gate verdict:** FAIL — 5 PASS / 8 FAIL. Re-run after sub-task 1
("Merge Feature Branches to Main") lands and the integrated build is on `main`.

### Browser round-trip (`tests/oauth-smoke.md`)

| ID  | Step                                              | Result  | Evidence |
| --- | ------------------------------------------------- | ------- | -------- |
| B1  | Load extension unpacked, popup renders sign-in    | PENDING | Blocked: integrated `main` not yet built. |
| B2  | Click sign-in launches `launchWebAuthFlow`        | PENDING | Blocked: depends on S1/S10. |
| B3  | sprites.dev redirects with code+state to chromiumapp.org | PENDING | Blocked: depends on B2. |
| B4  | Callback verifies `state` and exchanges code for tokens | PENDING | Blocked: depends on B3. |
| B5  | Stored session is AES-GCM ciphertext, not plaintext JWT | PENDING | Blocked: depends on B4. **CRITICAL gate.** |
| B6  | Dashboard renders real assignments (≥1 item, real timestamp) | PENDING | Blocked: depends on B5. |
| B7  | Reload preserves session without re-prompting     | PENDING | Blocked: depends on B5. |

**Round-trip verdict:** PENDING — cannot execute until sub-task 1 produces
an integrated `main` build with the OAuth source files merged. Re-run the
checklist immediately after merge and update this section in place (or add a
dated re-run section below).

### Reproduction commands

```bash
git checkout main
git pull --ff-only
bash tests/oauth-smoke.sh
# If exit 0, follow tests/oauth-smoke.md in Chrome.
```

### Notes

- This sub-task (2/4 of "OAuth Flow & Security Audit Verification") only
  authored the smoke deliverables. It did not modify auth, session, or
  manifest source files; those are owned by upstream feature lanes and the
  merge sub-task. See the team handoff for the forbidden-paths list.
- The sub-tasks 3/4 (re-auth flow on 401) and 4/4 (security audit checklist)
  consume this same `ACCEPTANCE.md` file and append their own sections.
