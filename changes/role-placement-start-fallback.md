---
section: fixed
---

- **An orchestrator or PM that can't start on its machine runs on the server.** When the conversation failed to start on the machine or computer chosen in "Runs on", it ended as failed and your message waited there. It now falls back to the server at once, with your message, and the chat says why ("vps-1 couldn't start it (…); this turn runs on the server, until vps-1 can take it again."); the machine is tried again with the next message.
