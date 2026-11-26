---
section: fixed
---

- **A pairing command only names this server.** `POST /api/machines/connect-codes` accepted any address for the `codeden connect` command it shows, so a crafted request could make the command send a computer (and its key) elsewhere; it now accepts only the server's own addresses. A connected agent asking for a code is refused with 403 before its request is read.
