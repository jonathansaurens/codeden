import {
  MACHINE_MIN_NODE_MAJOR,
  MACHINE_RUNNER_HOME,
  type MachineCheckCode,
} from "@codeden/contracts";

/**
 * Argument lists for every `ssh` command the machines backend runs, the commands it runs on a
 * machine, and parsers for what comes back (`docs/machines-teams-and-agents.md` §A.2, §A.3).
 * Pure, so they are tested without SSH. Nothing secret goes into them: CodeDen stores no SSH
 * keys or passwords, and the GitHub token reaches a machine only inside a runner command over
 * the link (`docs/remote-runners.md` §9.2).
 */

/**
 * Options every `ssh` run gets. `BatchMode` makes `ssh` fail instead of prompting for a
 * password or a host key, so nothing ever waits on a terminal that isn't there; keys, agents,
 * jump hosts and `ProxyCommand` from the user's own config work as in a terminal. The keepalives
 * end a link whose network went away within about 45 s, so the client reconnects.
 */
export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-T",
];

/** The default command prefix on a machine: `npx -y codeden@<server version>`. */
export function pinnedCommand(version: string): string {
  return `npx -y codeden@${version}`;
}

/**
 * `ssh <options> -- <destination> <remote command>`. The `--` keeps a destination from ever
 * being read as an option. `ssh` hands the command to the machine's login shell as one string.
 */
export function sshArgs(destination: string, remote: string): string[] {
  return [...SSH_OPTIONS, "--", destination, remote];
}

/** The runner home on the machine, as a shell word that expands `~`. */
const HOME_ARGS = `--home ${MACHINE_RUNNER_HOME}`;

/** `node --version` on the machine. */
export function nodeVersionCommand(): string {
  return "node --version";
}

/** `<prefix> --version`: the CodeDen the machine runs, which fetches it the first time. */
export function codedenVersionCommand(prefix: string): string {
  return `${prefix} --version`;
}

/**
 * Start the machine's runner detached in its home unless one is alive there; it outlives the
 * link and the server. Its output goes to stderr, so a link's stdout stays frames only.
 */
export function detachCommand(prefix: string, opts: { fake?: boolean } = {}): string {
  const fake = opts.fake ? " --fake" : "";
  return `${prefix} runner ${HOME_ARGS} --detach --backend ssh${fake} 1>&2`;
}

/**
 * What every link runs: start the runner if it isn't running (a reboot, an upgrade that drained
 * the old one), then splice stdin and stdout to it (`codeden runner-link`).
 */
export function linkCommand(prefix: string, opts: { fake?: boolean } = {}): string {
  return `${detachCommand(prefix, opts)} && exec ${prefix} runner-link ${HOME_ARGS}`;
}

/** A label for a destination: its host part (`dev@vps-1.example.com` → `vps-1`). */
export function defaultLabel(destination: string): string {
  const withoutScheme = destination.replace(/^ssh:\/\//, "");
  const host = withoutScheme.split("@").pop() ?? withoutScheme;
  const name = host.split(":")[0]?.split(".")[0] ?? host;
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const label = cleaned.slice(0, 40) || "machine";
  return ["home", "auto"].includes(label.toLowerCase()) ? `${label}-1` : label;
}

/** What a failed check run tells: its code, a message and what to do about it. */
export interface CheckFailure {
  code: MachineCheckCode;
  message: string;
}

/** What a check needs from an `ssh` run. */
export interface SshRun {
  notFound: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The last non-empty line of `ssh`'s error output, where it says what went wrong. */
export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  return lines.filter(Boolean).pop() ?? "";
}

/**
 * Why `ssh` itself failed (exit 255, or not found), with the fix, or null when the remote
 * command ran and failed on its own.
 */
export function sshFailure(run: SshRun, destination: string): CheckFailure | null {
  if (run.notFound) {
    return {
      code: "ssh_failed",
      message: "No ssh command on this computer. Install OpenSSH, then try again",
    };
  }
  if (run.timedOut) {
    return {
      code: "ssh_unreachable",
      message: `${destination} did not answer in time. Check that it is on and reachable (try ssh ${destination} in a terminal)`,
    };
  }
  if (run.code !== 255) return null;
  const err = run.stderr;
  if (/host key verification failed|remote host identification has changed/i.test(err)) {
    return {
      code: "ssh_host_key",
      message: `${destination}'s host key isn't trusted yet. Run ssh ${destination} once in a terminal and accept it, then try again`,
    };
  }
  if (/permission denied|too many authentication failures|no supported authentication/i.test(err)) {
    return {
      code: "ssh_auth",
      message: `CodeDen couldn't sign in to ${destination} without a password. Add your SSH key there (ssh-copy-id ${destination}) or load it into your SSH agent, then try again`,
    };
  }
  if (
    /could not resolve hostname|name or service not known|nodename nor servname|connection refused|connection timed out|operation timed out|no route to host|network is unreachable/i.test(
      err,
    )
  ) {
    return {
      code: "ssh_unreachable",
      message: `${destination} can't be reached: ${lastLine(err)}`,
    };
  }
  return {
    code: "ssh_failed",
    message: `ssh ${destination} failed: ${lastLine(err) || "no output"}`,
  };
}

/** Node.js's major version from `node --version` ("v24.1.0" → 24); null when unreadable. */
export function parseNodeMajor(stdout: string): number | null {
  const match = /v?(\d+)\.\d+\.\d+/.exec(stdout.trim());
  return match ? Number(match[1]) : null;
}

/** Read `ssh <dest> node --version`: null when Node.js is new enough, else what to fix. */
export function checkNode(run: SshRun, destination: string, label: string): CheckFailure | null {
  const ssh = sshFailure(run, destination);
  if (ssh) return ssh;
  const major = run.code === 0 ? parseNodeMajor(run.stdout) : null;
  if (major === null) {
    return {
      code: "node_missing",
      message: `Node.js ${MACHINE_MIN_NODE_MAJOR} or newer is needed on ${label}, and ssh ${destination} found no node. Install it, and make sure it is on the PATH of non-interactive shells`,
    };
  }
  if (major < MACHINE_MIN_NODE_MAJOR) {
    return {
      code: "node_too_old",
      message: `Node.js ${MACHINE_MIN_NODE_MAJOR} or newer is needed on ${label}; found ${run.stdout.trim().replace(/^v/, "")}`,
    };
  }
  return null;
}

/** Read `ssh <dest> <prefix> --version`: null when it runs this version, else what to fix. */
export function checkCodeden(
  run: SshRun,
  destination: string,
  label: string,
  version: string,
  prefix: string,
): CheckFailure | null {
  const ssh = sshFailure(run, destination);
  if (ssh) return ssh;
  if (run.code !== 0) {
    return {
      code: "codeden_failed",
      message: `${prefix} didn't run on ${label}: ${lastLine(run.stderr) || `exit ${run.code}`}`,
    };
  }
  const found = run.stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (found !== version) {
    return {
      code: "codeden_failed",
      message: `${label} runs CodeDen ${found || "(no version)"} through ${prefix}; this server is ${version}`,
    };
  }
  return null;
}
