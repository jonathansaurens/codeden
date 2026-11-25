# Machines

CodeDen can run agent sessions on other computers you can reach over SSH: a VPS, a spare
laptop, a desktop under the stairs, several of them. Your main CodeDen keeps the UI, the
orchestrator and the PMs. Each machine runs a CodeDen runner of its own, which serves every
session placed on it, and its agents use that machine's own provider sign-ins.

The design is in [machines-teams-and-agents.md](machines-teams-and-agents.md) (Part A).

## What a machine needs

- **SSH access without a prompt.** CodeDen runs your own `ssh` with `BatchMode=yes`, so whatever
  works in your terminal without typing a password works here: keys, your SSH agent, `Host`
  aliases, jump hosts and `ProxyCommand` from `~/.ssh/config`. CodeDen stores no SSH keys or
  passwords.
- **Node.js 24 or newer**, on the `PATH` of non-interactive shells. Check it from your main
  computer with `ssh <machine> node --version`. If that finds no `node` although it works when
  you log in, your version manager is only set up for interactive shells: install Node.js
  system-wide, or put the `PATH` line before the "if not interactive, stop here" guard in the
  machine's `~/.bashrc`.
- **git**, and access to npm (CodeDen is fetched with `npx`).
- **The agent CLIs you want to use there, signed in on the machine**: `claude`, `codex`,
  `opencode` and so on. A session goes to a machine only if its provider is installed and signed
  in there. No credentials leave your main computer.
- **A GitHub project.** Machines clone the repository from GitHub with a credential CodeDen
  hands to each git operation, never stored there. Local-only projects run on Home.
- Linux or macOS on the machine.

### SSH keys

If `ssh <machine>` still asks for a password, add a key:

```sh
ssh-keygen -t ed25519          # once, if you have no key yet
ssh-copy-id user@my-vps        # copies it to the machine
ssh user@my-vps node --version # must print v24 or newer, with no prompt
```

The first connection to a new host asks you to accept its host key. Do that once in a terminal;
CodeDen can't answer the question for you.

### Tip: Tailscale

[Tailscale](https://tailscale.com) gives every one of your computers a stable name on a private
network, with no ports opened to the internet. Install it on both computers, then add the
machine by its Tailscale name (`codeden machines add me@my-vps`), or turn on Tailscale SSH and
skip key management altogether.

## Adding a machine

Settings › Machines › **Add machine**, or from a terminal while CodeDen runs:

```sh
codeden machines add user@my-vps --name vps-1
codeden machines list
```

The destination is anything `ssh` accepts: `user@host`, a `Host` alias from `~/.ssh/config`, a
Tailscale name. Before saving, CodeDen checks the machine:

1. `ssh <machine> node --version`: SSH signs in without a prompt, and Node.js is 24 or newer.
2. `ssh <machine> npx -y codeden@<this version> --version`: the same CodeDen version runs there.
   The first time this downloads CodeDen on the machine.
3. It starts the machine's runner and connects to it.

Each failure says what to fix, for example "Node.js 24 or newer is needed on vps-1; found 20.11".

### What runs on the machine

- Every command runs as `npx -y codeden@<exact server version> …`, so upgrading CodeDen upgrades
  its machines on their next connection. A runner of another version finishes or stops its
  turns, exits, and the current one starts.
- The runner lives in `~/.codeden-runner` on the machine (its journal, lock file and clones),
  separate from any CodeDen you also run there. It starts detached
  (`codeden runner --home ~/.codeden-runner --detach`) and keeps running when the connection
  drops or your main CodeDen stops, so agents keep working.
- CodeDen talks to it over `ssh <machine> … codeden runner-link`: a plain SSH session carrying
  the runner protocol. Nothing listens on a port on either computer. A dropped connection is
  reopened with backoff, and nothing that happened meanwhile is lost.

## Choosing where sessions run

- **Per project:** Project page › Settings › Where sessions run: **This machine** (Home, the
  default) or **A machine**, by name.
- **Per session:** the New session form's **Runs on** picker overrides the project's setting.
- **The PM** can name a machine in `start_session` (`machine: "vps-1"` or `"home"`).

The orchestrator and PMs always stay on Home. A fork stays on its source session's machine.

Sessions on a machine work in a clone of the repository there. Files, diffs, checkpoints,
terminals and the browser screencast work as on Home; the desktop app's native browser view is
Home only.

## Removing a machine

Settings › Machines › Remove, or `codeden machines remove vps-1`. CodeDen refuses while sessions
not archived are placed on the machine, and while a clone there holds work that exists nowhere
else (uncommitted changes, unpushed commits, stashes). `--force` removes it anyway. The runner
on the machine is stopped; its files in `~/.codeden-runner` stay until you delete them.

## Running a development build

By default machines run the published `npx -y codeden@<server version>`. A build from a branch
isn't on npm, so for development you can replace that command with your own, for the machine's
shell to run:

```sh
pnpm build
cd apps/cli && npm pack                   # codeden-<version>.tgz
scp codeden-*.tgz my-vps:
ssh my-vps npm i -g ./codeden-*.tgz        # now `codeden` on the machine is your build

CODEDEN_MACHINE_COMMAND=codeden codeden   # start your main CodeDen with the override
```

`CODEDEN_MACHINE_COMMAND` is read by the server when it starts, applies to every machine, and is
shown in Settings › Machines ("Machines run CodeDen with: …"). The version check still applies:
the machine's build must report the same version as the server.

## Troubleshooting

- **"couldn't sign in without a password"**: `ssh -o BatchMode=yes <machine> true` must work in
  your terminal. Load your key into the agent (`ssh-add`) or copy it over (`ssh-copy-id`).
- **"host key isn't trusted yet"**: run `ssh <machine>` once in a terminal and accept the key. If
  the machine was reinstalled, remove its old key with `ssh-keygen -R <host>` first.
- **"found no node"**: see [What a machine needs](#what-a-machine-needs) about non-interactive
  shells.
- **A provider isn't offered on the machine**: sign in to it there (`ssh -t <machine> claude`,
  then `/login`), and check Settings › Machines, which lists each provider's state.
- **The machine shows disconnected**: CodeDen retries on its own. Check that the machine is up
  and that `ssh <machine>` works; the error under the machine says what the last attempt got.
- **The runner's log** is `~/.codeden-runner/logs/runner.log` on the machine.
