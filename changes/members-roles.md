---
section: security
---

- **Roles are enforced on the server.** Members are Viewers (watch everything, read-only terminals), Operators (also message agents, start, stop and answer, run automations, commit and push) or Owners (also settings, projects, members, secrets and network access), server-wide with per-project overrides; a project where someone has no role is hidden from them. Every HTTP route, UI WebSocket and terminal checks the role through one table, and the UI hides what the server would refuse. Single-user installs behave exactly as before.
