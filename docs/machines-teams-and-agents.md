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
| 7 | Orchestrator and PMs | **Never balanced automatically.** The orchestrator is **personal** (one per person, private); each project has one shared PM. Each runs where its owner chooses: the server, a machine, or the person's own computer (Part D) | They hold long conversations and act with authority, so they stay put and act only as far as their person may |
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
- **As built (fork):** the HTTP API is `GET /api/member-tools` and `POST /api/member-tools/<tool>` with the tool's input as JSON, so MCP, HTTP and the CLI share one list (the UI's own routes accept member tokens too, under the same role table). `start_session` takes `machine` (`home`, `auto` or a machine's name), as the PM's tool does.
- **Setup snippets** in the Add agent dialog: an `mcp.json` entry, a `claude mcp add` command, and a curl example.

### C.3 Safety

- **Approvals by agents.** An Operator agent can answer approvals on its projects only when the owner ticks **May answer approvals** for it (off by default). Questions are always allowed.
- **Rate limits** per token (a burst limit plus a per-minute budget), and the throttling of §15.1 for failed tokens.
- **Untrusted content.** Text from connected agents is untrusted content, like GitHub text (DESIGN §15): it reaches the PM or orchestrator as a message, never as instructions with more authority than the member's role.

## Part D. Role agents: who owns them and where they run

> Status: **decided 2026-11-26.** Replaces decision 7's "stay on the home runner".

The orchestrator and the PMs are not like agent sessions. They hold one long conversation, they act through CodeDen's tools rather than by editing code, and what they may do depends on who asked. This part defines who they belong to, what they may do, and where they run.

### D.1 Who they belong to

| | Orchestrator | PM |
|---|---|---|
| How many | **One per person** | One per project |
| Belongs to | The person | The project (the team) |
| Who sees its chat | **Only its person.** Not even Owners | Everyone who can see the project |
| Connected agents | **Get none**: they do that job themselves. They message PMs directly | Can message it (Operator) |

- **A single-user install** has one person, the first owner, so nothing changes: the existing orchestrator is the first owner's.
- **When a member is deleted**, their orchestrator is retired (stopped and archived). Its transcript stays in the database, and nobody else can open it.
- **The orchestrator sees only its person's projects**: its project list, overview, digest and inbox leave out projects hidden from them.

### D.2 What they may do: the authority of a turn

Every orchestrator and PM tool call is checked against a **role**, the same way a person's request is (`authorize.ts`):

- **The orchestrator** always acts as its person. An Operator's orchestrator can message PMs and start work on the projects where they're an Operator, but can't create or change projects (Owner).
- **A PM turn** acts with **the lowest role among the people whose messages started it**. A turn that only automatic events started (notices, wake-ups, automations, GitHub) acts as an Owner of the project, as today. A notice about a session a person started counts as from that person, so it never makes a turn act as an Owner. A message a PM received from an orchestrator counts as from that orchestrator's person.
- **A refused tool call** tells the agent which role it needs ("Only an Owner can change automations; ask an Owner"), so it can tell the person rather than retry.
- Tools gated this way: project create/update (Owner), automation create/update (Owner), trusted issue authors (Owner); messaging, starting, stopping and steering sessions, running automations, answering questions (Operator).
- **As built (fork, D1):** each tool declares the role it needs (`ServerTool.authority`, checked in the tool registry before the handler). Pausing, resuming and skipping automations need an Owner too, and an automation for every project an Owner server-wide, as their HTTP routes do; filing, triaging and commenting on issues, project notes and the factory's decisions need an Operator. No PM tool changes the trusted authors list (an Owner's project setting), so starting work on an untrusted author's issue keeps its rule: only in a turn a person's own message started. The people of a turn are recorded when its message reaches the runner and with each message that steers it (kept with the session, so they survive a restart); a deleted member has no role. An orchestrator message to a PM carries its person (`UserInput.onBehalfOf`, also on held-back messages); only CodeDen sets it: a message from a person or connected agent, on every route and member tool, keeps only its text and attachments (`clientInput`), so `onBehalfOf`, `from`, `relayedForUser`, `author` and `checksRound` are never the client's. Work a person or connected agent starts (`POST /api/sessions`, which starts agent sessions only, a conflict's replacement, the `start_session` member tool, forks, hand-offs and reviews) always records `startedBy: { kind: "user", id: <member> }` and no parent session; the starter of a session notice delivered with a PM turn counts among the turn's people. An `ask_pm` answer goes only to a question CodeDen recorded, from the PM turn CodeDen delivered it to, and only to the orchestrator that asked. With the one shared orchestrator, that is whoever's message started its turn (the lowest role, if several steered it), the first owner for an automatic turn.

### D.3 Where messages and notices go

- **A PM's report goes to the orchestrator that handed it the work**: the reply to an `ask_pm`, and every report on work an orchestrator started (`startedBy.reportTo`).
- **Anything else a PM reports** (an unprompted `message_orchestrator`, the factory digest) goes to the orchestrator of **every Owner of the project**. Informational reports never wake an orchestrator, as today.
- Notices about sessions an orchestrator started go to that orchestrator only.

