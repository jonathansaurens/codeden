import { setTimeout as delay } from "node:timers/promises";
import {
  CODEDEN_VERSION,
  RUNNER_CONNECT_PATH,
  RunnerConnectClose,
  type RunnerLock,
} from "@codeden/contracts";
import WebSocket from "ws";

export interface RunnerConnectOptions {
  /** The server's address, `http(s)://host[:port]`. */
  server: string;
  /** This computer's device key. */
  key: string;
  /** Make sure the runner runs (starting it when none is alive) and return its lock. */
  ensureRunner: () => Promise<RunnerLock>;
  log: (message: string) => void;
  /** Ends the link and the retries. */
  signal?: AbortSignal;
  /** Waits between attempts: the first, doubled after each failure up to `maxMs`. */
  retry?: { firstMs: number; maxMs: number };
  /** How often the link to the server is pinged; one unanswered ping ends it (sleep, a dead network). */
  pingMs?: number;
  /**
   * A link to the server is up (with `drop`, which cuts it the way a lost network would), or
   * ended (null).
   */
  onLinked?: (link: { drop(): void } | null) => void;
}

/** Why `runRunnerConnect` returned. */
export type RunnerConnectEnd =
  | { kind: "stopped" }
  /** The server no longer accepts this computer's key (it was disconnected). */
  | { kind: "revoked"; message: string }
  /** The server runs another CodeDen version: run that version's `codeden connect`. */
  | { kind: "outdated"; serverVersion: string };

/** How one link ended. */
type LinkEnd =
  | { kind: "closed"; linked: boolean; why: string }
  | { kind: "revoked"; message: string };

const DEFAULT_RETRY = { firstMs: 1_000, maxMs: 30_000 };
const PING_MS = 20_000;
const HANDSHAKE_MS = 15_000;
const REVOKED =
  "The server no longer accepts this computer (it was disconnected). Pair it again from Settings › Machines";

/** `ws(s)://host[:port]/api/runner-connect` for an `http(s)` server address. */
export function runnerConnectUrl(server: string): string {
  const url = new URL(RUNNER_CONNECT_PATH, server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * `codeden connect`'s link (`docs/machines-teams-and-agents.md` §D.5): this computer's runner
 * linked out to a server that can't reach it. Each attempt makes sure the runner runs, connects
 * to its loopback WebSocket with the lock's token and to the server's `/api/runner-connect`
 * with the device key, and splices the two, message for message: the runner protocol crosses
 * unchanged, and the server resumes the journal by `seq` after every new link. A link that ends
 * (sleep, a network change, a server restart) is made again with backoff, until `signal` aborts
 * or the server refuses the key. Logs never contain the key or the runner's token.
 */
export async function runRunnerConnect(opts: RunnerConnectOptions): Promise<RunnerConnectEnd> {
  const retry = opts.retry ?? DEFAULT_RETRY;
  const signal = opts.signal ?? new AbortController().signal;
  let wait = retry.firstMs;
  while (!signal.aborted) {
    const outdated = await serverVersion(opts.server, signal);
    if (outdated) return { kind: "outdated", serverVersion: outdated };
    let end: LinkEnd;
    try {
      const lock = await opts.ensureRunner();
      end = await linkOnce(opts, lock, signal);
    } catch (error) {
      end = { kind: "closed", linked: false, why: (error as Error).message };
    }
    if (end.kind === "revoked") return end;
    if (signal.aborted) break;
    // A link that worked starts the waits over; failures back off.
    wait = end.linked ? retry.firstMs : Math.min(wait * 2, retry.maxMs);
    opts.log(`${end.why}; linking again in ${Math.round(wait / 100) / 10} s`);
    await delay(wait, undefined, { signal }).catch(() => undefined);
  }
  return { kind: "stopped" };
}

/**
 * The server's CodeDen version when it differs from this one (a server upgrade: this copy would
 * start a runner it refuses); null when it matches or can't be told (then the link is tried).
 */
async function serverVersion(server: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(new URL("/api/health", server), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version !== CODEDEN_VERSION
      ? body.version
      : null;
  } catch {
    return null;
  }
}

/** An open socket whose text messages are kept from the start until they are forwarded. */
interface Opened {
  ws: WebSocket;
  /** Send every text message, those that came already first, to `to`. */
  forward(to: (text: string) => void): void;
}

/**
 * Open a socket; resolves once open, rejects with why it couldn't (`revoked` on a 401). Its
 * messages are caught from the first one: the server sends `hello` the moment it adopts the
 * link, which can arrive before this resolves.
 */
function open(
  url: string,
  headers: Record<string, string>,
  what: string,
  signal: AbortSignal,
): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: HANDSHAKE_MS });
    let queue: string[] | null = [];
    let sink: ((text: string) => void) | null = null;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (sink) sink(text);
      else queue?.push(text);
    });
    const forward = (to: (text: string) => void) => {
      for (const text of queue ?? []) to(text);
      queue = null;
      sink = to;
    };
    const fail = (error: Error) => {
      signal.removeEventListener("abort", onAbort);
      ws.terminate();
      reject(error);
    };
    const onAbort = () => fail(new Error("stopped"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    ws.on("error", (error) => fail(new Error(`${what} failed: ${error.message}`)));
    ws.once("unexpected-response", (req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      req.destroy();
      fail(status === 401 ? new RevokedError() : new Error(`${what} answered HTTP ${status}`));
    });
    ws.once("open", () => {
      signal.removeEventListener("abort", onAbort);
      ws.removeAllListeners("error");
      // Kept until the splice adds its own: an `error` without a listener would throw.
      ws.on("error", () => undefined);
      resolve({ ws, forward });
    });
  });
}

