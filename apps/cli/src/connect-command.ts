import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ConnectFile,
  PairResponse,
  RUNNER_CONNECT_PAIR_PATH,
  ServerAddress,
} from "@codeden/contracts";
import { runRunnerConnect } from "@codeden/runner/connect";
import { defaultRunnerLaunch, findOrStartRunner, homePaths } from "@codeden/server";
import {
  clearLinkPid,
  connectFilePath,
  connectLogPath,
  previousMachineFor,
  readConnectFile,
  runningLinkPid,
  writeConnectFile,
  writeLinkPid,
} from "./connect-file";

const USAGE = `Usage: codeden connect <server> --code <code>   Pair this computer, then link it
       codeden connect [--detach]                 Link again (as paired before)
       codeden connect --stop                     Stop the link running in the background`;

export interface ConnectOptions {
  /** `--home` already resolved (default `~/.codeden-runner`). */
  home: string;
  server?: string;
  code?: string;
  detach: boolean;
  stop: boolean;
}

const say = (message: string) => console.error(`codeden connect: ${message}`);

/**
 * `codeden connect` (`docs/machines-teams-and-agents.md` §D.5): link this computer to a CodeDen
 * server that can't reach it. With `--code` it first trades the pairing code from Settings ›
 * Machines for a device key, saved in `<home>/connect.json`. Then it starts the runner in its
 * home (detached, as machines over SSH have it) and links it to the server over a WebSocket,
 * linking again with backoff whenever the link drops, until stopped. `--detach` runs the link
 * in the background (`<home>/connect.pid`, log in `connect.log`); `--stop` ends it.
 */
export async function connectCommand(opts: ConnectOptions): Promise<number> {
  const { home } = opts;
  if (opts.stop) return stopLink(home);

  let saved = readConnectFile(home);
  if (opts.code) {
    if (!opts.server) {
      console.error(USAGE);
      return 2;
    }
    const server = ServerAddress.safeParse(opts.server);
    if (!server.success) {
      say(`${opts.server} isn't a server address (like https://codeden.example.com)`);
      return 2;
    }
    // A link already running here would keep using the old key.
    await stopLink(home, { quiet: true });
    const result = await pair(server.data, opts.code, previousMachineFor(saved, server.data));
    if ("error" in result) {
      say(result.error);
      return 1;
    }
    saved = {
      server: server.data,
      machineId: result.machineId,
      label: result.label,
      key: result.key,
      fake: result.fake,
      pairedAt: new Date().toISOString(),
    };
    writeConnectFile(home, saved);
    say(`paired with ${server.data} as ${result.label}`);
  } else if (!saved) {
    say(
      `this computer isn't paired yet (no ${connectFilePath(home)}). In CodeDen, open Settings › Machines › Connect this computer and run the command it shows`,
    );
    return 1;
  } else if (opts.server && ServerAddress.safeParse(opts.server).data !== saved.server) {
    say(
      `this computer is paired with ${saved.server}; to pair it with ${opts.server}, run the command from that server's Settings › Machines`,
    );
    return 1;
  }

  const running = runningLinkPid(home);
  if (running !== undefined) {
    say(`already linked to ${saved.server} (pid ${running}); stop it with codeden connect --stop`);
    return 1;
  }
  return opts.detach ? detach(home, saved) : link(home, saved);
}

/** Trade a pairing code for a device key. */
async function pair(
  server: string,
  code: string,
  previousMachineId: string | undefined,
): Promise<PairResponse | { error: string }> {
  let res: Response;
  try {
    res = await fetch(`${server}${RUNNER_CONNECT_PAIR_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, hostname: hostname(), previousMachineId }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { error: `can't reach ${server}: ${(error as Error).message}` };
  }
  const body = (await res.json().catch(() => undefined)) as
    | { error?: { message?: string } }
    | undefined;
  if (res.status !== 201) {
    return { error: body?.error?.message ?? `${server} answered HTTP ${res.status}` };
  }
  const parsed = PairResponse.safeParse(body);
  return parsed.success
    ? parsed.data
    : { error: `${server} sent an answer this CodeDen can't read` };
}

/** Link in the foreground until stopped, the key is refused, or the server is upgraded. */
async function link(home: string, saved: ConnectFile): Promise<number> {
  writeLinkPid(home, process.pid);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const launch = defaultRunnerLaunch(["--backend", "connected", ...(saved.fake ? ["--fake"] : [])]);
  if (!launch) {
    say("this copy of CodeDen has no runner to start");
    return 1;
  }
  say(`linking ${saved.label} to ${saved.server} (Ctrl+C to stop; agents keep running)`);
  try {
    const end = await runRunnerConnect({
      server: saved.server,
      key: saved.key,
      ensureRunner: () =>
        findOrStartRunner({
          home,
          lockFile: homePaths(home).runnerLock,
          launch,
          onStarting: () => say(`starting a runner in ${home}`),
          onSlow: () => say("the runner is taking a while to start"),
        }),
      log: say,
      signal: abort.signal,
    });
    if (end.kind === "revoked") {
      say(end.message);
      return 1;
    }
    if (end.kind === "outdated") {
      say(
        `${saved.server} now runs CodeDen ${end.serverVersion}. Link with that version: npx -y codeden@${end.serverVersion} connect`,
      );
      return 1;
    }
    say("stopped");
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    clearLinkPid(home, process.pid);
  }
}

/** Run the link as a background process of its own, which outlives this command. */
async function detach(home: string, saved: ConnectFile): Promise<number> {
  const entry = process.argv[1];
  if (!entry) {
    say("can't tell how this CodeDen was started, so it can't run in the background");
    return 1;
  }
  const log = openSync(connectLogPath(home), "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, entry, "connect", "--home", home], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (runningLinkPid(home) === child.pid) {
      say(
        `linking ${saved.label} to ${saved.server} in the background (pid ${child.pid}; log ${connectLogPath(home)}). Stop it with codeden connect --stop`,
      );
      return 0;
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  say(`the background link didn't start; see ${connectLogPath(home)}`);
  return 1;
}

/** End the link running in the background, if any. The runner keeps running. */
async function stopLink(home: string, opts: { quiet?: boolean } = {}): Promise<number> {
  const pid = runningLinkPid(home);
  if (pid === undefined) {
    if (!opts.quiet) say("no link is running here");
    return opts.quiet ? 0 : 1;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (runningLinkPid(home) === pid && Date.now() < deadline) await sleep(100);
  clearLinkPid(home, pid);
  if (!opts.quiet) say(`stopped the link (pid ${pid}); the runner and its agents keep running`);
  return 0;
}
