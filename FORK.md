# CodeDen Fork

This branch (`fork`) is CodeDen with the fork's own work on top: teams and roles, SSH machines,
connected computers, personal orchestrators and where they run (see
[docs/machines-teams-and-agents.md](docs/machines-teams-and-agents.md)), plus the fixes from its
open pull requests upstream. Its versions read `x.y.z-fork.n`.

## Install or update on a Mac

```sh
curl -fsSL https://github.com/jonathansaurens/codeden/releases/latest/download/install-macos.sh | bash
```

It downloads the latest release for your Mac (Apple silicon or Intel), puts **CodeDen Fork** in
`/Applications` and opens it. Run the same command to update. The app isn't signed with an Apple
Developer ID, so it doesn't update itself; downloading with `curl` keeps macOS from blocking it.

CodeDen Fork keeps its data in `~/.codeden`, like CodeDen. Don't run both at once. Its database
has tables CodeDen doesn't know, so back up `~/.codeden` before moving an existing install to it.

## Machines and connected computers

A fork version isn't on npm, so machines and connected computers install the same build from the
fork's release (`npx -y https://github.com/jonathansaurens/codeden/releases/download/v<version>/codeden-<version>.tgz`).
`CODEDEN_MACHINE_COMMAND` still overrides it.

## Releasing

1. Merge `upstream/main` and any updated pull request branches into `fork`.
2. Bump the version (`apps/cli/package.json`, `apps/desktop/package.json`,
   `SOURCE_VERSION` in `packages/contracts/src/version.ts`) to the next `-fork.n`.
3. `pnpm typecheck && pnpm lint && pnpm test`, commit, then `scripts/fork/release.sh`.
