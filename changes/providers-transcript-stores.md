---
section: security
---

- **Agents can't read other conversations' transcripts.** The agent CLIs keep every conversation they ran as plain files in the home folder (`~/.claude/projects`, `~/.codex/sessions`, OpenCode's `storage`, `~/.cursor/chats`, `~/.gemini/tmp`), so an agent on the server could read other people's orchestrators and the sessions of projects hidden from them. Reading those stores now asks at every level, and read-only sessions (the orchestrator, the PMs) are refused, as for CodeDen's own home. A Claude session's own memory folder stays readable.
