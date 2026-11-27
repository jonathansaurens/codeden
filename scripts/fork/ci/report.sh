#!/usr/bin/env bash
# Writes report.md for a finished run dir. A failed test is marked as upstream's when it also
# failed in the baseline runs of main (baseline/main-*.log), with how often.
set -uo pipefail
RUN=$1; OUT=${CODEDEN_CI_OUT:-$HOME/code/codeden-ci}
clean() { sed 's/\x1b\[[0-9;]*m//g' "$1"; }
. "$RUN/meta.env"
TESTS=$(clean "$RUN/test.log" | grep -E "^ +Tests " | sed 's/^ *Tests *//')
FAILS=$(clean "$RUN/test.log" | grep -E "^ FAIL " | sed 's/^ FAIL  *//; s/  */ /g' | sort -u)
BASES=("$OUT"/baseline/main-*.log); NB=${#BASES[@]}
NEW=""; KNOWN=""
while IFS= read -r f; do [ -z "$f" ] && continue
  n=0; for b in "${BASES[@]}"; do clean "$b" | sed 's/  */ /g' | grep -qF "$f" && n=$((n+1)); done
  if [ $n -gt 0 ]; then KNOWN+="$f (failed in $n of $NB runs of \`main\` alone)"$'\n'; else NEW+="$f"$'\n'; fi
done <<< "$FAILS"
OTHER=$(awk -F'\t' '$1!="pnpm test" && $2!="pass"' "$RUN/steps.tsv")
if [ -n "$OTHER" ] || [ -n "$NEW" ]; then ALL="FAILED"; elif [ -n "$KNOWN" ]; then ALL="PASSED, apart from a test that is flaky on \`main\` too"; else ALL="PASSED"; fi
{
  echo "**Local CI: $ALL**"
  echo
  echo "The steps of \`ci.yml\`'s \"Build, test and install\" job, run locally on the commit CI would check, while the workflow waits for approval."
  echo
  echo "| Step | Result | Time |"; echo "|---|---|---|"
  awk -F'\t' '{printf "| `%s` | %s | %ss |\n",$1,($2=="pass"?"✅ pass":"❌ fail"),$3}' "$RUN/steps.tsv"
  echo
  echo "- Tests: $TESTS"
  [ -n "$NEW" ] && { echo "- **Failed:**"; printf '%s' "$NEW" | sed 's/^/  - /'; }
  [ -n "$KNOWN" ] && { echo "- Failed, and flaky on \`main\` at \`${BASE_SHA:0:8}\` too (same setup, without this PR):"; printf '%s' "$KNOWN" | sed 's/^/  - /'; }
  echo "- Code: $CODE"
  echo "- Environment: $ENVLINE"
  echo "- Full log sha256: \`$(shasum -a 256 "$RUN/ci.log" | cut -c1-16)\`, available on request"
} > "$RUN/report.md"
cat "$RUN/report.md"
