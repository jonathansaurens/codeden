---
section: added
---

- **Open a server on a private network or VPN over plain http.** The desktop app's **Add server...** now also takes `http://` with a private or VPN IP address (`10.x`, `172.16-31.x`, `192.168.x`, `100.64-127.x`, `fd00::/8`), for example a ZeroTier or Tailscale address with no certificate. The form says the connection isn't encrypted; host names and public addresses still need `https://`. After a restart, notifications and dictation work in that server's window. See [Other CodeDen servers](docs/desktop.md#other-codeden-servers).
