# Machines

CodeDen can run agent sessions on other computers you can reach over SSH: a VPS, a spare
laptop, a desktop under the stairs, several of them. Your main CodeDen keeps the UI, the
orchestrator and the PMs. Each machine runs a CodeDen runner of its own, which serves every
session placed on it, and its agents use that machine's own provider sign-ins.

Your own laptop can be a machine too, even when nothing can reach it over SSH: it links out to
CodeDen instead ([Connecting your own computer](#connecting-your-own-computer)).

The design is in [machines-teams-and-agents.md](machines-teams-and-agents.md) (Part A, and §D.5
for your own computer).

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

Settings › Machines lists each machine with its state, CodeDen version, platform, providers
(signed in or why not), live capacity (cores, CPU busy, free memory), preference and sessions.

### What runs on the machine

- Every command runs as `npx -y codeden@<exact server version> …`, so upgrading CodeDen upgrades
  its machines on their next connection. A runner of another version finishes or stops its
  turns, exits, and the current one starts.
- The runner lives in `~/.codeden-runner` on the machine (its journal, lock file, clones and
  worktrees),
  separate from any CodeDen you also run there. It starts detached
  (`codeden runner --home ~/.codeden-runner --detach`) and keeps running when the connection
  drops or your main CodeDen stops, so agents keep working.
- CodeDen talks to it over `ssh <machine> … codeden runner-link`: a plain SSH session carrying
  the runner protocol. Nothing listens on a port on either computer. A dropped connection is
  reopened with backoff, and nothing that happened meanwhile is lost.

## Connecting your own computer

A laptop usually can't be reached over SSH: it sleeps, moves between networks and sits behind
NAT. So it links **out** to CodeDen instead, and runs agent sessions with its own provider
sign-ins (your own subscriptions), like any machine.

1. In CodeDen, open Settings › Machines › **Connect this computer**. Any person may do this,
   whatever their role; connected agents can't.
2. Copy the command it shows and run it in a terminal on the computer to connect (Node.js 24 or
   newer, git and the agent CLIs you want there, signed in):

   ```sh
   npx -y codeden@<server version> connect https://codeden.example.com --code cdp_…
   ```

   The code works once, for 10 minutes. The address is the one your browser used.
3. The dialog turns to **Connected** when the computer's runner links in. It is now in Settings ›
   Machines as "*Your name*'s computer", with its state, platform, providers and capacity.

What the command does:

- It trades the code for a **device key**, saved with the server's address in
  `~/.codeden-runner/connect.json` (readable by you only). Only a hash of the key is kept on the
  server.
- It starts a runner in `~/.codeden-runner` (detached, as on a machine over SSH: it keeps
  running when the link drops) and links it to the server over a WebSocket
  (`/api/runner-connect`) carrying the runner protocol unchanged. Nothing listens on the laptop.
- When the link drops (sleep, Wi-Fi to tethering, the server restarting), it links again with
  backoff (1 s, doubling up to 30 s), and nothing that happened meanwhile is lost.

Later:

```sh
npx -y codeden@<version> connect            # link again, as paired before
npx -y codeden@<version> connect --detach   # the same, in the background (log: ~/.codeden-runner/connect.log)
npx -y codeden@<version> connect --stop     # end the background link; the runner keeps its agents
```

When the server is upgraded, the link stops and says which version to run `codeden connect` with.

**The server must be reachable from the laptop**: with network access on (Settings › Network) on
the same network or VPN, or behind HTTPS through a reverse proxy (DESIGN §15.1). The pairing
and link endpoints need no sign-in, since the code and the key are their credentials; bad codes
and keys are throttled per address like failed sign-ins, and written to the security log.

**It is yours.** Only you can place work on your computer: your own sessions (pick it in the New
session form's **Runs on**), and work nobody in particular started (a PM, an automation) only in
projects where you are an Owner. Other people don't see it in their pickers, the server refuses
anyone else's session there, Automatic never chooses it, and a project's "Where sessions run"
can't name it. Like every machine, its runner is untrusted: it only speaks for the sessions
placed on it.

**Disconnecting it.** Settings › Machines › Disconnect (you, or an Owner). The same rules as
removing a machine apply: refused while sessions placed there aren't archived, or a clone there
holds unpushed work (unless forced). Its key is revoked and its link ended, so `codeden connect`
there stops. To use it again, connect it again from Settings › Machines: with its
`connect.json` still there, it comes back as the same machine. Deleting a member disconnects
their computers.

## Choosing where sessions run

- **Per project:** Project page › Settings › Where sessions run: **This machine** (Home, the
  default), **A machine** by name, or **Automatic**.
- **Per session:** the New session form's **Runs on** picker overrides the project's setting.
- **The PM** can choose in `start_session` (`machine: "vps-1"`, `"home"` or `"auto"`).

A session on a machine shows the machine's name in its header, with its state. If the machine
can't be reached when a session starts there, the session fails with an inbox item saying which
machine and why; CodeDen keeps reconnecting, and the next message tries again.

The orchestrator and PMs always stay on Home. A fork stays on its source session's machine.

Each machine keeps one clone of each project (`~/.codeden-runner/repos/<project>`), fetched
from GitHub before every new session, and gives each session a worktree of it
(`~/.codeden-runner/wt/<project>/<session>`), as Home does. Archiving a session removes its
worktree; its branch stays in the machine's clone. Files, diffs, checkpoints, terminals and the
browser screencast work as on Home; the desktop app's native browser view is Home only.

## Automatic

With Automatic, each new session goes to Home or the machine with the most free capacity at that
moment. CodeDen asks every candidate for its capacity (cores, how busy the CPU was over the last
second, total and available memory; each gets 5 seconds to answer, and an answer is reused for
15 seconds) and scores it:

```
score = preference × cores × (1 − CPU busy) × (available memory ÷ total memory)
```

The highest score wins; on a tie Home wins, then the higher preference, then the name that sorts
first. A candidate is skipped when it isn't connected, is set to Manual only, the project isn't on
GitHub (machines only), the session's provider isn't installed and signed in there, its CPU is 95%
busy or more, its free memory is 5% or less, or it didn't answer.

On macOS, available memory counts what the system can reclaim (free, inactive, purgeable and
speculative pages), not only free pages. On Linux, a container's cgroup v2 limits count when set:
cores from `cpu.max`, CPU use from `cpu.stat`, and memory from `memory.max` and `memory.current`
less the reclaimable page cache. Without limits, the host's numbers count.

### Preferences

Each machine, and Home, has a preference (Settings › Machines):

| Preference | Weight | Meaning |
|---|---|---|
| Prefer | 100 | Chosen first when it has room |
| Normal | 50 | The default |
| Less often | 25 | Chosen when the others are busier |
| Manual only | 0 | Never chosen automatically; only by name |

### When no machine qualifies

- **You started the session:** New session says why ("No machine has codex installed and signed
  in", "All machines are busy") and offers **Run on Home**.
- **The PM or an automation started it:** it runs on Home, and its header says so ("Automatic
  placement found no free machine; ran on Home").

## Removing a machine

(Your own computer is disconnected instead: see
[Connecting your own computer](#connecting-your-own-computer).)

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

`CODEDEN_MACHINE_COMMAND` is read by the server when it starts, applies to every machine (and to
the `codeden connect` command Connect this computer shows), and is shown in Settings › Machines
("Machines run CodeDen with: …"). The version check still applies:
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
- **"was wiped or set up again"**: the machine's CodeDen data (`~/.codeden-runner`) is gone, for
  example after a rebuild, so CodeDen won't treat it as the same machine (it can't tell it from a
  different one). Click **Reconnect** under it in Settings › Machines: CodeDen checks it and adds
  it again under the same name and preference, so projects that use it keep working. Sessions
  placed there must be archived first; their work lived in the wiped data.
- **The machine shows disconnected**: CodeDen retries on its own. Check that the machine is up
  and that `ssh <machine>` works; the error under the machine says what the last attempt got.
- **Automatic never picks a machine**: open Settings › Machines and check its preference (not
  Manual only), its providers, and its live capacity. A machine that is busier than Home, or
  answers slowly, loses to it.
- **The runner's log** is `~/.codeden-runner/logs/runner.log` on the machine.
- **`codeden connect` says the key isn't valid any more**: the computer was disconnected. Pair
  it again from Settings › Machines › Connect this computer.
- **`codeden connect` can't reach the server**: open the address it names in a browser on the
  laptop. From another computer, network access must be on, or the server behind a proxy.
- **A connected computer is refused as "journal id … belongs to runner …"**: its runner was
  paired before as another machine and `connect.json` is gone, so CodeDen can't tell it is the
  same one. Disconnect the old one, then pair again with `--home` pointing at a new folder (or
  delete `~/.codeden-runner` once nothing there is needed).
