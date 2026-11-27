import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "../../src/runner/lock";
import { waitUntil } from "./harness";

/** This checkout's CLI entry, run from source on the "machine". */
const CLI = resolve(fileURLToPath(new URL("../../../cli/src/cli.ts", import.meta.url)));
const TSX = import.meta.resolve("tsx");

/** A machine that is this computer: `ssh` runs the remote command here, under its own home. */
export interface FakeMachine {
  /** The `ssh` to give the server (`machines.sshCommand`). */
  ssh: string;
  /** The command the machine runs CodeDen with: this checkout's CLI from source. */
  command: string;
  /** The machine's `$HOME`; its runner lives in `<home>/.codeden-runner`. */
  home: string;
  /** The machine runner's home. */
  runnerHome: string;
  /** Every remote command `ssh` was asked to run, oldest first. */
  commands(): string[];
  /** The pid of the machine's runner, when one is alive. */
  runnerPid(): number | undefined;
  /** Stop the machine's runner, as a reboot would. */
  stopRunner(): Promise<void>;
  /** Make `ssh` fail to connect, as for a machine that is off, or connect again. */
  setReachable(reachable: boolean): void;
}

/**
 * A fake `ssh` for tests: a shell script that ignores the destination and runs the remote
 * command locally with `sh -c`, under a temp `$HOME` and a PATH with only `node` and the system
 * tools, as a machine's non-interactive shell would. Each call is logged. It execs all the way
 * down, so the link's pid is the `runner-link` process itself and killing it drops the link.
 */
export function fakeMachine(base: string): FakeMachine {
  const home = join(base, "machine-home");
  const bin = join(base, "machine-bin");
  const log = join(base, "ssh.log");
  const offline = join(base, "machine-offline");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  const ssh = join(base, "fake-ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh
# Skip ssh's options up to "--", then the destination; the rest is the remote command.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -o) shift 2 ;;
    *) shift ;;
  esac
done
shift
if [ -e '${offline}' ]; then
  echo "ssh: connect to host vps-1 port 22: Connection refused" >&2
  exit 255
fi
printf '%s\\n' "$*" >> '${log}'
cd '${home}'
HOME='${home}' PATH='${bin}:/usr/bin:/bin' exec sh -c "$*"
`,
  );
  chmodSync(ssh, 0o755);
  const runnerHome = join(home, ".codeden-runner");
  const lockFile = join(runnerHome, "runner", "runner.json");
  const runnerPid = () => {
    try {
      const pid = (JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number }).pid;
      return isProcessAlive(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    ssh,
    command: `node --import ${TSX} ${CLI}`,
    home,
    runnerHome,
    commands: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    runnerPid,
    setReachable: (reachable) => {
      if (reachable) rmSync(offline, { force: true });
      else writeFileSync(offline, "");
    },
    stopRunner: async () => {
      const pid = runnerPid();
      if (pid === undefined) return;
      process.kill(pid, "SIGTERM");
      await waitUntil(() => !isProcessAlive(pid));
    },
  };
}
