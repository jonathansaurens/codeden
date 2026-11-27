import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PairResponse, RUNNER_CONNECT_PAIR_PATH } from "@codeden/contracts";
import { type RunnerConnectEnd, runRunnerConnect } from "@codeden/runner/connect";
import { homePaths } from "../../src/paths";
import { defaultRunnerLaunch } from "../../src/runner/launcher";
import { isProcessAlive } from "../../src/runner/lock";
import { findOrStartRunner } from "../../src/runner/transport-loopback";
import { waitUntil } from "./harness";

/**
 * A person's own computer for tests (§D.5): a runner home on this computer, a real runner
 * process started there with the Fake provider (`--backend connected`), and `codeden connect`'s
 * link run in this process, so the server sees a computer linking in over its WebSocket.
 */
export interface FakeComputer {
  /** The runner's home (`~/.codeden-runner` on a real computer). */
  home: string;
  /** Trade a pairing code for a device key, as `codeden connect --code` does. */
  pair(server: string, code: string, extra?: Record<string, unknown>): Promise<Response>;
  /** Start linking with `key` (retries fast); `ended` settles when the link loop returns. */
  connect(server: string, key: string): void;
  ended(): Promise<RunnerConnectEnd>;
  /** Whether a link to the server is up now. */
  linked(): boolean;
  /** Cut the link the way a lost network would (the loop links again). */
  drop(): void;
  /** Stop linking. */
  stop(): Promise<void>;
  runnerPid(): number | undefined;
  stopRunner(): Promise<void>;
}

export function fakeComputer(base: string): FakeComputer {
  const home = join(base, "computer-runner");
  mkdirSync(home, { recursive: true });
  const lockFile = homePaths(home).runnerLock;
  const launch = defaultRunnerLaunch(["--backend", "connected", "--fake"]) ?? null;
  let abort: AbortController | undefined;
  let loop: Promise<RunnerConnectEnd> | undefined;
  let link: { drop(): void } | null = null;
  const runnerPid = () => {
    try {
      const pid = (JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number }).pid;
      return isProcessAlive(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    home,
    pair: (server, code, extra = {}) =>
      fetch(`${server}${RUNNER_CONNECT_PAIR_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, hostname: "Laptop-1.local", ...extra }),
      }),
    connect(server, key) {
      abort = new AbortController();
      loop = runRunnerConnect({
        server,
        key,
        ensureRunner: () =>
          findOrStartRunner({ home, lockFile, launch, onStarting() {}, onSlow() {} }),
        log: () => undefined,
        signal: abort.signal,
        retry: { firstMs: 50, maxMs: 500 },
        onLinked: (l) => {
          link = l;
        },
      });
    },
    ended: () => loop ?? Promise.resolve({ kind: "stopped" }),
    linked: () => link !== null,
    drop: () => link?.drop(),
    async stop() {
      abort?.abort();
      await loop;
    },
    runnerPid,
    async stopRunner() {
      const pid = runnerPid();
      if (pid === undefined) return;
      process.kill(pid, "SIGTERM");
      await waitUntil(() => !isProcessAlive(pid));
    },
  };
}

/** A pair answer, parsed. */
export async function paired(res: Response): Promise<PairResponse> {
  if (res.status !== 201) throw new Error(`pair failed: ${res.status} ${await res.text()}`);
  return PairResponse.parse(await res.json());
}
