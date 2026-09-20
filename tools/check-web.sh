#!/usr/bin/env bash
#
# The console web app: strict typecheck, then a real production build.
#
# The build matters as much as the typecheck. It is the only check that proves
# the browser bundle actually resolves — including the workspace packages the
# app folds the ledger with, which are TypeScript source rather than published
# artifacts, and which would otherwise only ever be exercised by a dev server.

set -eu
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm --filter web exec tsc -b --force
corepack pnpm --filter web exec vite build --logLevel warn
