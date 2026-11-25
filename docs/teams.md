# Teams: sharing a CodeDen server

One CodeDen server can be shared by several people. Each person is a **member** with their own display name and passphrase, and a **role** that decides what they can see and do. Connected agents (other agents that use CodeDen over MCP) are members too; see [Connected agents](connected-agents.md).

A single-user install needs none of this: you are the first owner, and nothing changes until you invite someone.

## Host it on a VPS

A team server is usually a small Linux machine that is always on. CodeDen runs there headless, and people reach it over HTTPS through a reverse proxy on that same machine.

1. Install Node.js 24 and CodeDen on the server, then start it without a browser:

   ```sh
   npx codeden --no-open
   ```

   Run it under a service manager (systemd, a `tmux` session to start with) so it survives logouts and restarts. The data folder is `~/.codeden` of the user it runs as.
2. Set your own passphrase. It is the network access password, and you are the **first owner**:

   ```sh
   npx codeden password            # or: npx codeden password --generate
   ```

3. Put HTTPS in front of it on the same machine, and tell CodeDen the address to trust:
   - **Tailscale Serve** (a private tailnet): `tailscale serve --bg --https=8445 http://127.0.0.1:4317`, then `npx codeden network origin add https://<machine>.<tailnet>.ts.net:8445`.
   - **Caddy** (a public name you own): a site block such as

     ```
     codeden.example.com {
       reverse_proxy 127.0.0.1:4317
     }
     ```

     then `npx codeden network origin add https://codeden.example.com`.
4. Turn network access on and keep CodeDen itself on `127.0.0.1`, so the proxy is the only way in:

   ```sh
   npx codeden network on --loopback-only
   ```

Open the HTTPS address, sign in with your passphrase (leave **Name** empty, or type your own name), and you are in as the owner. The machine's own browser and the desktop app keep using the install token, which also acts as the first owner.

The server can run sessions itself, as on a laptop: sign in to the agent CLIs (`claude`, `codex`, …) on the server as the user CodeDen runs as. See [Phones, tablets and network access](remote-access.md) for the details of network access, and [Security](security.md#members-and-roles) for the rules.

## Invite someone

**Settings › Members › Invite someone**:

1. Pick their **role everywhere**, and optionally a different role on some projects.
2. Optionally add a note for yourself (who it's for).
3. **Create link** and send the link privately. It is shown only once.

The link (`https://<your server>/join#cdi_…`) works **once, for 7 days**. The person opens it, picks a display name and a passphrase (at least 15 characters; the same rules as the network access password), and is signed in on that device. On other devices they sign in with their name and passphrase.

Open invites are listed under **Open invites** with **Revoke**. A used, revoked or expired link answers "This invite link doesn't work any more", and guessing at links is throttled like wrong passwords.

## Roles

| Role | Can |
|---|---|
| **Viewer** | See everything live: projects, the orchestrator, PM and agent transcripts, diffs, files, terminals (read-only: watch a terminal that is open, never type), the inbox, usage and the factory |
| **Operator** | Viewer, plus act on work: message the orchestrator, PMs and sessions; start, stop and archive sessions; answer questions and approvals; comment on diffs; run automations; commit, push and open PRs from a session |
| **Owner** | Operator, plus administer: settings, projects, automations, machines, members and invites, secrets and provider logins, network access |

- **Per-project roles.** A member's role can be raised or lowered for a project: for example Viewer everywhere and Operator on `helpdesk-ai`. Pick **No access** for a project to hide it: it doesn't appear in their lists, and its pages and sessions answer "not found".
- **Work across projects** (the orchestrator, usage reports, the factory overview, bulk inbox changes) needs the role on *every* project, so a member with a hidden project can't learn about it through the orchestrator.
- **The server decides.** Every HTTP route, live update, terminal and member tool checks the role on the server; the UI only hides what the server would refuse. A refused action says which role it needs.
- **The first owner** always stays an enabled owner, and can't be deleted. Other owners can be invited.

## Manage members

**Settings › Members** lists everyone, the first owner first:

- **Role** and **Projects** change their roles; changes apply at once, also to the devices they are signed in on.
- **Enabled** switches a member off without deleting them: their devices and tokens are refused until you switch them on again.
- **Delete** removes the member and signs out their devices.
- Each person's **signed-in devices** are listed with **Sign out**.
- **Recent activity** lists what people and connected agents did lately: settings changes, sessions started and stopped, answers and more.

## Working together

- **Who did what.** On a server with more than one member, messages show who sent them, approvals and questions show who answered, and a stopped session shows who stopped it.
- **Who is here.** A session's header shows avatars of the other members looking at it now.
- **The first answer wins.** When two people answer the same question or approval, the first answer is used and the second is told who answered.

## Passphrases

Your passphrase is yours alone. The first owner's passphrase is the network access password (`codeden password` on the server; changing it signs out the owner's devices only). If someone forgets theirs, delete them and invite them again.
