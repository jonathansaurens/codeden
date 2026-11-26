import type { Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { isLoopbackAddress } from "./addresses";

/**
 * Sockets that carried a request through a trusted proxy's host. Their peer is 127.0.0.1, so
 * "drop remote connections" (sign-out, network off) has to close these too.
 */
export const proxiedSockets = new WeakSet<object>();

/** Who a connection last authenticated as (a request's principal), for closing one member's connections. */
export interface ConnectionOwner {
  memberId: string;
  via: "install" | "session" | "token";
  /** The device's remote session id, for `via: "session"`. */
  sessionId?: string;
  /** The agent token's id, for `via: "token"`. */
  tokenId?: string;
}

/**
 * The owner of each connection that carried an authenticated request, set by the security
 * middleware. A WebSocket keeps its upgrade request's owner for as long as it is open.
 */
export const connectionOwners = new WeakMap<object, ConnectionOwner>();

/** Which connections to close: every field given must match the connection's owner. */
export type ConnectionMatch = Partial<ConnectionOwner>;

export type BindHost = "127.0.0.1" | "0.0.0.0";

/** How long a rebind keeps retrying while the OS releases the port. */
const REBIND_TIMEOUT_MS = 5_000;

/**
 * The TCP listener in front of the HTTP server (§15.1). The HTTP server (with its WebSocket
 * upgrade handling) never listens itself: this accepts connections and hands them over, so
 * switching between `127.0.0.1` and `0.0.0.0` swaps only the listening socket. Open
 * connections, including the UI's WebSockets, carry on, and the runner is untouched.
 */
export class HttpListener {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private boundHost: BindHost = "127.0.0.1";
  private boundPort = 0;

  constructor(private readonly http: HttpServer) {}

  get host(): BindHost {
    return this.boundHost;
  }

  get port(): number {
    return this.boundPort;
  }

  /** Bind for the first time (`port` 0 picks a free port); resolves with the port. */
  async listen(port: number, host: BindHost): Promise<number> {
    this.server = await this.bind(port, host);
    this.boundHost = host;
    const address = this.server.address();
    this.boundPort = typeof address === "object" && address ? address.port : port;
    return this.boundPort;
  }

  private rebinding: Promise<unknown> = Promise.resolve();

  /** Move the listener to `host` on the same port. Open connections stay open. Rebinds run one at a time. */
  rebind(host: BindHost): Promise<void> {
    const run = this.rebinding.then(() => this.rebindNow(host));
    this.rebinding = run.catch(() => {});
    return run;
  }

  private async rebindNow(host: BindHost): Promise<void> {
    if (host === this.boundHost && this.server) return;
    this.server?.close();
    this.server = undefined;
    const deadline = Date.now() + REBIND_TIMEOUT_MS;
    for (;;) {
      try {
        this.server = await this.bind(this.boundPort, host);
        this.boundHost = host;
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" || Date.now() > deadline) {
          // Never leave the server unreachable: fall back to loopback.
          if (host !== "127.0.0.1") {
            this.server = await this.bind(this.boundPort, "127.0.0.1");
            this.boundHost = "127.0.0.1";
          }
          throw error;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  /** Close every connection that did not come from this machine, or came through the trusted proxy (sign-outs, network off). */
  dropRemote(): number {
    let dropped = 0;
    for (const socket of this.sockets) {
      if (!isLoopbackAddress(socket.remoteAddress) || proxiedSockets.has(socket)) {
        socket.destroy();
        dropped++;
      }
    }
    return dropped;
  }

  /**
   * Close the connections whose owner matches (one member's, device's or token's), wherever
   * they come from, except `except` (the request asking for it, so it still gets its answer).
   */
  dropMatching(match: ConnectionMatch, except?: object): number {
    const keys = Object.entries(match).filter(([, value]) => value !== undefined);
    if (keys.length === 0) return 0;
    let dropped = 0;
    for (const socket of this.sockets) {
      if (socket === except) continue;
      const owner = connectionOwners.get(socket) as Record<string, unknown> | undefined;
      if (owner && keys.every(([key, value]) => owner[key] === value)) {
        socket.destroy();
        dropped++;
      }
    }
    return dropped;
  }

  /** Stop listening and close every connection. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private bind(port: number, host: BindHost): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
        this.http.emit("connection", socket);
      });
      server.once("error", reject);
      server.listen({ port, host, exclusive: true }, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }
}
