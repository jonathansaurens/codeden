---
section: fixed
---

- **Team server edge cases.** Resuming the factory of a project that doesn't exist answers "not found"; a member with a hidden project gets the same "not found" for a missing inbox item as for a hidden one; the member tools list leaves out tools the agent can't use anywhere (`answer_approval` without **May answer approvals**); and an empty JSON-RPC batch on `/api/member-mcp` answers Invalid Request.
