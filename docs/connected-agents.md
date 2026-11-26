# Connected agents

A **connected agent** is another agent (one running on your laptop, in CI, or anywhere else) that uses a CodeDen server as a member: it can follow sessions, hand work to a project's PM, start and stop sessions, and answer questions, within the role you give it. It talks to CodeDen over **MCP**, the **HTTP API** or the **`codeden` CLI**, with a token of its own.

## Add an agent

**Settings › Members › Add agent** (owners only):

1. **Name** it (it appears under this name wherever its actions are shown).
2. Pick its **role**: **Viewer** (read only) or **Operator** (can act on work). An agent is never an Owner.
3. Optionally give it a different role on some projects, or **No access** to hide a project from it.
4. **May answer approvals** is off by default. Without it the agent can answer agents' questions, but approvals wait for a person, and it can't raise a session's permissions above Supervised (when starting one or later), since that would let actions pass without asking.
5. **Add agent**. The token (`cda_…`) is shown **once**, with setup snippets.

Each agent's row shows its tokens with when they were last used. **Revoke** one if it leaks (its open connections close at once); **New token** issues another (old ones keep working until revoked). **Enabled** switches the agent off without deleting it.

## Connect over MCP

The endpoint is `https://<your server>/api/member-mcp` (Streamable HTTP). Send the token as `Authorization: Bearer <token>`.

An `mcp.json` entry:

```json
{
  "mcpServers": {
    "codeden": {
      "type": "http",
      "url": "https://codeden.example.com/api/member-mcp",
      "headers": { "Authorization": "Bearer cda_…" }
    }
  }
}
```

Or with Claude Code:

```sh
claude mcp add --transport http codeden https://codeden.example.com/api/member-mcp \
  --header "Authorization: Bearer cda_…"
```

The endpoint is reachable wherever the CodeDen UI is (this computer, your LAN or VPN with network access on, or your HTTPS proxy; see [Teams](teams.md#host-it-on-a-vps)). It is separate from CodeDen's internal `/mcp`, which only CodeDen's own sessions use, stays on 127.0.0.1, and refuses agent tokens.

## Tools

What an agent sees follows its role: a Viewer agent gets the reading tools only, and every call is checked against its role on that project.

| Tool | Role | What it does |
|---|---|---|
| `list_projects` | Viewer | The projects it can see, with its role on each |
| `get_project_status` | Viewer | A project's sessions in play, what waits on people, recent results |
| `list_sessions` | Viewer | Sessions, newest first, by project and status |
| `get_session` | Viewer | One session: status, result, what it waits on (with inbox ids) and its recent transcript |
| `get_diff` | Viewer | The session's changes, or only the uncommitted ones |
| `list_inbox` | Viewer | Open inbox items |
| `wait_for_session` | Viewer | Wait until a session is idle, finished or needs input, up to `timeoutSec` (at most 300) |
| `message_pm` | Operator | Message a project's PM |
| `message_session` | Operator | Message a session's agent (queued while it works, or `steer`) |
| `start_session` | Operator | Start an agent session with a prompt, optionally on a machine (`home`, `auto` or a machine's name) |
| `stop_session` | Operator | Stop a session |
| `answer_question` | Operator | Answer an agent's question (not MCP servers' forms: those stay with people) |
| `answer_approval` | Operator, with **May answer approvals** | Approve or deny an action |
| `run_automation` | Operator | Run an automation in a project, at the automation's own permission level |

A typical hand-off: `start_session` (or `message_pm`), then `wait_for_session` in a loop, then `get_session` and `get_diff`.

A connected agent has no orchestrator: it does that job itself, and messages a project's PM directly. People's orchestrators are private to them, so it can't read those either.

## HTTP API

The same tools, one route each:

- `GET /api/member-tools`: the tools this token may use, with each one's JSON Schema.
- `POST /api/member-tools/<tool>`: call one, with its input as the JSON body. Answers `{ "result": … }`, or `{ "error": { "code", "message" } }` with 400, 403 (role), 404 (unknown tool, or a project it can't see), 409 (already answered, conflicts) or 429 (rate limit).

```sh
curl -s -X POST https://codeden.example.com/api/member-tools/list_sessions \
  -H "Authorization: Bearer cda_…" -H "content-type: application/json" \
  -d '{"status": ["waiting"]}'
```

The UI's own HTTP API also accepts the token, under the same role rules.

## CLI

```sh
npx codeden --server https://codeden.example.com --token cda_… tools
npx codeden --server https://codeden.example.com --token cda_… start-session --projectId <id> --prompt "Fix the flaky test"
npx codeden --server https://codeden.example.com --token cda_… wait-for-session --sessionId <id> --timeoutSec 300
```

Commands are the tool names (dashes or underscores), flags their input; `--json '{…}'` passes the whole input. `CODEDEN_TOKEN` can hold the token instead of `--token`. The result prints as JSON.

## Safety

- **Its words are untrusted content.** Whatever a connected agent sends (through the tools or the HTTP API) reaches your agents as a message from a member, introduced with the agent's name and role, never as your own words or CodeDen's instructions. It doesn't carry your authority: for example a PM won't start work on an issue from an untrusted author because a connected agent asked. A PM turn its message started acts with the agent's role, so a PM won't change an automation for it either.
- **Approvals need a person** unless you turned on **May answer approvals** for that agent; it can still answer questions. Without it the agent also can't set a session's permissions to Auto or Full, and an answer or a cancel sent to an approval is refused. MCP servers' forms (which can ask for keys) always wait for a person.
- **Rate limits.** Each token can make a burst of 30 requests, then 120 a minute on average (429 with `Retry-After` beyond that). A long `wait_for_session` counts once.
- **Bad tokens are throttled** per address like wrong passwords (after three, each try waits, then the address is locked out for 15 minutes), and logged in `~/.codeden/logs/remote-access.log`.
- **Tokens are stored hashed** (SHA-256), shown once, and revocable. A disabled or deleted agent's tokens stop working at once.
- **Never an owner.** An agent can't change settings, members, secrets or network access, and can't open a shell on the server.
- Everything it does is attributed to it (marked as an agent) in transcripts, answers and Settings › Members › Recent activity.
