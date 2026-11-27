#!/usr/bin/env bash
# Runs inside the container, in /src: the steps of upstream's .github/workflows/ci.yml "check" job.
# Each step's result goes to /out/steps.tsv (name, status, seconds); its output to /out/ci.log.
set -uo pipefail
cd /src
OUT=/out; : > $OUT/steps.tsv
step() { local name=$1; shift; local t0=$SECONDS; echo "::group::$name" >>$OUT/ci.log
  if "$@" >>$OUT/ci.log 2>&1; then s=pass; else s=FAIL; fi
  echo -e "$name\t$s\t$((SECONDS-t0))" >>$OUT/steps.tsv; echo "::endgroup:: $name $s" >>$OUT/ci.log
  [ $s = pass ]; }
corepack enable >/dev/null 2>&1
export npm_config_store_dir=/pnpm-store
step "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile || exit 1
step "pnpm typecheck" pnpm typecheck
step "pnpm lint" pnpm lint
step "pnpm test" bash -o pipefail -c 'pnpm test 2>&1 | tee /out/test.log'
step "pnpm build" pnpm build || exit 1
step "self-update integration" env CODEDEN_REQUIRE_CLI_DIST=1 pnpm exec vitest run apps/cli/test/self-update.integration.test.ts
install_check() {
  set -e; T=$(mktemp -d)
  (cd apps/cli && npm pack --pack-destination "$T" >/dev/null)
  mkdir "$T/tarball" && (cd "$T/tarball" && tar xzf ../codeden-*.tgz)
  ! grep -rlE "Anthropic PBC|Native CLI binary for" "$T/tarball"
  ! grep -q "claude-agent-sdk@" "$T/tarball/package/dist/THIRD-PARTY-NOTICES.txt"
  mkdir "$T/install-check" && cd "$T/install-check"; npm init -y >/dev/null
  npm install "$T"/codeden-*.tgz >/dev/null; [ ! -e node_modules/@anthropic-ai ]
  npx codeden --version
  export CODEDEN_HOME="$T/codeden-home"
  npx codeden doctor --home "$CODEDEN_HOME" | tee doctor.txt || true
  grep -q "ok  Terminals" doctor.txt; grep -q -- "--  Claude Code support" doctor.txt
  npx codeden doctor --install --home "$CODEDEN_HOME" | tee doctor-install.txt || true
  grep -q "ok  Claude Code support  SDK " doctor-install.txt
  [ "$(ls "$CODEDEN_HOME/deps/node_modules/@anthropic-ai")" = "claude-agent-sdk" ]
  CODEDEN_UPDATE_CHECK=0 npx codeden --home "$CODEDEN_HOME" --port 4791 --no-open > server.log 2>&1 &
  for i in $(seq 1 60); do curl -sf http://127.0.0.1:4791/api/health > health.json && break; sleep 1; done
  grep -q '"ok":true' health.json
  TOKEN=$(tr -d '\r\n' < "$CODEDEN_HOME/install-token")
  curl -sf -H "cookie: codeden_token_4791=$TOKEN" http://127.0.0.1:4791/ > index.html; grep -q "<title>CodeDen" index.html
  curl -sf -H "authorization: Bearer $TOKEN" http://127.0.0.1:4791/api/automations/templates > templates.json; grep -q security-audit templates.json
  npx codeden stop --home "$CODEDEN_HOME" || true
}
step "install the packed tarball and run it" install_check
