#!/usr/bin/env bash
#
# Runs every check that exists today. Nothing is pushed unless this is green.
# As phases land, new checks are appended here — this stays the single entry
# point for "is the repository in a state worth committing?".

set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

status=0

echo "=== 1/2  documentation consistency ==="
node tools/docs-check.mjs || status=1
echo

echo "=== 2/2  negative test: can the checker fail? ==="
bash tools/docs-check.negative-test.sh || status=1
echo

if [ $status -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "CHECKS FAILED — do not commit"
fi
exit $status
