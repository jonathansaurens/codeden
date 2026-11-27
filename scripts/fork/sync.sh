#!/usr/bin/env bash
# Rebuilds the fork from its parts and, when asked, publishes it:
#   fork-base    = upstream/main + each branch in scripts/fork/branches.txt, merged in order
#   fork-patches = the fork-only commits (name, release links, these scripts), replayed on fork-base
#   fork         = fork-patches + one commit setting the version, <upstream version>-fork.<n>
#
#   scripts/fork/sync.sh             rebuild and check (typecheck, lint, test); changes no remote
#   scripts/fork/sync.sh --push      also push fork-base, fork-patches and fork to origin
#   scripts/fork/sync.sh --release   push, then publish the release (scripts/fork/release.sh)
#   scripts/fork/sync.sh --no-test   skip the checks (to see quickly whether everything merges)
#
# Run it in the fork's worktree with nothing uncommitted. It never rebases or pushes a pull
# request's branch: when one no longer merges, it stops and says so.
set -euo pipefail
cd "$(dirname "$0")/../.."
PUSH=0; RELEASE=0; TEST=1
for a in "$@"; do case $a in
  --push) PUSH=1 ;; --release) PUSH=1; RELEASE=1 ;; --no-test) TEST=0 ;;
  *) echo "unknown option $a"; exit 2 ;; esac; done
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first."; exit 1; }

# The leak guard, in the hooks every worktree of this repository shares.
HOOKS=$(git rev-parse --path-format=absolute --git-common-dir)/hooks
cp scripts/fork/pre-push "$HOOKS/pre-push"; chmod +x "$HOOKS/pre-push"

git fetch -q upstream; git fetch -q origin
PATCHES=$(git rev-parse origin/fork-patches); OLD_BASE=$(git rev-parse origin/fork-base)
step() { printf '\n== %s\n' "$*"; }

step "Merging into upstream/main ($(git rev-parse --short upstream/main))"
git switch -q --detach upstream/main
MERGED_UPSTREAM=()
while read -r branch note; do
  if git merge-base --is-ancestor "origin/$branch" upstream/main 2>/dev/null ||
     [ "$(gh pr list -R leonvanzyl/codeden --head "$branch" --state merged --json number -q length 2>/dev/null </dev/null || echo 0)" != 0 ]; then
    echo "  $branch: merged upstream, skipped. Delete its line from scripts/fork/branches.txt."
    MERGED_UPSTREAM+=("$branch"); continue
  fi
  if ! git merge -q --no-ff --no-edit -m "Merge $branch into the fork" "origin/$branch" >/dev/null </dev/null; then
    git merge --abort
    echo "  $branch no longer merges with the branches before it. Rebase it onto upstream/main"
    echo "  (for a pull request that force-pushes it, so ask first), then run this again."
    exit 1
  fi
  echo "  $branch ($note)"
done < <(git show "$PATCHES:scripts/fork/branches.txt" | grep -vE '^[[:space:]]*(#|$)')
BASE=$(git rev-parse HEAD)
# Same result as last time: keep the existing commits, so nothing is rewritten for no reason.
if [ "$(git rev-parse "$BASE^{tree}")" = "$(git rev-parse "$OLD_BASE^{tree}")" ]; then
  BASE=$OLD_BASE; git switch -q --detach "$PATCHES"
else
  step "Replaying the fork-only commits"
  git rebase -q --onto "$BASE" "$OLD_BASE" "$PATCHES" ||
    { echo "  A fork-only commit no longer applies: fix it, git rebase --continue, then run this again."; exit 1; }
fi
NEW_PATCHES=$(git rev-parse HEAD)
git log --oneline "$BASE..HEAD" | sed 's/^/  /'

UPSTREAM_V=$(git show upstream/main:apps/cli/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).version')
CURRENT=$(git show origin/fork:apps/cli/package.json | node -p 'JSON.parse(require("fs").readFileSync(0)).version')
if [ "$(git diff --name-only origin/fork HEAD | grep -cvE '^(apps/cli/package.json|apps/desktop/package.json|packages/contracts/src/version.ts)$')" = 0 ]; then
  V=$CURRENT; NEW=0
else
  N=$(git ls-remote --tags origin "refs/tags/v$UPSTREAM_V-fork.*" | sed 's/.*-fork\.//' | sort -n | tail -1)
  V="$UPSTREAM_V-fork.$(( ${N:-0} + 1 ))"; NEW=1
fi
step "Version $V$([ $NEW = 0 ] && echo ' (nothing changed since the last release)')"
node -e '
  const fs = require("fs"), v = process.argv[1];
  for (const f of ["apps/cli/package.json", "apps/desktop/package.json"])
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/"version": "[^"]+"/, `"version": "${v}"`));
  const c = "packages/contracts/src/version.ts";
  fs.writeFileSync(c, fs.readFileSync(c, "utf8").replace(/SOURCE_VERSION = "[^"]+"/, `SOURCE_VERSION = "${v}"`));
' "$V"
git commit -q -am "chore(fork): CodeDen Fork $V" -m "Upstream $UPSTREAM_V with the branches in scripts/fork/branches.txt and the fork-only commits."
if [ "$(git rev-parse HEAD^{tree})" = "$(git rev-parse origin/fork^{tree})" ] &&
   [ "$(git rev-parse HEAD~1)" = "$(git rev-parse origin/fork~1)" ]; then git reset -q --hard origin/fork; fi

if [ $TEST = 1 ]; then
  step "Checking: typecheck, lint, test"
  pnpm install --frozen-lockfile >/dev/null
  # One per line: under set -e, a failure inside an && chain doesn't stop the script.
  pnpm typecheck
  pnpm lint
  pnpm test
fi

git branch -f fork-base "$BASE"; git branch -f fork-patches "$NEW_PATCHES"; git branch -f fork HEAD
git switch -q fork
step "Done: fork is $(git rev-parse --short fork), version $V"
[ ${#MERGED_UPSTREAM[@]} = 0 ] || echo "  Merged upstream since last time: ${MERGED_UPSTREAM[*]}"
if [ $PUSH = 1 ]; then
  git push -q --force-with-lease origin fork-base fork-patches fork
  echo "  Pushed fork-base, fork-patches and fork to origin."
fi
if [ $RELEASE = 1 ]; then
  [ $NEW = 1 ] || { echo "  Nothing new to release."; exit 0; }
  scripts/fork/release.sh
fi
