---
section: security
---

- **The orchestrator and PMs act with your role.** On a shared server, every orchestrator and PM tool call is checked against the role of the people whose messages started the turn (the lowest among them; a message the orchestrator passes on counts as its person's), by the same rules as their own requests. An Operator can no longer have the orchestrator create or change a project, or a PM create or change an automation, and the orchestrator's project list, overview, inbox and digest leave out projects hidden from its person. A refused call names the role it needs. Turns started only by notices, wake-ups and automations act as before, and single-user installs are unchanged.
