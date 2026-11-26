---
section: security
---

- **Signing in can't reset the throttle on guesses.** A successful sign-in cleared every failure from that address, so a member could guess at someone else's passphrase and sign in as themselves in between. A success now forgives only that device's failures for the same member; failed invite secrets and agent tokens only age out.
