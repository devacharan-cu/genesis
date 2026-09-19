#!/usr/bin/env bash
#
# Negative test for tools/check-boundaries.mjs.
#
# The boundary checker is one of the three things enforcing "agents cannot write
# canonical state" (ADR-0006). A checker that cannot fail enforces nothing while
# reporting that everything is fine — the worst of both.
#
# Three guards keep this test from passing vacuously. The first version of it
# had none of them and was worthless: the baseline was already failing, so every
# case "detected" a violation that was simply the pre-existing noise.
#
#   1. The BASELINE must be clean. If the unmodified tree already fails, every
#      case would trivially fail too and prove nothing. The test aborts.
#   2. Each mutation must actually change a file. A pattern matching nothing is
#      reported INVALID rather than counted as a pass.
#   3. Each case names the message it expects. A non-zero exit for some
#      unrelated reason does not count as detection.
#
# Usage: bash tools/check-boundaries.negative-test.sh
# Exit:  0 = every violation was detected, 1 = at least one went unnoticed.

set -u

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

detected=0
missed=0

stage() {
  rm -rf "$TMP/w"
  mkdir -p "$TMP/w"
  # Only what the checker reads. node_modules is large and irrelevant to it.
  cp -r "$SRC/packages" "$TMP/w/packages"
  cp -r "$SRC/tools" "$TMP/w/tools"
}

fingerprint() {
  ( cd "$TMP/w" && find packages -type f \( -name '*.ts' -o -name 'package.json' \) -exec cat {} + | cksum )
}

echo "Negative tests for tools/check-boundaries.mjs"
echo "────────────────────────────────────────────────────────────"

# Guard 1: the baseline must pass, or nothing below means anything.
stage
if ! ( cd "$TMP/w" && node tools/check-boundaries.mjs ) >/dev/null 2>&1; then
  echo "  ABORT  the unmodified tree already fails the boundary check."
  echo "         Every case below would 'detect' that pre-existing failure and"
  echo "         prove nothing. Fix the real violations first:"
  ( cd "$TMP/w" && node tools/check-boundaries.mjs 2>&1 ) | grep -E '^\s+✗' | head -10 | sed 's/^/         /'
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
  out="$(cd "$TMP/w" && node tools/check-boundaries.mjs 2>&1)"
  code=$?

  if [ $code -eq 0 ]; then
    echo "  MISSED    $name -> checker returned 0 despite a real violation"
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

# Appends an import, simulating someone reaching across a boundary.
add_import() {
  printf "\nimport '%s';\n" "$2" >> "$1"
}

run_case "core-types imports a package it must not depend on" \
  'core-types.*imports @genesis/ledger, which ADR-0001 does not permit' \
  add_import packages/core-types/src/index.ts '@genesis/ledger'

run_case "ledger imports an adapter, inverting the dependency direction" \
  'ledger.*imports @genesis/adapters-sqlite, which ADR-0001 does not permit' \
  add_import packages/ledger/src/index.ts '@genesis/adapters-sqlite'

run_case "node:sqlite imported outside adapters-sqlite (ADR-0010)" \
  'node:sqlite.*restricted to' \
  add_import packages/ledger/src/index.ts 'node:sqlite'

run_case "production file imports its own package by name" \
  'imports its own package by name' \
  add_import packages/ledger/src/hash.ts '@genesis/ledger'

run_case "workspace import not declared in package.json" \
  'does not declare it' \
  bash -c "sed -i 's|\"@genesis/core-types\": \"workspace:\\*\",||' packages/adapters-sqlite/package.json"

run_case "package declares a dependency ADR-0001 forbids" \
  'declares a dependency on @genesis/adapters-sqlite' \
  bash -c "sed -i 's|\"dependencies\": {|\"dependencies\": { \"@genesis/adapters-sqlite\": \"workspace:*\",|' packages/core-types/package.json"

run_case "import of a workspace package that does not exist" \
  'unknown workspace package' \
  add_import packages/ledger/src/index.ts '@genesis/does-not-exist'

run_case "a new package with no declared boundary rule" \
  'not listed in ALLOWED_WORKSPACE_DEPS' \
  bash -c "mkdir -p packages/rogue/src && printf '{\"name\":\"@genesis/rogue\",\"private\":true}' > packages/rogue/package.json && printf 'export const x = 1;\n' > packages/rogue/src/index.ts"

# The three below are ADR-0006's central claim, checked directly rather than
# inferred from the generic cases: an agent that can reach a store, the ledger,
# or the core is an agent that can write canonical truth. SPEC-04 §3.3 says this
# boundary is enforced by the build, so the build must be able to fail on it.
run_case "an agent reaches the ledger" \
  'agents.*imports @genesis/ledger, which ADR-0001 does not permit' \
  add_import packages/agents/src/contract.ts '@genesis/ledger'

run_case "an agent reaches a store" \
  'agents.*imports @genesis/memory, which ADR-0001 does not permit' \
  add_import packages/agents/src/roles.ts '@genesis/memory'

run_case "an agent reaches the core, inverting the dependency direction" \
  'agents.*imports @genesis/core, which ADR-0001 does not permit' \
  add_import packages/agents/src/registry.ts '@genesis/core'

echo "────────────────────────────────────────────────────────────"
echo "detected: $detected   missed/invalid: $missed"

if [ $missed -ne 0 ]; then
  echo "FAIL — check-boundaries.mjs did not catch every deliberate violation."
  exit 1
fi
echo "PASS — every deliberate violation was detected, for the right reason."
