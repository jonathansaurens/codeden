# Using one Mac's CodeDen from another

This guide sets up a Mac you work from (the **client**) to open the CodeDen running on another
Mac (the **host**) in its browser. Your sessions, agents and files all stay on the host. The
connection is an SSH tunnel over a private network, here ZeroTier. CodeDen itself stays bound to
`127.0.0.1` on the host, so nothing new listens on the network apart from SSH.

```
client browser → localhost:4317 → SSH (over ZeroTier) → host 127.0.0.1:4317 (CodeDen)
```

Agents: work through the steps in order and run each check before you move on. Some steps can
only be done by the owner, and they're marked **Owner**: ask for them, don't work around them.
Never write the hosts' addresses, usernames or network IDs into this repository (it's public);
they belong in `~/.ssh/config` on the client. Never copy a private key (`~/.ssh/id_*` without
`.pub`) between machines. Only public keys move.

## On the host (the Mac running CodeDen)

1. **CodeDen is running.** Check: `lsof -nP -iTCP:4317 -sTCP:LISTEN` lists it, and
   `~/.codeden/install-token` exists.
2. **Owner: turn on Remote Login.** System Settings › General › Sharing › Remote Login, for the
   owner's account only. Check: `nc -z 127.0.0.1 22` succeeds.
3. **Join the private network.** Install ZeroTier and `zerotier-cli join <network id>`.
   **Owner:** authorize the new member at my.zerotier.com › the network › Members. Check:
   `zerotier-cli listnetworks` says `OK` and shows the host's address (for example `10.x.y.z`).
4. **Keep it awake.** It must be awake for the client to reach it. On a laptop, on power:
   System Settings › Battery › Options › "Prevent automatic sleeping on power adapter when the
   display is off".
5. **Add the client's public key** (from the client, step 1 below) to `~/.ssh/authorized_keys`.
   Add it on a line of its own, and don't replace keys that are already there:
   ```sh
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   echo '<the client'"'"'s ssh-ed25519 … line>' >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ssh-keygen -lf ~/.ssh/authorized_keys   # every line must parse
   ```
6. **Give the client the host key fingerprint**, so it can tell it's talking to the right Mac:
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
7. **Keys only, after the client's key login works (client step 4).** Turn off password logins
   over SSH. Keep an SSH session open while you do this, as a way back in. It needs `sudo`, so
   **Owner:** enter the password. sshd uses the first value it reads, and macOS reads
   `/etc/ssh/sshd_config.d/*` in name order before the rest, so the file name starts with `010`:
   ```sh
   printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' |
     sudo tee /etc/ssh/sshd_config.d/010-keys-only.conf
   sudo sshd -t && echo config ok
   ```
   macOS starts sshd fresh for each connection, so the change applies to the next login.
   Check from the client: `ssh -o PubkeyAuthentication=no mbp` must be refused, and
   `ssh mbp echo ok` must still work. To undo it, delete the file.

## On the client (the Mac you work from)

1. **Make a key, if it doesn't have one**, and give the public half to the host (host step 5):
   ```sh
   [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
   cat ~/.ssh/id_ed25519.pub
   ```
2. **Join the same private network.** `zerotier-cli join <network id>`, then **Owner:**
   authorize it. Check: `ping -c 2 <host address>` gets replies.
3. **Name the host in `~/.ssh/config`.** `mbp` is the name `codeden-remote` uses by default:
   ```
   Host mbp
     HostName <host's ZeroTier address>
     User <owner's username on the host>
     IdentityFile ~/.ssh/id_ed25519
   ```
4. **Log in once.** `ssh mbp echo ok`. Accept the host key only if its fingerprint matches host
   step 6. It must print `ok` without asking for a password. Then do host step 7.
5. **Install `codeden-remote`:**
   ```sh
   mkdir -p ~/bin
   curl -fsSL https://raw.githubusercontent.com/jonathansaurens/codeden/fork/scripts/fork/codeden-remote -o ~/bin/codeden-remote
   chmod +x ~/bin/codeden-remote
   grep -q 'HOME/bin' ~/.zshrc || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
   ```
6. **Launch.** Quit CodeDen or CodeDen Fork on the client first, because it uses the same port.
   ```sh
   codeden-remote          # open the tunnel and the host's CodeDen, signed in
   codeden-remote stop     # close the tunnel
   codeden-remote <name>   # a host other than mbp, by its ~/.ssh/config name
   ```

## When it doesn't work

| Symptom | Cause |
|---|---|
| `ssh` hangs, then times out | The host is asleep or offline, or one side isn't authorized in ZeroTier (`zerotier-cli listnetworks`). |
| `Connection refused` | Remote Login is off on the host. |
| `Permission denied (publickey)` | The client's key isn't in the host's `authorized_keys`, `User` is wrong, or the host's `~/.ssh` permissions are too open (700 for the folder, 600 for the file). |
| `Port 4317 is in use here` | CodeDen is running on the client. Quit it. |
| `Couldn't read CodeDen's install token` | CodeDen has never started on the host. Start it there once. |
| The page opens but asks to sign in | The tunnel isn't on port 4317, or another tunnel is open. Run `codeden-remote stop`, then try again. |
