#!/usr/bin/env bash
# Builds CodeDen Fork and publishes it as a GitHub release on the fork:
# macOS DMGs (arm64, x64), the npm package machines install, and the installer script.
#   scripts/fork/release.sh            build and publish v<version from apps/cli/package.json>
#   scripts/fork/release.sh --dry-run  build only, artifacts in apps/desktop/release
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=jonathansaurens/codeden
V=$(node -p "require('./apps/cli/package.json').version"); TAG="v$V"
[[ "$V" == *-fork.* ]] || { echo "version $V isn't a fork version (x.y.z-fork.n)"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit your changes first"; exit 1; }
pnpm install --frozen-lockfile
pnpm build
(cd apps/desktop && node scripts/package.mjs --arch arm64 --arch x64 --publish never)
OUT=$(mktemp -d); (cd apps/cli && npm pack --pack-destination "$OUT" >/dev/null)
ASSETS=(apps/desktop/release/CodeDen-Fork-"$V"-arm64.dmg apps/desktop/release/CodeDen-Fork-"$V"-x64.dmg "$OUT/codeden-$V.tgz" scripts/fork/install-macos.sh)
ls -la "${ASSETS[@]}"
[ "${1:-}" = --dry-run ] && exit 0
git push origin HEAD:fork
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
API="https://api.github.com/repos/$REPO"
NOTES="CodeDen Fork $V: upstream CodeDen plus teams, machines, connected computers, personal orchestrators and the fork's open fixes. Install or update on a Mac: \`curl -fsSL https://github.com/$REPO/releases/latest/download/install-macos.sh | bash\`"
ID=$(curl -fsS -H "Authorization: Bearer $TOKEN" -d "$(node -e 'console.log(JSON.stringify({tag_name:process.argv[1],target_commitish:process.argv[2],name:"CodeDen Fork "+process.argv[1],body:process.argv[3]}))' "$TAG" "$(git rev-parse HEAD)" "$NOTES")" "$API/releases" | node -p 'JSON.parse(require("fs").readFileSync(0)).id')
for f in "${ASSETS[@]}"; do
  echo "Uploading $(basename "$f")…"
  curl -fsS -o /dev/null -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" --data-binary @"$f" \
    "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$(basename "$f" | sed 's/ /%20/g')"
done
echo "Published https://github.com/$REPO/releases/tag/$TAG"
