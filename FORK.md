# CodeDen Fork

This is **CodeDen Fork**, a personal fork of CodeDen (upstream: `leonvanzyl/codeden`, fork:
`jonathansaurens/codeden`). It is upstream CodeDen plus the fork's own work: teams and roles, SSH
machines, connected computers, personal orchestrators and where they run (see
[docs/machines-teams-and-agents.md](docs/machines-teams-and-agents.md)), plus the fixes from its
open pull requests upstream. Its versions read `x.y.z-fork.n`.

Agents: read this file before working here. `AGENTS.md` (upstream's guide) still applies to all
code. This file adds how the fork is put together and the rules for work that goes upstream.

## Where a change goes

| Change | Where |
|---|---|
| A fix or small improvement anyone using CodeDen would want | Its own `fix/<slug>` branch from `upstream/main`, then one upstream pull request. Add it to `scripts/fork/branches.txt` to use it before it's merged. |
| A large feature (like `feat/all`) | Ask upstream in an issue first. Until upstream takes it, it lives only in the fork, as a branch in `branches.txt`. |
| Only the fork needs it: the app name, release links, update settings, these scripts, this file | A commit on `fork-patches`. Never in a pull request. |

## How the fork is built

Never commit to `fork` by hand. `scripts/fork/sync.sh` builds it from three parts:

```
fork-base    = upstream/main + each branch in scripts/fork/branches.txt, merged in order
fork-patches = the fork-only commits, replayed on fork-base
fork         = fork-patches + one commit setting the version (<upstream version>-fork.<n>)
```

To change something fork-only, commit it on `fork-patches` and push it (`git switch fork-patches`
in this worktree, or `git worktree add` one). Then run `sync.sh`.

```sh
scripts/fork/sync.sh             # rebuild and run typecheck, lint, test; changes no remote
scripts/fork/sync.sh --push      # also push fork-base, fork-patches and fork
scripts/fork/sync.sh --release   # push and publish the release
```

Run it when upstream releases or merges one of the fork's pull requests, when a branch in
`branches.txt` gets new commits, or about once a week. It skips branches upstream has merged and
says which lines to delete from `branches.txt`. It never rebases or force-pushes a pull request's
branch. When one stops merging, it stops and tells you which one: rebase that branch onto
`upstream/main` yourself, but ask the owner first, because that force-pushes an open pull request.

## Rules for work that goes upstream

- **Nothing fork-only reaches upstream.** That covers this file, `scripts/fork/`, the fork's
  lines in `AGENTS.md`, its app name, GitHub owner, app id and `-fork.n` versions. Branches for
  upstream start from `upstream/main`, so they don't contain any of it. `sync.sh` installs
  `scripts/fork/pre-push` as the shared git pre-push hook, which refuses such a push. Check a
  commit by hand with `scripts/fork/pre-push --check <commit>`.
- Read upstream's `CONTRIBUTING.md` before opening a pull request or issue, and follow it.
- Run the full `pnpm typecheck && pnpm lint && pnpm test`, then local CI:
  `scripts/fork/ci/local-ci.sh <PR>`. It runs upstream's CI steps in Docker on the PR merged into
  `main`. Its report goes in the pull request as the proof of testing, and it marks the failures
  that `main` alone also has (`scripts/fork/ci/local-ci.sh main` adds a baseline run). Runs are
  kept outside the repository, in `~/code/codeden-ci/` (`CODEDEN_CI_OUT`).
- The owner approves every pull request, issue and comment text before anything is posted
  upstream.
- No personal details (email, names of their machines or networks) in code, docs, commits or
  pull requests. Never name other tools or products as inspiration (see `AGENTS.md`).

## Safety

- Never point tests or a dev server at the real `~/.codeden`. Use `--home <scratch dir>`.
- CodeDen Fork and the official CodeDen app share `~/.codeden`. Don't run both at once. The
  fork's database has tables CodeDen doesn't know, so back up `~/.codeden` before moving an install
  to the fork, and ask the owner first.
- Never copy an agent's login (such as Claude's credentials) from one computer to another. That
  signs the original computer out.
- The test lab (`~/code/codeden-lab`: a team server and two Docker "VPS" machines) uses made-up
  accounts. Say so whenever they come up.

## Install or update on a Mac

```sh
curl -fsSL https://github.com/jonathansaurens/codeden/releases/latest/download/install-macos.sh | bash
```

It downloads the latest release for your Mac (Apple silicon or Intel), puts **CodeDen Fork** in
`/Applications` and opens it. Run the same command to update. The app isn't signed with an Apple
Developer ID, so it doesn't update itself. Downloading with `curl` keeps macOS from blocking it.

A fork version isn't on npm, so machines and connected computers install the same build from the
fork's release (`npx -y https://github.com/jonathansaurens/codeden/releases/download/v<version>/codeden-<version>.tgz`).
`CODEDEN_MACHINE_COMMAND` still overrides it.

## Using one Mac's CodeDen from another

`scripts/fork/codeden-remote` opens the CodeDen running on another Mac in this Mac's browser,
through an SSH tunnel over a private network. [scripts/fork/remote-access.md](scripts/fork/remote-access.md)
is the full setup, step by step, for both Macs, written so an agent can follow it. Once set up:

```sh
codeden-remote          # tunnel to mbp and open CodeDen
codeden-remote stop     # close the tunnel
```

## Releasing

`scripts/fork/sync.sh --release` does all of it: it rebuilds, checks, picks the next
`-fork.n` version and pushes, then runs `scripts/fork/release.sh`. That builds the macOS DMGs
(arm64, x64) and the npm package, and publishes them with the installer as a GitHub release on
the fork.
