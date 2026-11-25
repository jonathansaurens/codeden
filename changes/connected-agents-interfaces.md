---
section: added
---

- **Connect agents over MCP, HTTP or the CLI.** A connected agent's token works with the remote MCP endpoint `/api/member-mcp`, the same tools on the HTTP API (`/api/member-tools/<name>`) and `codeden --server <url> --token <token> <command>`. The tools list projects and sessions, read transcripts, diffs and the inbox, message the orchestrator, PMs and sessions, start and stop sessions, answer questions and approvals, run automations and wait for a session, each filtered by the agent's role per project. The Add agent dialog shows ready-to-paste setup for MCP, the CLI and curl. What a connected agent writes reaches your agents as an untrusted member's message, never with the user's authority.