- **As built (fork, D2):** an orchestrator session records its person (`sessions.owner_member_id`; none recorded is the first owner's, so existing installs keep theirs), and so do notices for an orchestrator (`notices.member_id`). The first owner's keeps the work key `orchestrator:main`; another person's is `orchestrator:<member id>`. Wake keys, wake-ups and undelivered notices are per orchestrator. A PM's reports in a turn that orchestrators' messages started go back to them, as do the results of work it starts there with `reportTo` (`StartedBy.reportToMembers`); a report nobody asked for goes to every Owner's orchestrator, each its own copy. Someone else's orchestrator answers as if it didn't exist on every route, socket, search and member tool, for Owners too, and `POST /api/sessions` no longer starts an orchestrator. The orchestrator routes need the member's highest role anywhere (`own` scope), since it acts project by project; so does every session route, inbox item and live stream about the member's own orchestrator (it has no project, which would otherwise give their lowest role), and `GET /orchestration/roles` and `/notices`, filtered to the projects they can see. Until D4 all orchestrators shared the working directory `<home>/orchestrator/`.

### D.4 Where they run

**Runs on** is a setting, never chosen automatically:

| | Set by | Choices | Default |
|---|---|---|---|
| Orchestrator | Its person, in the orchestrator chat's ⋯ menu | **The server**, a **machine**, or **one of their own computers** | The server |
| PM | An Owner, in the project's settings | **The server** or a **machine** (an Owner's own computer counts as a machine for this) | The server |

