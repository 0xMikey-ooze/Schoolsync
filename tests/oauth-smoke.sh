#!/usr/bin/env bash
# Static preconditions for the sprites.dev OAuth smoke test.
#
# This script does NOT exercise the live OAuth round-trip — that part is
# browser-bound and lives in tests/oauth-smoke.md. It DOES catch the most
# common reasons the round-trip fails before a tester gets to the browser:
#   - missing OAuth source files
#   - manifest missing the `identity` permission
#   - missing AES-GCM crypto helper
#   - plaintext token markers leaking into the bundle
#
# Exit 0 = preconditions PASS. Non-zero = at least one FAIL; see stderr.
#
# Usage:  bash tests/oauth-smoke.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0

ok()   { printf '  PASS  %s\n' "$1";        PASS=$((PASS + 1)); }
bad()  { printf '  FAIL  %s\n' "$1" >&2;    FAIL=$((FAIL + 1)); }
note() { printf '  ----  %s\n' "$1"; }

require_file() {
  local path="$1"
  if [ -f "$path" ]; then
    ok "$path exists"
  else
    bad "$path missing"
  fi
}

require_grep() {
  # require_grep <pattern> <file> <human description>
  local pattern="$1" path="$2" desc="$3"
  if [ ! -f "$path" ]; then
    bad "$desc: source file $path missing"
    return
  fi
  if grep -qE "$pattern" "$path"; then
    ok "$desc"
  else
    bad "$desc (pattern /$pattern/ not found in $path)"
  fi
}

forbid_grep() {
  # forbid_grep <pattern> <glob> <human description>
  local pattern="$1" glob="$2" desc="$3"
  # shellcheck disable=SC2086  # glob expansion is intentional
  local matches
  matches="$(grep -RIlE "$pattern" $glob 2>/dev/null || true)"
  if [ -z "$matches" ]; then
    ok "$desc"
  else
    bad "$desc — leaked in: $matches"
  fi
}

echo "=== sprites.dev OAuth smoke preconditions ==="
echo "repo: $REPO_ROOT"
echo

echo "[1] OAuth source files present"
require_file "src/lib/sprites-oauth.js"
require_file "src/lib/sprites-oauth-config.js"
require_file "src/lib/sprites-store.js"
echo

echo "[2] AES-GCM token encryption available"
# crypto.js is the existing helper; the merged auth code reuses it.
require_file "src/lib/crypto.js"
require_grep "AES-GCM" "src/lib/crypto.js" "AES-GCM cipher referenced in src/lib/crypto.js"
echo

echo "[3] manifest declares identity permission"
require_grep '"identity"' "manifest.json" "manifest.json declares chrome.identity permission"
require_grep "sprites\\.dev" "manifest.json" "manifest.json host_permissions include sprites.dev"
echo

echo "[4] No plaintext token markers leak into the bundle"
# Non-comment Bearer header strings, hard-coded JWT prefixes, hard-coded
# refresh-token literals. We search src/ only — fixtures under tests/ may
# legitimately contain examples.
forbid_grep "Bearer eyJ"             "src" "no hard-coded Bearer JWT in src/"
forbid_grep "refresh_token *= *['\"]" "src" "no hard-coded refresh_token literal in src/"
forbid_grep "client_secret *= *['\"][^'\"]+['\"]" "src" "no hard-coded client_secret literal in src/"
echo

echo "[5] OAuth flow uses chrome.identity launchWebAuthFlow"
require_grep "launchWebAuthFlow" "src/lib/sprites-oauth.js" \
  "sprites-oauth.js uses chrome.identity.launchWebAuthFlow"
require_grep "code_challenge"    "src/lib/sprites-oauth.js" \
  "sprites-oauth.js sends PKCE code_challenge"
require_grep "state"             "src/lib/sprites-oauth.js" \
  "sprites-oauth.js sends a state nonce"
echo

echo "=== summary ==="
echo "PASS: $PASS    FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  note "Fix the FAIL items above before running the browser checklist in tests/oauth-smoke.md."
  exit 1
fi
note "Static preconditions OK. Continue with tests/oauth-smoke.md in the browser."
exit 0
