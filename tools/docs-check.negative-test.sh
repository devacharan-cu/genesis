#!/usr/bin/env bash
#
# Negative test for tools/docs-check.mjs.
#
# A checker that cannot fail is worse than no checker: it reports green
# forever and everyone believes it. This script deliberately breaks the
# documentation in seven different ways, in a throwaway copy of the repo, and
# asserts that docs-check.mjs detects each one.
#
# Each case also verifies that the mutation ACTUALLY CHANGED A FILE. Without
# that guard, a sed pattern that silently matches nothing produces a green
# checker run and looks like a passing test — which is exactly the failure
# mode this script exists to prevent. (It caught one such case on first run.)
#
# Usage: bash tools/docs-check.negative-test.sh
# Exit:  0 = every breakage was detected, 1 = at least one went unnoticed.

set -u

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

detected=0
missed=0

run_case() {
  local name="$1"; shift

  rm -rf "$TMP/w"
  cp -r "$SRC" "$TMP/w"
  rm -rf "$TMP/w/.git"

  local before after
  before="$(cd "$TMP/w" && find docs README.md -type f -exec cat {} + | cksum)"
  ( cd "$TMP/w" && "$@" ) >/dev/null 2>&1
  after="$(cd "$TMP/w" && find docs README.md -type f -exec cat {} + 2>/dev/null | cksum)"

  if [ "$before" = "$after" ]; then
    echo "  INVALID  $name -> mutation changed nothing; test case is broken"
    missed=$((missed + 1))
    return
  fi

  local out code
  out="$(cd "$TMP/w" && node tools/docs-check.mjs 2>&1)"
  code=$?

  if [ $code -ne 0 ]; then
    echo "  detected  $name"
    echo "$out" | grep -E '^\s+✗' | head -2 | sed 's/^/              /'
    detected=$((detected + 1))
  else
    echo "  MISSED    $name -> checker returned 0 despite real breakage"
    missed=$((missed + 1))
  fi
}

echo "Negative tests for tools/docs-check.mjs"
echo "────────────────────────────────────────────────────────────"

run_case "enum drift: NodeType loses a value in SPEC-03" \
  sed -i '0,/^DEPLOYMENT$/{/^DEPLOYMENT$/d}' docs/architecture/03-GRAPH-ARCHITECTURE.md

run_case "broken internal link" \
  sed -i 's|(06-SECURITY-ARCHITECTURE\.md)|(06-NOPE.md)|' docs/architecture/01-COGNITIVE-ARCHITECTURE.md

run_case "broken heading anchor" \
  sed -i 's|#8-phasing|#99-nonexistent|' README.md

run_case "missing required document" \
  rm docs/architecture/06-SECURITY-ARCHITECTURE.md

run_case "missing required section" \
  sed -i 's|^## 4\. Authority hierarchy$|## 4. Something else|' docs/architecture/02-MEMORY-ARCHITECTURE.md

run_case "ADR present but absent from the index" \
  cp docs/adr/0001-monorepo-layout.md docs/adr/0099-unindexed.md

run_case "honesty statement removed" \
  sed -i 's|Generation is not verification|Generation is fine actually|g' docs/architecture/05-VERIFICATION-ARCHITECTURE.md

echo "────────────────────────────────────────────────────────────"
echo "detected: $detected   missed/invalid: $missed"

if [ $missed -ne 0 ]; then
  echo "FAIL — docs-check.mjs did not catch every deliberate breakage."
  exit 1
fi
echo "PASS — every deliberate breakage was detected."
