---
section: added
---

- **One clone per project on each machine.** A machine keeps a single clone of each project, fetched from GitHub before every new session, and gives each session its own worktree of it, so starting a session on a large repository no longer clones it again. Archiving a session removes its worktree, and removing the machine checks the clone for unpushed branches first.
