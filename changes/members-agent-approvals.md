---
section: security
---

- **Connected agents can't decide approvals another way.** An agent without **May answer approvals** could raise a session's permissions to Auto or Full, or cancel a pending approval by sending it an answer or a cancel. Both are refused now: raising permissions needs the same setting, and a response that doesn't match the pending request (an answer to an approval, a decision to a question) is refused for everyone.
