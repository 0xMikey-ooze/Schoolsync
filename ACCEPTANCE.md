# Acceptance Verification

## Re-Auth Flow

Verifies the contract that authenticated sprites.dev API calls return
`401 { reauth: true }` and clear the stored token whenever the token is
missing, expired, or rejected upstream — so the extension UI redirects
to sign-in.

Reference test: `test/reauth-flow.test.mjs`
Reference checklist: `docs/reauth-flow-checklist.md`

### Automated contract tests

Run on this branch (`test/reauth-flow`):

```
$ node --test test/reauth-flow.test.mjs
# tests 4
# pass 4
# fail 0
```

| # | Scenario                                       | Result |
|---|------------------------------------------------|--------|
| 1 | First-run / missing token → reauth required    | PASS   |
| 2 | Mid-session expiry → reauth + token cleared    | PASS   |
| 3 | Upstream 401 → reauth + token cleared          | PASS   |
| 4 | Happy path (valid token) → request passes      | PASS   |

The automated suite exercises a self-contained reference implementation
of the wrapper. Integrators should re-target the test at the merged
`src/lib/sprites-*` wrapper once those branches land on `main`; the
contract assertions remain the same.

### Manual scenarios in the integrated extension build

To be filled in by the operator (or a follow-up dogfood team) once the
integrated build is loaded as an unpacked extension. Steps in
`docs/reauth-flow-checklist.md`.

| # | Scenario                                       | Result   | Build SHA | Notes |
|---|------------------------------------------------|----------|-----------|-------|
| 1 | First-run: no token in storage                 | PENDING  | -         | -     |
| 2 | Mid-session expiry (force `expires_at` past)   | PENDING  | -         | -     |
| 3 | Upstream revocation (tampered access token)    | PENDING  | -         | -     |
| 4 | Happy path baseline                            | PENDING  | -         | -     |

PENDING because sibling teams' integrated build (`src/lib/sprites-*`,
popup sign-in view) is not present in this team's worktree at the time
of writing — `main` here contains only the original deep-crawler commit.
The contract tests on this branch are sufficient to gate any future
integrated wrapper.
