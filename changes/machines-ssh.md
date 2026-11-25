---
section: added
---

- **Machines over SSH.** Run agent sessions on other computers you can SSH into: a VPS, a spare laptop, several of them. Add one in Settings › Machines or with `codeden machines add user@host`; CodeDen checks SSH, Node.js and the CodeDen version there first and says what to fix. Each machine runs one long-lived runner in `~/.codeden-runner` with its own provider sign-ins, reached over your own `ssh` with nothing listening on a port, and reconnects on its own. Choose a machine per project (Where sessions run), per session (Runs on, in New session) or from a PM (`start_session`'s `machine`). See `docs/machines.md`.
