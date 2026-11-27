---
section: security
---

- **Sessions you start are yours.** A client could start a session marked as started by a PM or the orchestrator (or as a PM itself), so its result woke the PM for a turn acting as an Owner on text the client chose. Sessions started from the API, the member tools, forks, hand-offs and reviews now always record the person or connected agent who started them, `POST /api/sessions` starts agent sessions only, and a PM turn that carries a notice about a person's session acts with no more than that person's role.
