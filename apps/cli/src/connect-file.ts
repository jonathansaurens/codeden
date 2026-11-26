import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ConnectFile } from "@codeden/contracts";

/**
 * What `codeden connect` keeps in its runner home (`docs/machines-teams-and-agents.md` §D.5):
 * `connect.json` (the server, the machine it was paired as and its device key; mode 0600) and
 * `connect.pid` (the link running now, so a second one isn't started and `--stop` finds it).
 */

/** `codeden connect`'s home: `--home`, else `~/.codeden-runner`, the runner home machines use. */
export function connectHome(home: string | undefined): string {
  return home ? resolve(home) : join(homedir(), ".codeden-runner");
}

export const connectFilePath = (home: string) => join(home, "connect.json");
export const connectPidPath = (home: string) => join(home, "connect.pid");
export const connectLogPath = (home: string) => join(home, "connect.log");

/** The pairing saved in `home`, or null when there is none (or it can't be read). */
export function readConnectFile(home: string): ConnectFile | null {
  try {
    const parsed = ConnectFile.safeParse(JSON.parse(readFileSync(connectFilePath(home), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Save the pairing, readable by this user only: it holds the device key. */
export function writeConnectFile(home: string, file: ConnectFile): void {
  mkdirSync(home, { recursive: true });
  const path = connectFilePath(home);
  writeFileSync(path, `${JSON.stringify(ConnectFile.parse(file), null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only to a new file: an existing one is tightened too.
  chmodSync(path, 0o600);
}

/**
 * The machine to pair as again: the saved one, when it was paired with the same server (the
 * server keeps it only if it is the same person's computer).
 */
export function previousMachineFor(saved: ConnectFile | null, server: string): string | undefined {
  return saved && saved.server === server ? saved.machineId : undefined;
}

/** The pid of the link running from `home`, when it is alive. */
export function runningLinkPid(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(connectPidPath(home), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

export function writeLinkPid(home: string, pid: number): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(connectPidPath(home), `${pid}\n`, { mode: 0o600 });
}

/** Remove the pid file, if it is `pid`'s. */
export function clearLinkPid(home: string, pid: number): void {
  try {
    if (Number(readFileSync(connectPidPath(home), "utf8").trim()) === pid) {
      rmSync(connectPidPath(home), { force: true });
    }
  } catch {
    // Already gone.
  }
}
