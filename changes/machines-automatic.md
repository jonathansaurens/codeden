---
section: added
---

- **Automatic placement on machines.** Set a project's sessions, one new session or a PM's `start_session` to Automatic, and CodeDen runs each new session on Home or the machine with the most free capacity: preference × cores × free CPU share × free memory share, where each machine (and Home) is Prefer, Normal, Less often or Manual only. Busy machines (CPU 95% or more, free memory 5% or less) and ones without the session's provider signed in are skipped. When none qualifies, New session says why and offers Home; a session the PM or an automation starts runs on Home with a note in its header. Capacity on Linux honours a container's cgroup limits.
