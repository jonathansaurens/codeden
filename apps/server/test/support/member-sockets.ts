import WebSocket from "ws";
import { type Credential, type MembersEnv, TEAM_HOST } from "./members-env";

/** A WebSocket opened as a remote device or agent, with its upgrade's status. */
export interface MemberSocket {
  /** 101 when it opened, else the HTTP status of the refusal. */
  status: number;
  ws: WebSocket;
  /** Settles when the socket closes. */
  closed: Promise<void>;
}

/** The headers a remote device (or agent) sends through the proxy. */
function headersOf(as: Credential): Record<string, string> {
  return {
    host: TEAM_HOST,
    "x-forwarded-for": "203.0.113.7",
    ...("cookie" in as ? { cookie: as.cookie } : { authorization: `Bearer ${as.bearer}` }),
  };
}

/** Open `path` (`/ws`, `/ws/pty?…`) as `as` over a real connection; `opened` collects it for cleanup. */
export function connectAs(
  e: MembersEnv,
  path: string,
  as: Credential,
  opened: WebSocket[],
): Promise<MemberSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${e.server.url.replace("http", "ws")}${path}`, {
      headers: headersOf(as),
    });
    opened.push(ws);
    const closed = new Promise<void>((done) => ws.once("close", () => done()));
    ws.once("unexpected-response", (_req, res) =>
      resolve({ status: res.statusCode ?? 0, ws, closed }),
    );
    ws.once("open", () => resolve({ status: 101, ws, closed }));
    ws.once("error", reject);
  });
}

/** Resolves true if the socket closes within `ms`. */
export function closesWithin(closed: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}
