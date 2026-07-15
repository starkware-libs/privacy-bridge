#!/usr/bin/env bash
# Fail if any tracked file contains an unresolved Git merge-conflict marker.
# Minimal guard wired into `pnpm lint` (and thus CI). Scans tracked files only,
# so build output / node_modules are never matched.
set -euo pipefail

# Anchored to line start so legitimate content (e.g. "=======" rules in docs,
# Markdown headings) doesn't trip it. Conflict markers always begin a line.
pattern='^(<{7}|={7}|>{7})( |$)'

# git grep over the working tree's tracked files; -I skips binaries.
if git grep -nIE "$pattern" -- ':(exclude)scripts/check-conflict-markers.sh'; then
  echo "error: unresolved conflict marker(s) found in tracked files" >&2
  exit 1
fi

echo "no conflict markers found"
