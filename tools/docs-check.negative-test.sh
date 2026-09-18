#!/usr/bin/env bash
#
# Negative test for tools/docs-check.mjs.
#
# A checker that cannot fail is worse than no checker: it reports green forever
# and everyone believes it.
#
# Three guards keep this test from passing vacuously. All three were added after
# being caught out:
#
#   1. The BASELINE must be clean. If the unmodified tree already fails, every
#      case "detects" that pre-existing failure and proves nothing. This is not
#      hypothetical — an Authority enum drift once made all seven cases pass
#      while testing nothing.
#   2. Each mutation must actually change a file. A pattern matching nothing
#      once produced a green run that looked like a pass.
#   3. Each case names the message it expects. A non-zero exit for some
#      unrelated reason does not count as detection.
#
# Usage: bash tools/docs-check.negative-test.sh
# Exit:  0 = every breakage was detected, 1 = at least one went unnoticed.

set -u

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

detected=0
missed=0

stage() {
  rm -rf "$TMP/w"
  cp -r "$SRC" "$TMP/w"
  rm -rf "$TMP/w/.git" "$TMP/w/node_modules"
}

fingerprint() {
  ( cd "$TMP/w" && find docs README.md -type f -exec cat {} + | cksum )
}

echo "Negative tests for tools/docs-check.mjs"
echo "────────────────────────────────────────────────────────────"

# Guard 1: the baseline must pass, or nothing below means anything.
stage
if ! ( cd "$TMP/w" && node tools/docs-check.mjs ) >/dev/null 2>&1; then
  echo "  ABORT  the unmodified tree already fails the documentation check."
  echo "         Every case below would 'detect' that pre-existing failure and"
  echo "         prove nothing. Fix the real inconsistencies first:"
  ( cd "$TMP/w" && node tools/docs-check.mjs 2>&1 ) | grep -E '^\s+✗' | head -10 | sed 's/^/         /'
  exit 1
fi
echo "  baseline is clean"
echo

run_case() {
  local name="$1" expected="$2"; shift 2

  stage
  local before after
  before="$(fingerprint)"
  ( cd "$TMP/w" && "$@" ) >/dev/null 2>&1
  after="$(fingerprint)"

  # Guard 2: the mutation must have changed something.
  if [ "$before" = "$after" ]; then
    echo "  INVALID  $name -> mutation changed nothing; test case is broken"
    missed=$((missed + 1))
    return
  fi

  local out code
  out="$(cd "$TMP/w" && node tools/docs-check.mjs 2>&1)"
  code=$?

  if [ $code -eq 0 ]; then
    echo "  MISSED    $name -> checker returned 0 despite real breakage"
    missed=$((missed + 1))
    return
  fi

  # Guard 3: it must have failed for the RIGHT reason.
  if ! echo "$out" | grep -qE "$expected"; then
    echo "  WRONG     $name -> failed, but not with the expected message"
    echo "              expected to match: $expected"
    echo "$out" | grep -E '^\s+✗' | head -3 | sed 's/^/              /'
    missed=$((missed + 1))
    return
  fi

  echo "  detected  $name"
  echo "$out" | grep -E '^\s+✗' | grep -E "$expected" | head -1 | sed 's/^/              /'
  detected=$((detected + 1))
}

run_case "enum drift: NodeType loses a value in SPEC-03" \
  'enum "NodeType" differs' \
  sed -i '0,/^DEPLOYMENT$/{/^DEPLOYMENT$/d}' docs/architecture/03-GRAPH-ARCHITECTURE.md

run_case "enum drift: Authority loses a value in SPEC-02" \
  'enum "Authority" differs' \
  sed -i '0,/^UNGROUNDED$/{/^UNGROUNDED$/d}' docs/architecture/02-MEMORY-ARCHITECTURE.md

run_case "broken internal link" \
  'broken link' \
  sed -i 's|(06-SECURITY-ARCHITECTURE\.md)|(06-NOPE.md)|' docs/architecture/01-COGNITIVE-ARCHITECTURE.md

run_case "broken heading anchor" \
  'is not a heading in' \
  sed -i 's|#8-phasing|#99-nonexistent|' README.md

run_case "missing required document" \
  'missing required document' \
  rm docs/architecture/06-SECURITY-ARCHITECTURE.md

run_case "missing required section" \
  'no heading containing' \
  sed -i 's|^## 4\. Authority hierarchy$|## 4. Something else|' docs/architecture/02-MEMORY-ARCHITECTURE.md

run_case "ADR present but absent from the index" \
  'does not link' \
  cp docs/adr/0001-monorepo-layout.md docs/adr/0099-unindexed.md

run_case "honesty statement removed" \
  'required honesty statement missing' \
  sed -i 's|Generation is not verification|Generation is fine actually|g' docs/architecture/05-VERIFICATION-ARCHITECTURE.md

echo "────────────────────────────────────────────────────────────"
echo "detected: $detected   missed/invalid: $missed"

if [ $missed -ne 0 ]; then
  echo "FAIL — docs-check.mjs did not catch every deliberate breakage."
  exit 1
fi
echo "PASS — every deliberate breakage was detected, for the right reason."