class RevokedError extends Error {
  constructor() {
    super(REVOKED);
  }
}

/** One link: the runner's socket and the server's, spliced until either ends. */
async function linkOnce(
  opts: RunnerConnectOptions,
  lock: RunnerLock,
  signal: AbortSignal,
): Promise<LinkEnd> {
  // The runner first: the server sends `hello` as soon as it adopts the link.
  const toRunner = await open(
    `ws://127.0.0.1:${lock.port}/runner`,
    { authorization: `Bearer ${lock.token}` },
    `Connecting to the runner on 127.0.0.1:${lock.port}`,
    signal,
  );
  const runner = toRunner.ws;
  let toServer: Opened;
  try {
    toServer = await open(
      runnerConnectUrl(opts.server),
      { authorization: `Bearer ${opts.key}` },
      `Connecting to ${opts.server}`,
      signal,
    );
  } catch (error) {
    runner.terminate();
    if (error instanceof RevokedError) return { kind: "revoked", message: error.message };
    return { kind: "closed", linked: false, why: (error as Error).message };
  }
  const server = toServer.ws;
  opts.log(`linked to ${opts.server} (runner pid ${lock.pid})`);
  return new Promise<LinkEnd>((resolve) => {
    let done = false;
    let alive = true;
    const finish = (end: LinkEnd) => {
      if (done) return;
      done = true;
      clearInterval(ping);
      signal.removeEventListener("abort", onAbort);
      // Ending one ends the other: the runner sees the server go and keeps its journal.
      runner.terminate();
      server.terminate();
      opts.onLinked?.(null);
      resolve(end);
    };
    const onAbort = () => {
      server.close(1000, "computer disconnecting");
      finish({ kind: "closed", linked: true, why: "stopped" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    opts.onLinked?.({ drop: () => server.terminate() });
    if (runner.readyState !== WebSocket.OPEN) {
      queueMicrotask(() => finish({ kind: "closed", linked: false, why: "the runner went away" }));
    }
    const ping = setInterval(() => {
      if (!alive) {
        finish({ kind: "closed", linked: true, why: "the server stopped answering" });
        return;
      }
      alive = false;
      server.ping();
    }, opts.pingMs ?? PING_MS);
    ping.unref();
    server.on("pong", () => {
      alive = true;
    });
    toServer.forward((text) => {
      if (runner.readyState === WebSocket.OPEN) runner.send(text);
    });
    toRunner.forward((text) => {
      if (server.readyState === WebSocket.OPEN) server.send(text);
    });
    server.on("close", (code, reason) => {
      if (code === RunnerConnectClose.revoked) {
        return finish({ kind: "revoked", message: REVOKED });
      }
      const why = reason.toString() || `code ${code}`;
      finish({ kind: "closed", linked: true, why: `the server closed the link (${why})` });
    });
    runner.on("close", (code, reason) => {
      const why = reason.toString() || `code ${code}`;
      finish({ kind: "closed", linked: true, why: `the runner closed the link (${why})` });
    });
    server.on("error", (error) =>
      finish({
        kind: "closed",
        linked: true,
        why: `the link to the server failed: ${error.message}`,
      }),
    );
    runner.on("error", (error) =>
      finish({
        kind: "closed",
        linked: true,
        why: `the link to the runner failed: ${error.message}`,
      }),
    );
  });
}
