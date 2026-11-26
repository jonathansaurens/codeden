import {
  PairRequest,
  type PairResponse,
  RUNNER_CONNECT_PAIR_PATH,
  RUNNER_CONNECT_PATH,
} from "@codeden/contracts";
import { upgradeWebSocket } from "@hono/node-server";
import type { Context, Hono } from "hono";
import type WebSocket from "ws";
import type { ComputerService } from "../execution/connected/computers";
import type { NetworkAccess } from "../network/access";
import { SignInLimiter } from "../network/rate-limit";
import { peerAddress, proxyClientOf } from "../security";
import { errorResponse } from "./validate";

/** How often the server pings a computer's link; one unanswered ping ends it. */
const PING_MS = 30_000;

/** The paths `codeden connect` uses: public, each authenticated by its own secret. */
export const RUNNER_CONNECT_PATHS = [RUNNER_CONNECT_PATH, RUNNER_CONNECT_PAIR_PATH] as const;

export interface RunnerConnectDeps {
  computers: () => ComputerService | undefined;
  network: NetworkAccess;
  log?: (message: string) => void;
}

/** The address failures are counted against: the proxy's report of its client, or the peer. */
function clientAddress(c: Context): { address: string; viaProxy: boolean } {
  const proxy = proxyClientOf(c);
  return proxy
    ? { address: `proxy:${proxy.address ?? "unknown"}`, viaProxy: true }
    : { address: peerAddress(c), viaProxy: false };
}

function bearerOf(c: Context): string | undefined {
  const auth = c.req.header("authorization");
  return auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
}

/**
 * `codeden connect`'s two endpoints (§D.5), mounted on the app before `/api` so they don't need
 * a member's sign-in (the security middleware still checks `Host` and `Origin`, and refuses
 * other devices while network access is off):
 * - `POST /api/runner-connect/pair` trades a single-use pairing code for a device key;
 * - `GET /api/runner-connect` upgrades to the computer's runner link, with
 *   `Authorization: Bearer <device key>`.
 * Bad codes and keys are throttled per address with the sign-in rules (§15.1), like bad agent
 * tokens, and written to the security log.
 */
export function mountRunnerConnect(app: Hono, deps: RunnerConnectDeps): void {
  const failures = new SignInLimiter();
  const refuse = (c: Context, status: 401 | 429 | 503, code: string, message: string) =>
    c.json({ error: { code, message } }, status);
  const gate = (c: Context) => {
    const { address } = clientAddress(c);
    const check = failures.check(address);
    if (check.allowed) return null;
    c.header("Retry-After", String(Math.ceil(check.retryAfterMs / 1000)));
    return refuse(
      c,
      429,
      "rate_limited",
      "Too many bad pairing codes or keys. Wait and try again.",
    );
  };
  const failed = (c: Context, why: string) => {
    const { address, viaProxy } = clientAddress(c);
    failures.fail(address);
    deps.network.recordFailedSignIn(address, why, viaProxy);
  };

  app.post(RUNNER_CONNECT_PAIR_PATH, async (c) => {
    const computers = deps.computers();
    if (!computers) return refuse(c, 503, "machines_unavailable", "Machines aren't available here");
    const throttled = gate(c);
    if (throttled) return throttled;
    const body = PairRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
      return c.json({ error: { code: "bad_request", message: "Send a pairing code" } }, 400);
    }
    try {
      const paired = computers.pair(body.data);
      if ("refused" in paired) {
        failed(c, "invalid pairing code");
        return refuse(c, 401, paired.refused.code, paired.refused.message);
      }
      failures.succeed(clientAddress(c).address);
      return c.json<PairResponse>(paired, 201);
    } catch (error) {
      return errorResponse(error, c, deps.log);
    }
  });

  app.get(RUNNER_CONNECT_PATH, async (c, next) => {
    const computers = deps.computers();
    if (!computers) return refuse(c, 503, "machines_unavailable", "Machines aren't available here");
    const throttled = gate(c);
    if (throttled) return throttled;
    const machineId = computers.authenticate(bearerOf(c));
    if (!machineId) {
      failed(c, "invalid device key");
      return refuse(
        c,
        401,
        "unauthorized",
        "This computer's key isn't valid any more (it was disconnected). Pair it again from Settings › Machines.",
      );
    }
    failures.succeed(clientAddress(c).address);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: { code: "bad_request", message: "Expected a WebSocket" } }, 426);
    }
    let timer: NodeJS.Timeout | undefined;
    let sink: ReturnType<ComputerService["arrive"]> | undefined;
    return upgradeWebSocket(() => ({
      onOpen: (_event, ws) => {
        sink = computers.arrive(machineId, {
          send: (text) => ws.send(text),
          close: (code, reason) => ws.close(code, reason),
        });
        // A computer that went to sleep never says goodbye: an unanswered ping ends its link.
        const raw = ws.raw as WebSocket | undefined;
        let alive = true;
        raw?.on("pong", () => {
          alive = true;
        });
        timer = setInterval(() => {
          if (!alive) return void raw?.terminate();
          alive = false;
          raw?.ping();
        }, PING_MS);
        timer.unref();
      },
      onMessage: (event) => {
        if (typeof event.data === "string") sink?.message(event.data);
      },
      onClose: (event) => {
        clearInterval(timer);
        sink?.closed(`the computer's link closed (${event.reason || `code ${event.code}`})`);
      },
      onError: () => {
        clearInterval(timer);
        sink?.closed("the computer's link failed");
      },
    }))(c, next);
  });
}
