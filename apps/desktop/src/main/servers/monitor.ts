import { ActivitySummary } from "@codeden/contracts";

/** How a remote server answered its last poll. */
export type RemoteState = "starting" | "ok" | "signed-out" | "unreachable";

export interface RemoteStatus {
  state: RemoteState;
  /** Counts from the last good answer; kept while the server is unreachable or signed out. */
  activity: ActivitySummary | null;
}

export interface RemoteMonitorOptions {
  baseUrl: string;
  /** The server's own session partition's fetch, so its device cookie is sent (and nothing else). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  intervalMs?: number;
  onChange: (status: RemoteStatus) => void;
}

/**
 * Polls one remote server's `GET /api/activity` through that server's own session (§17.1).
 * A server that is down or has signed the device out is a state to show, never an error: the
 * poll never throws and the timer keeps going.
 */
export class RemoteMonitor {
  private timer: NodeJS.Timeout | undefined;
  private last = "";
  private inFlight = false;
  status: RemoteStatus = { state: "starting", activity: null };

  constructor(private readonly opts: RemoteMonitorOptions) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<RemoteStatus> {
    if (this.inFlight) return this.status;
    this.inFlight = true;
    let next: RemoteStatus;
    try {
      const res = await this.opts.fetch(`${this.opts.baseUrl}/api/activity`, {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) {
        next = { state: "signed-out", activity: this.status.activity };
      } else if (!res.ok) {
        next = { state: "unreachable", activity: this.status.activity };
      } else {
        next = { state: "ok", activity: ActivitySummary.parse(await res.json()) };
      }
    } catch {
      next = { state: "unreachable", activity: this.status.activity };
    } finally {
      this.inFlight = false;
    }
    this.status = next;
    const key = JSON.stringify(next);
    if (key !== this.last) {
      this.last = key;
      this.opts.onChange(next);
    }
    return next;
  }
}
