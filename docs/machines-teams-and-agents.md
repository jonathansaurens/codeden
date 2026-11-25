# Machines, teams and connected agents: design and plan

> Status: **proposed 2026-11-25**. It extends [remote-runners.md](remote-runners.md) (§7 recommends an SSH exec link first, which Part A builds) and touches two rows of DESIGN §3 ("No accounts" and the network rule), marked **Needs the maintainer's decision** where they apply. Nothing here changes those rules until that decision.

CodeDen runs everything on one computer today. This plan lets it grow in three steps that build on each other:

- **A. Machines.** Your main CodeDen keeps the UI, the orchestrator and the PMs, and runs agent sessions on other computers you can SSH into (a VPS, another laptop, several of them). It can place new sessions automatically on the machine with the most free capacity.
- **B. Teams.** A CodeDen server (typically on a VPS) is shared by several people. Each person signs in as themselves, with a role, and sees the same projects, PMs, agents and inbox live.
- **C. Connected agents.** An agent running elsewhere (a Claude Code session on someone's laptop, a chat bot, any MCP-capable agent) signs in like a team member, with its own token and role, and uses CodeDen the way a person would.

B and C share one identity layer: a **member** is a person or an agent, with a role.

## 1. Decisions at a glance

| # | Question | Decision | Why, in one line |
|---|---|---|---|
| 1 | How the server reaches another machine | **SSH exec link**: `ssh <host> codeden runner-link`, spliced to a runner on that machine | No listener anywhere; the existing exec transport already carries the runner protocol (remote-runners §6, §7) |
| 2 | What runs on the machine | **A long-lived runner** of its own, serving many sessions, started detached over SSH | One runner per machine, like the home runner; sandboxes stay one per session |
| 3 | Agent logins on a machine | **The machine's own** CLI logins. A machine qualifies for a session only if that provider is installed and signed in there | No credentials leave the main machine |
| 4 | Trust | A machine's runner is **untrusted**, like a sandbox runner (remote-runners §8): routing checks, MCP over the link, brokered GitHub credentials | Its agents have a shell on it |
| 5 | Placement | Per project: **Home**, **a named machine** or **Automatic**; per session override; the PM can name a machine | Predictable by default, automatic when asked |
| 6 | Automatic placement | Score each eligible machine by **preference × cores × free CPU share × free memory share**; highest wins (§A.5) | Uses live capacity, lets people bias it, never picks an overloaded machine |
| 7 | Orchestrator and PMs | **Stay on the home runner** (remote-runners §15) | Unchanged |
| 8 | Team hosting | A headless server, usually on a VPS, reached over HTTPS through a reverse proxy on that machine (DESIGN §15.1) | Already supported for one person |
| 9 | Identity | **Members** (people and agents). People join by **invite link** and set their own passphrase; agents get a **token**. No external identity provider | Local-first, nothing hosted |
| 10 | Roles | **Viewer**, **Operator**, **Owner**, server-wide with **per-project** overrides | Covers watch, work and administer |
| 11 | Agent interface | A **remote MCP endpoint** with member-level tools, plus the same actions on the HTTP API and `codeden` CLI | Most agents speak MCP; scripts use HTTP |
| 12 | Order | A (machines, then automatic placement), B (members and roles), C (agent members) | A stands alone; C reuses B |

## Part A. Machines over SSH

### A.1 What exists

- `RunnerHub` drives several runners, each over its own `RunnerTransport` (remote-runners §6, §8). The exec transport runs a `LinkProcess` with stdin and stdout, which `ssh` provides.
- Untrusted-runner checks, MCP over the link, workspace cloning and file access over the link, and brokered GitHub credentials are built (Phases 1–3).
- What's missing: an SSH backend, machine records shared by many sessions, a placement choice and a picker (the planned Phase 5), and host capacity reporting.

### A.2 Adding a machine

Settings › Machines › **Add machine**, or `codeden machines add <ssh-destination> [--name <label>]`.

- **The destination is anything `ssh` accepts:** `user@host`, a `Host` alias from `~/.ssh/config`, a Tailscale name. CodeDen runs the user's own `ssh` with `BatchMode=yes`, so keys, agents, jump hosts and `ProxyCommand` work as they do in a terminal, and nothing ever prompts. CodeDen stores no SSH keys or passwords.
- **The check, before saving:** `ssh <dest> node --version` (Node 24+), then `ssh <dest> npx -y codeden@<server version> --version`. Each failure says what to fix ("Node 24 or newer is needed on vps-1; found 20.11").
- **Versions always match.** Every command on the machine runs as `npx -y codeden@<exact server version> …`, so upgrading CodeDen upgrades its machines on their next link, and a runner of another version is drained as today.
- **Detection.** The machine's runner reports its platform, arch, providers (installed, signed in, models) and capacity (§A.5) in `welcome` and on request, as the home runner does.

### A.3 The runner on a machine

- **Started detached:** `ssh <dest> npx -y codeden@<v> runner --home ~/.codeden-runner --detach`, which starts the runner if its lock file shows none alive. It survives the link and the server going away, like the home runner today.
- **Linked:** `ssh <dest> npx -y codeden@<v> runner-link --home ~/.codeden-runner` through the existing exec transport. A dropped link reconnects with backoff and resumes by `seq`.
- **Home on the machine:** `~/.codeden-runner` (journal, lock file, per-project clones and worktrees). Separate from a CodeDen the person may also run there.
- **Records:** one `runners` row per machine (`backend: ssh`, `sandboxRef` the destination, `label`, `weight`), shared by every session placed on it.
- **Removing a machine** refuses while sessions are placed on it, unless they are archived first. The same unpushed-work check as docker archives (#337) applies, through `git.unpushed`.

### A.4 Workspaces on a machine

- **GitHub projects only**, as with sandboxes: the machine clones from GitHub with the brokered credential (remote-runners §9.2). A local-only project stays on Home.
- **A1 reuses the existing per-session clone** (remote-runners §9.1). **A2 moves to one clone per project per machine** (`~/.codeden-runner/repos/<project>`), fetched before each session, with **a worktree per session** like the home runner, since cloning a large repository for every session is slow.
- Files, diffs, checkpoints, terminals and the browser screencast work through the existing runner commands. Native browser views stay local-only (remote-runners §12).

### A.5 Placement and automatic balancing

**Where sessions run** (project settings): **Home** (default), **a machine**, or **Automatic**. New session and the PM's `start_session` can override it per session (`machine: "<label>" | "auto" | "home"`). Forks stay with their source session.

**Preference per machine:** **Prefer** (100), **Normal** (50, default), **Less often** (25), **Manual only** (0: never chosen automatically, only by name).

**Eligible machines** for a new session: connected, preference above 0, the project allowed there (GitHub), the session's provider installed, enabled and signed in on it, and its capacity known. Home is a candidate like any other machine, with its own preference.

**Capacity.** A new runner command `host.resources` answers `{ cpuCount, cpuBusy (0–1, sampled over 1 s), totalMemoryBytes, availableMemoryBytes, sampledAt }`. On macOS, available memory counts reclaimable memory (`vm_stat`: free, inactive, purgeable, speculative), since `os.freemem()` reports only free pages there. The server asks every eligible machine at placement time, with a 5 s deadline, and reuses an answer for up to 15 s.

**Choosing:** each eligible machine scores

```
score = preference × cpuCount × (1 − cpuBusy) × (availableMemory ÷ totalMemory)
```

and the highest score wins. A machine is skipped when its CPU is 95% busy or more, its free memory is 5% or less, or its answer is older than 15 s or missing.

**When no machine qualifies:**
- **A session started by a person:** the form says why ("No machine has Codex signed in", "All machines are busy") and offers Home.
- **A session started by the PM or an automation:** it runs on Home, and the session says so in its header ("Automatic placement found no free machine; ran on Home").

**Seen in the UI:** a machine chip in the session header; Settings › Machines with state, version, platform, providers, live capacity, preference and sessions; an inbox item when a machine can't be reached for a session.

### A.6 Phases

**A1 `feat(runner): SSH machines`.**
- The `ssh` backend: add, check, start, link and remove.
- `codeden machines` CLI.
- Settings › Machines, with a list, add and remove.
- Placement by name only.

Accept when:
- [ ] A Fake-provider session runs on a second machine over SSH (a localhost `sshd` in the slow suite).
- [ ] Killing the link mid-turn loses no events.
- [ ] Removing a machine with unpushed work keeps it.

**A2 `feat(runner): per-project clones and worktrees on machines`** (§A.4).

**A3 `feat(server): automatic placement`.**
- `host.resources`, preferences, the scorer and Automatic in project settings, New session and `start_session`.

Accept when:
- [ ] The scorer has unit tests for every skip rule and tie.
- [ ] A scripted hub places sessions on the expected machine.
- [ ] The no-machine fallbacks behave as described in §A.5.

**A4 `feat(web): machine chip, capacity and inbox items`** (the rest of remote-runners Phase 5).

**As built (2026-11-25).** Part A is built as above ([machines.md](machines.md)), with these choices where this plan was silent:
- Worktrees on a machine live in `~/.codeden-runner/wt/<project>/<session>`, beside the clones in `repos/`.
- The scorer breaks a tie for Home, then the higher preference, then the label that sorts first. Capacity is asked only of machines that could take the session.
- On Linux, `host.resources` honours cgroup v2 limits (`cpu.max`, `cpu.stat`, `memory.max`, `memory.current` less `inactive_file`), so a container reports what it may use rather than the whole host.
- Automatic may be set on any project; one that isn't on GitHub always lands on Home.
- `CODEDEN_MACHINE_COMMAND` replaces `npx -y codeden@<version>` for development builds (owner only, shown in Settings › Machines).
- Not yet: forking a session that runs on a machine (refused as for sandboxes), and the slow-suite test against a real localhost `sshd`.

## Part B. Teams

> **Needs the maintainer's decision.** DESIGN §3 says "No accounts or license gating". This plan reads that as "no CodeDen-hosted accounts": members are local to a self-hosted server and nothing is hosted or licensed. It also replaces §15.1's single owner password with members. Until agreed, Part B lives in the fork.

### B.1 Hosting

- **The server runs headless on a VPS** (`npx codeden --no-open`, or a service unit from the self-hosting guide, remote-runners Phase 8).
- **People reach it over HTTPS** through a reverse proxy on that machine (§15.1 trusted origins: Tailscale Serve, or Caddy for a public name), or through the desktop app's remote servers (#647).
- **The VPS can run sessions itself** (Home), and reach more machines over SSH (Part A).

### B.2 Members, invites and sign-in

- **The first owner.** Setting up network access creates the first member: the owner, with today's password as their passphrase. Existing installs migrate the same way, and their signed-in devices stay signed in as the owner.
- **Invites.** An owner creates an invite with a role (and optional per-project roles). The invite link holds a single-use secret, valid for 7 days.
- **Joining.** The invitee opens the link, picks a display name and a passphrase (the §15.1 rules), and is signed in. Passkeys can follow later.
- **Sessions.** Sessions are as in §15.1 (HttpOnly cookie, hashed, 90 days, throttled sign-in), now tied to a member. Owners can see and revoke any member's devices, and can disable or delete members.
- **The machine's own browser and the desktop window** use the install token, which acts as the owner.

### B.3 Roles

| Role | Can |
|---|---|
| **Viewer** | See everything live: projects, the orchestrator, PM and agent transcripts, diffs, files, terminals (read-only), the inbox, usage and the factory |
| **Operator** | Viewer, plus act on work: message the orchestrator, PMs and sessions; start, stop and archive sessions; answer questions and approvals; comment on diffs; run automations; commit, push and open PRs from a session |
| **Owner** | Operator, plus administer: settings, projects, automations, machines, members and invites, secrets and provider logins, network access |

- **Per-project overrides.** A member's server-wide role can be raised or lowered for a project, e.g. Viewer everywhere and Operator on `helpdesk-ai`. A project where the member has no role is hidden from them.
- **Enforcement** is on the server: every route and every WebSocket message checks the member's role for that project. The UI only hides what the server would refuse.

### B.4 Seeing who did what

- **Attribution.** Every event caused by a person carries `actor: { memberId, kind: "person" | "agent" }`. The UI shows the name on messages, approvals, comments, stops and settings changes, and the transcript shows who sent each message.
- **Presence.** Who is looking at a session (an avatar row in its header). Typing indicators are out of scope.
- **Simultaneous answers.** Two people answering the same question or approval: the first answer wins, and the second sees who answered.

## Part C. Connected agents

> **Needs the maintainer's decision**, as Part B (it adds a remotely reachable MCP endpoint next to the loopback-only `/mcp`).

### C.1 Agent members

- **Created by an owner:** Settings › Members › Add agent. It gets a name, a role (Viewer or Operator; never Owner), optional per-project roles, and a token shown once.
- **Tokens** are random, stored hashed and revocable, with a last-used time. They're sent as `Authorization: Bearer`.
- **Attribution.** An agent appears as a member, marked as an agent, everywhere its actions are attributed.

### C.2 Interfaces

- **Remote MCP endpoint `/api/member-mcp`** (Streamable HTTP), separate from the internal `/mcp`, which stays loopback-only with session tokens. It's reachable wherever the UI is (§15.1).
- **Member-level tools**, each a thin wrapper over the same service the UI's API calls, filtered by the member's role per project:
  - **Reading:** `list_projects`, `get_project_status`, `list_sessions`, `get_session` (state and recent transcript), `get_diff`, `list_inbox`.
  - **Working (Operator):**
    - `message_orchestrator`, `message_pm`, `message_session`
    - `start_session` (with machine placement, §A.5), `stop_session`
    - `answer_question`, `answer_approval`
    - `run_automation`
  - **Following along:** `wait_for_session` (blocks until a session is idle, finished, or needs input, up to a deadline), so an agent can hand off work and come back.
- **HTTP API and CLI.** The same actions on the documented HTTP API, and `codeden --server <url> --token <token> <command>` for scripts.
- **Setup snippets** in the Add agent dialog: an `mcp.json` entry, a `claude mcp add` command, and a curl example.

### C.3 Safety

- **Approvals by agents.** An Operator agent can answer approvals on its projects only when the owner ticks **May answer approvals** for it (off by default). Questions are always allowed.
- **Rate limits** per token (a burst limit plus a per-minute budget), and the throttling of §15.1 for failed tokens.
- **Untrusted content.** Text from connected agents is untrusted content, like GitHub text (DESIGN §15): it reaches the PM or orchestrator as a message, never as instructions with more authority than the member's role.

## Open questions

1. **For the maintainer:** Parts B and C against DESIGN §3 "No accounts" and the network rule (above).
2. **A3:** should Automatic also count CodeDen's own sessions per machine (a per-machine session cap), or is live capacity enough? Proposed: capacity only, with a cap as a later setting.
3. **Part B:** should Viewers see live terminals, or only transcripts? Proposed: read-only terminals.
4. **Part C:** a per-agent spending budget (DESIGN §12.6) for sessions an agent starts? Proposed: later, using the factory budget's mechanism.
