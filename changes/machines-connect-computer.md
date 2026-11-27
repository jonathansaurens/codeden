---
section: added
---

- **Connect your own computer.** Settings › Machines › Connect this computer shows a command with a single-use pairing code (`npx -y codeden@<version> connect <server> --code <code>`). Run it on your laptop and it becomes one of the machines, linked out to the server over a WebSocket, so it works behind NAT, through sleep and network changes, with its own provider sign-ins. Only you can run sessions there (pick it in Runs on); Automatic never chooses it. Disconnect it from Settings › Machines, which revokes its key. `codeden connect --detach` keeps the link running in the background and `codeden connect --stop` ends it.
