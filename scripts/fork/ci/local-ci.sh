#!/usr/bin/env bash
# Local CI with proof for a CodeDen pull request: the steps of upstream's CI "check" job, run on
# the PR's merge with upstream/main, in a clean Linux container with Node 24 (as CI does).
# Runs and baselines are kept outside the repository, in $CODEDEN_CI_OUT (default ~/code/codeden-ci).
#   ./local-ci.sh <PR number>      writes runs/<PR>-<sha>/{report.md,ci.log,test.log}
#   ./local-ci.sh <PR> <commit>    checks a local, unpushed commit as that PR
#   ./local-ci.sh main             the baseline: main alone; a PR's failures also seen there are marked
set -uo pipefail
PR=$1; HERE=$(cd "$(dirname "$0")" && pwd); OUT=${CODEDEN_CI_OUT:-$HOME/code/codeden-ci}
REPO=$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)/..
cd "$REPO" && git fetch -q upstream main || exit 1
BASE_SHA=$(git rev-parse upstream/main)
if [ "$PR" = main ]; then HEAD_SHA=$BASE_SHA; else
  git fetch -q upstream "pull/$PR/head:refs/ci/pr-$PR" --force || exit 1; HEAD_SHA=$(git rev-parse "refs/ci/pr-$PR"); fi
# Optional second argument: a local commit (not pushed yet) to check in place of the PR's head.
[ -n "${2:-}" ] && HEAD_SHA=$(git rev-parse "$2")
# A PR must not carry anything fork-only.
[ "$PR" = main ] || "$HERE/../pre-push" --check "$HEAD_SHA" || exit 1
RUN="$OUT/runs/$PR-${HEAD_SHA:0:8}"; rm -rf "$RUN"; mkdir -p "$RUN"; SRC="$RUN/src"
git worktree add -q --detach "$SRC" "$BASE_SHA"
[ "$PR" = main ] || (cd "$SRC" && git -c user.name=ci -c user.email=ci@localhost merge -q --no-edit --no-ff "$HEAD_SHA") || { echo "merge conflict with main"; exit 1; }
MERGE_SHA=$(git -C "$SRC" rev-parse HEAD)
IMAGE=node:24-bookworm
T0=$(date -u +%FT%TZ); S0=$SECONDS
docker run --rm -v "$SRC":/src -v "$RUN":/out -v "$HERE/ci-steps.sh":/ci-steps.sh:ro \
  -v codeden-ci-pnpm:/pnpm-store -e CI=true "$IMAGE" bash /ci-steps.sh
DIGEST=$(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null)
NODE=$(docker run --rm "$IMAGE" node --version)
git worktree remove --force "$SRC"
if [ "$PR" = main ]; then CODE="\`main\` at \`${BASE_SHA:0:8}\` (baseline)"; else CODE="merge of \`${HEAD_SHA:0:8}\` (this PR) into \`main\` at \`${BASE_SHA:0:8}\`, the commit CI checks out"; fi
ENVLINE="\`$IMAGE\` (${DIGEST##*@}), Node $NODE, $(docker info --format '{{.Architecture}}') Linux, started $T0, $((SECONDS-S0))s total"
printf 'BASE_SHA=%q\nCODE=%q\nENVLINE=%q\n' "$BASE_SHA" "$CODE" "$ENVLINE" > "$RUN/meta.env"
[ "$PR" = main ] && { mkdir -p "$OUT/baseline"; cp "$RUN/test.log" "$OUT/baseline/main-$(date +%s).log"; }
CODEDEN_CI_OUT=$OUT "$HERE/report.sh" "$RUN"
