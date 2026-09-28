#!/bin/sh
# One command, one report:
#   ./run-verification.sh https://your-entry.example
#   ./run-verification.sh ./dist/index.html     (a local build, served on 127.0.0.1)
# Everything after the target is passed through: --out, --browser, --no-contract, --json.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "run-verification: Node.js 22 or newer is required (https://nodejs.org)" >&2
  exit 3
fi
exec node "$here/verify.mjs" "$@"
