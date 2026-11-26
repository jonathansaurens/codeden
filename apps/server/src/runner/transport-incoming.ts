import { encodeLinkFrame, RunnerConnectClose } from "@codeden/contracts";
import {
  RunnerFrameTooLargeError,
  type RunnerTransport,
  type RunnerTransportHandlers,
} from "./transport";

/**
 * Reach a runner that links in to the server (a computer running `codeden connect`, §D.5): the
 * server never dials it, so each (re)connect waits for, and adopts, the next authenticated
 * socket that computer opens (`IncomingLinks.arrive`).
 */
export interface IncomingLinkConfig {
  kind: "incoming";
  /** Resolve with the next socket for this runner; rejects when `signal` aborts first. */
  accept: (handlers: RunnerTransportHandlers, signal: AbortSignal) => Promise<RunnerTransport>;
}

/** A WebSocket a computer opened, as the route hands it over. */
export interface IncomingSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** Where the route delivers what the socket receives. */
export interface IncomingSink {
  /** One text message from the runner. */
  message(text: string): void;
  /** The socket closed (or failed). */
  closed(detail?: string): void;
}

/** Messages kept for a socket not adopted yet (the runner speaks only after `hello`). */
const MAX_BUFFERED = 256;

/** One socket from its arrival until it ends; the `incoming` transport once adopted. */
class Arrival implements IncomingSink {
  private handlers: RunnerTransportHandlers | undefined;
  private buffered: unknown[] = [];
  ended = false;

  constructor(
    private readonly socket: IncomingSocket,
    private readonly forget: (arrival: Arrival) => void,
    private readonly log?: (message: string) => void,
  ) {}

  message(text: string): void {
    if (this.ended) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.log?.("runner-connect: dropped a message that is not JSON");
      return;
    }
    if (this.handlers) this.handlers.onMessage(message);
    else if (this.buffered.length < MAX_BUFFERED) this.buffered.push(message);
  }

  closed(detail?: string): void {
    this.finish(detail ?? "the computer's link closed");
  }

  /** End it from the server's side: the socket is closed and the client told at once. */
  end(code: number, reason: string): void {
    if (this.ended) return;
    this.finish(reason);
    try {
      this.socket.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  /** Become the client's transport: messages that came before are delivered now. */
  adopt(handlers: RunnerTransportHandlers): RunnerTransport {
    this.handlers = handlers;
    const early = this.buffered;
    this.buffered = [];
    for (const message of early) handlers.onMessage(message);
    // It ended before it was adopted: say so once the client holds the transport.
    if (this.ended) queueMicrotask(() => handlers.onClose("the computer's link closed"));
    return {
      send: (message) => {
        const frame = encodeLinkFrame(message);
        if (frame === null) {
          const what =
            message.type === "command" ? `Runner command ${message.command.name}` : "A message";
          throw new RunnerFrameTooLargeError(what);
        }
        if (this.ended) return;
        try {
          this.socket.send(frame.slice(0, -1));
        } catch (error) {
          this.log?.(`runner-connect: sending failed: ${(error as Error).message}`);
        }
      },
      close: async (reason = "server stopping") => this.end(1000, reason),
    };
  }

  private finish(detail: string): void {
    if (this.ended) return;
    this.ended = true;
    this.forget(this);
    this.handlers?.onClose(detail);
  }
}

/**
 * The sockets computers open to `/api/runner-connect`, per machine record id, handed to that
 * machine's `RunnerClient` through its `incoming` link (`link(id)`). A computer that links again
 * (after sleep or a network change, while the server still holds its old socket) replaces the
 * old link: that one ends, the client reconnects and adopts the new socket, and resumes by
 * `seq` as after any dropped link. A socket that arrives while no client waits is kept until one
 * does; only the newest is kept.
 */
export class IncomingLinks {
  private readonly waiters = new Map<string, (arrival: Arrival) => void>();
  private readonly pending = new Map<string, Arrival>();
  private readonly live = new Map<string, Arrival>();

  constructor(private readonly log?: (message: string) => void) {}

  /** The link config for a machine's client. */
  link(machineId: string): IncomingLinkConfig {
    return {
      kind: "incoming",
      accept: (handlers, signal) => this.accept(machineId, handlers, signal),
    };
  }

  /** Whether the machine has a socket open now (adopted or waiting to be). */
  has(machineId: string): boolean {
    return this.live.has(machineId) || this.pending.has(machineId);
  }

  /** A computer opened an authenticated socket for `machineId`. */
  arrive(machineId: string, socket: IncomingSocket): IncomingSink {
    const arrival: Arrival = new Arrival(
      socket,
      (ended) => this.forget(machineId, ended),
      this.log,
    );
    // The older sockets end first: the client of the live one reconnects at once and finds
    // nothing pending, so it waits for this one (below).
    this.pending.get(machineId)?.end(RunnerConnectClose.replaced, "the computer linked again");
    this.live.get(machineId)?.end(RunnerConnectClose.replaced, "the computer linked again");
    const waiter = this.waiters.get(machineId);
    if (waiter) {
      this.waiters.delete(machineId);
      waiter(arrival);
    } else {
      this.pending.set(machineId, arrival);
    }
    return arrival;
  }

  /** End the machine's link, if any (it was disconnected: `revoked`). */
  drop(machineId: string, code: number, reason: string): void {
    this.live.get(machineId)?.end(code, reason);
    this.pending.get(machineId)?.end(code, reason);
  }

  private accept(
    machineId: string,
    handlers: RunnerTransportHandlers,
    signal: AbortSignal,
  ): Promise<RunnerTransport> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Runner connection cancelled"));
      const onAbort = () => {
        if (this.waiters.get(machineId) === take) this.waiters.delete(machineId);
        reject(new Error("Runner connection cancelled"));
      };
      const take = (arrival: Arrival) => {
        signal.removeEventListener("abort", onAbort);
        if (!arrival.ended) this.live.set(machineId, arrival);
        resolve(arrival.adopt(handlers));
      };
      const ready = this.pending.get(machineId);
      if (ready) {
        this.pending.delete(machineId);
        return take(ready);
      }
      this.waiters.set(machineId, take);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private forget(machineId: string, arrival: Arrival): void {
    if (this.live.get(machineId) === arrival) this.live.delete(machineId);
    if (this.pending.get(machineId) === arrival) this.pending.delete(machineId);
  }
}