- **Working directory:** the orchestrator runs in `<runner home>/orchestrator/<member id>`. The PM runs in the project's clone on that machine (`~/.codeden-runner/repos/<project>`), read-only and fetched before each turn. A project that isn't on GitHub can't move its PM off the server.
- **Logins:** the agent uses the provider logins of the device it runs on. That is the point of running your orchestrator on your own computer: it uses your own subscription.
- **Changing it** moves the role the way a provider change does (orchestration.md): the conversation is retired once no turn is running, and the next message starts a fresh one there. Notes, wake-ups, undelivered updates and queued messages carry over.
- **When the device can't take it** (offline, or the provider isn't installed and signed in there), the turn runs on the server and the chat says why ("Your computer is offline; this turn ran on the server"). It goes back on the next turn once the device is there again. If the server can't run it either, the message waits and the chat says so.
- **As built (fork, D4):** a person's orchestrator setting is stored per member (`member_preferences.orchestrator_runs_on`, the first owner's under `owner`), set with `GET|PUT /api/orchestration/orchestrator/runs-on`; a PM's is the project's `pmRunsOn` (`projects.pm_runs_on`), set by an Owner with `PATCH /api/projects/:id`. Both hold `server` or a machine's record id. A choice is refused for a machine that doesn't exist (400 `unknown_machine`), someone else's own computer (403 `machine_not_yours`, the same access rule as any work placed there: a PM may go to a person's computer only while they are an Owner of the project) and, for a PM, a project that isn't on GitHub (400 `machine_unavailable`). The device is checked whenever the role is used (each message and wake), never during a turn: the machine must be connected, the role's provider (the project's default, else the role's setting; on Auto the first ready read-only provider there) installed and signed in there, and for a PM the project on GitHub. On Home each person's orchestrator works in `<home>/orchestrator/<member id>`, the first owner's still in `<home>/orchestrator/`; on a machine it is `<runner home>/orchestrator/<member id>` (a new `workspace.prepare` strategy `folder`). A PM on a machine works in the project's clone itself (`clone` with `perProject` and `projectRoot`): no worktree, no setup, the same command fetching and fast-forwarding it before each turn (a failed fetch lets the turn go on). Role tools reach CodeDen over the machine's link with the session's own token, as an agent session's do: the link only checks that the token's session is routed to that runner.
  - **What "this turn runs on the server" means.** A session belongs to one runner and a provider conversation can't be resumed on another device, so every change of device is a fresh conversation, exactly like a provider change: the old one is retired (stopped, archived, its transcript kept) and the new one starts on the other device, taking over the queue; notes, wake-ups, undelivered updates and the work in progress carry over, the history doesn't. A fallback is therefore a fresh conversation on the server that lasts until the chosen device can take a turn again; the first message or wake after that starts another fresh one back there. The chat says each time, at the start of the new conversation's first turn: "Moved to vps-1.", "vps-1 is offline; this turn runs on the server, until vps-1 can take it again.", "Back on vps-1." Flapping devices cost a fresh conversation per change; we chose that over keeping two conversations of one role alive, which would split its context and its queue.
  - A conversation that fails to start on the chosen machine (its workspace or provider couldn't be opened there; not a usage limit, a refusal by policy, or a start the machine didn't answer, which may still open) falls back the same way at once: it is retired, a fresh one starts on the server with its queue ("vps-1 couldn't start it (…); this turn runs on the server, until vps-1 can take it again."), and the machine is tried again with the next message or wake.
  - When neither the device nor the server's runner can take it, the role keeps its conversation, the person's message waits in its queue (it isn't refused), the chat's latest turn says why, and the devices are tried again every 30 seconds. A conversation retired on a machine that is offline is archived on the server; its provider process there stays idle until that runner restarts.

### D.5 Connecting your own computer

A person's laptop usually can't be reached over SSH (it sleeps, moves between networks, sits behind NAT), so it links **out** to the server instead.

- **Pairing.** Settings › Machines › **Connect this computer** (any person, not only Owners) shows a command with a single-use pairing code valid for 10 minutes: `npx -y codeden@<version> connect <server address> --code <code>`. Running it on the laptop trades the code for a **device key** stored in `~/.codeden-runner/connect.json` (mode 0600), starts a runner there and links it.
- **The link** is a WebSocket from the laptop to `<server>/api/runner-connect`, authenticated by the device key and carrying the runner protocol unchanged. It reconnects with backoff after sleep or a network change and resumes by `seq`, like any runner link. `codeden connect --detach` keeps it running in the background; `codeden connect --stop` ends it.
- **A personal machine.** The computer shows in Settings › Machines as "*Name*'s computer" with its owner. It is treated as untrusted, like any machine. Only its person may place work on it: their orchestrator, their own sessions, and a PM if they are an Owner. Automatic never chooses it, and other people don't see it in their pickers.
- **Removing it:** its person or an Owner can **Disconnect** it, which revokes the device key. A member who is deleted loses their computers too.

**As built (2026-11-26), D3** ([machines.md](machines.md#connecting-your-own-computer)), with these choices where this plan was silent:
- **Who may connect:** any person, Viewers included (what they may run there is still their role's); never a connected agent. The command names the address the browser used (the trusted HTTPS origin when there is one), and honours `CODEDEN_MACHINE_COMMAND`.
- **Secrets:** pairing codes (`cdp_…`, 120 bits) and device keys (`cdk_…`, 256 bits) are stored as SHA-256 hashes in `machine_credentials`, outside the event log. A code is marked used in the same statement that checks it, so it pairs one computer at most. The pairing endpoint (`POST /api/runner-connect/pair`) and the link (`GET /api/runner-connect`, `Authorization: Bearer <key>`) are public paths that authenticate themselves; bad codes and keys are throttled per address with the sign-in rules and go to the security log. A key also stops working once its machine record is removed.
- **The link on the server** is a transport of its own, `incoming`: the server never dials, so the client's every (re)connect waits for, and adopts, the computer's next socket (one waiting for a client is kept). A newer socket from the same computer ends the one the server still holds (close code 4000), and the client resumes by `seq` on the new one. The server pings every 30 s and drops a link that doesn't answer; the computer does the same every 20 s. Disconnecting closes the link with 4401, which ends `codeden connect`.
- **The record:** a `runners` row with backend `connected`, the person in `ownerMemberId`, the computer's host name in `sandboxRef` and a label made from it (unique among machines). Pairing again with the `connect.json` still there (`previousMachineId`) keeps the same record when it is the same person's, so its runner's journal stays its own; without it, a runner paired before is refused as another machine's.
- **Who places work there:** the person themselves; with no person behind the work (a PM, an automation), only where they are an Owner of the project; never a connected agent. A project's "Where sessions run" can't name someone's computer (it is chosen per session), and Automatic skips it.
- **`codeden connect`** lives in `~/.codeden-runner` (`--home` to change), so a CodeDen installed on the same computer never switches its version. It checks the server's version before each link and stops with the command to run when the server was upgraded, rather than starting a runner the server would drain. `--detach` runs it as a background process (`connect.pid`, `connect.log`), `--stop` ends that.
- Not yet: running the orchestrator or a PM there (D4).

### D.6 Phases

1. **D1 `fix(members): role agents act with their person's role`.** D.2 and the visibility rules of D.1, with the single shared orchestrator as it is. This closes the gap where an Operator could create projects through the orchestrator.
2. **D2 `feat(orchestration): a personal orchestrator for each person`.** D.1 and D.3.
3. **D3 `feat(machines): connect your own computer`.** D.5.
4. **D4 `feat(orchestration): choose where the orchestrator and PMs run`.** D.4.

## Open questions

1. **For the maintainer:** Parts B and C against DESIGN §3 "No accounts" and the network rule (above).
2. **A3:** should Automatic also count CodeDen's own sessions per machine (a per-machine session cap), or is live capacity enough? Proposed: capacity only, with a cap as a later setting.
3. **Part B:** should Viewers see live terminals, or only transcripts? Proposed: read-only terminals.
4. **Part C:** a per-agent spending budget (DESIGN §12.6) for sessions an agent starts? Proposed: later, using the factory budget's mechanism.
