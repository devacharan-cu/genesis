#!/usr/bin/env bash
#
# Every check that exists today. Nothing is committed unless this is green.
#
# The two negative tests are not ceremony: a checker that cannot fail reports
# success forever and everyone believes it. Both of this repo's checkers have
# already been caught passing vacuously — once from a pattern that matched
# nothing, once from a baseline that was already failing — so each now proves it
# can fail before its result is trusted.
#
# As phases land, new checks are appended here. This stays the single answer to
# "is the repository in a state worth committing?".

set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
PNPM="corepack pnpm"

status=0
step=0
TOTAL=9

run() {
  step=$((step + 1))
  echo "=== ${step}/${TOTAL}  $1 ==="
  shift
  if "$@"; then
    echo
  else
    echo ">>> FAILED"
    echo
    status=1
  fi
}

run "documentation consistency" \
  node tools/docs-check.mjs

run "negative test: can the docs checker fail?" \
  bash tools/docs-check.negative-test.sh
# run "negative test: can the docs checker fail?" \
#   bash tools/docs-check.negative-test.sh

run "package boundaries (ADR-0001)" \
  node tools/check-boundaries.mjs

run "negative test: can the boundary checker fail?" \
  bash tools/check-boundaries.negative-test.sh

run "typecheck (strict, ADR-0002)" \
  $PNPM exec tsc -p tsconfig.json --noEmit

# The apps sit outside the root project's include, so each gets its own pass.
# An app that is not typechecked is where strictness quietly stops.
run "typecheck: console API" \
  $PNPM exec tsc -p apps/api/tsconfig.json --noEmit

run "typecheck and build: console web app" \
  bash tools/check-web.sh

run "lint" \
  $PNPM exec eslint .

run "tests and coverage policy (SPEC-00 section 8.1)" \
  $PNPM exec vitest run --coverage

echo "────────────────────────────────────────────────────────────"
if [ $status -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "CHECKS FAILED — do not commit"
fi
exit $status
