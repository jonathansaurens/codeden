---
section: security
---

- **A revoked agent token is cut off at once.** Revoking a connected agent's token now also closes the connections it has open, such as a WebSocket, instead of only refusing its next request.
