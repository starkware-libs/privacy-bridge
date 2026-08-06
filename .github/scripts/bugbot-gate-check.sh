#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 StarkWare Industries Ltd.

# Shared Bugbot-gate thread check, invoked from bugbot-gate.yml for both the
# pull_request path and each PR derived from a merge_group's head_ref.
#
# Reads a PR's review threads via the GitHub GraphQL API and FAILS (exit 1) if
# any thread authored by cursor[bot] is:
# - not resolved,
# - not outdated (GitHub marks a thread outdated once the lines it anchored to
#   have changed — this tells a stale carried-forward finding apart from a fresh
#   one), and
# - MEDIUM severity or higher (parsed from the "**<Severity> Severity**" marker
#   Bugbot puts in every finding body).
#
# Requires env: GH_TOKEN, OWNER, REPO, PR_NUMBER.
set -euo pipefail

: "${OWNER:?OWNER is required}"
: "${REPO:?REPO is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"

query='
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first: 1) {
            nodes { author { login } body url }
          }
        }
      }
    }
  }
}'

threads='[]'
after='null'
while :; do
  page=$(gh api graphql -f query="$query" -F owner="$OWNER" -F repo="$REPO" -F number="$PR_NUMBER" -F after="$after")
  # Fail closed with a clear message if the PR can't be read (bad PR number,
  # auth error, or a partial-error payload) — a null response must NOT be
  # silently treated as "no findings".
  if [ "$(echo "$page" | jq -r '.data.repository.pullRequest // "null"')" = "null" ]; then
    echo "::error::Bugbot Gate could not read review threads for PR #$PR_NUMBER (null GraphQL response)."
    echo "$page" | jq -r '.errors[]?.message | "  graphql error: " + .' >&2 || true
    exit 1
  fi
  # `// []` guards against a null nodes array so the jq concat can't abort mid-page.
  threads=$(jq -n --argjson a "$threads" --argjson b "$(echo "$page" | jq '.data.repository.pullRequest.reviewThreads.nodes // []')" '$a + $b')
  hasNext=$(echo "$page" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
  after=$(echo "$page" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
  [ "$hasNext" = "true" ] || break
done

blocking=$(echo "$threads" | jq '
  [ .[]
    | select(.isResolved == false and .isOutdated == false)
    | select(.comments.nodes[0].author.login | test("cursor"; "i"))
    | select(.comments.nodes[0].body | test("\\*\\*(Critical|High|Medium) Severity\\*\\*"))
  ]')

count=$(echo "$blocking" | jq 'length')
if [ "$count" -gt 0 ]; then
  echo "::error::$count unresolved MEDIUM+ Cursor Bugbot finding(s) on PR #$PR_NUMBER."
  echo "PR #$PR_NUMBER: $count unresolved MEDIUM+ Cursor Bugbot finding(s):" >> "$GITHUB_STEP_SUMMARY"
  echo "$blocking" | jq -r '.[] | "- " + ((.comments.nodes[0].body | try capture("### (?<title>.*)").title catch "finding") // "finding") + " — " + .comments.nodes[0].url' >> "$GITHUB_STEP_SUMMARY"
  echo "Resolve each finding (fix + resolve the thread, or reply with a NOT-A-BUG rationale and resolve) before this PR can merge." >> "$GITHUB_STEP_SUMMARY"
  exit 1
fi

echo "No unresolved MEDIUM+ Cursor Bugbot findings on PR #$PR_NUMBER." >> "$GITHUB_STEP_SUMMARY"
