import type { UiClientMessage, UiServerMessage } from "@codeden/contracts";
import WebSocket from "ws";

/** Test client for `/ws` that records every message and can wait for one. */
export class TestWsClient {
  readonly messages: UiServerMessage[] = [];
  private waiters: Array<() => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()) as UiServerMessage);
      for (const w of this.waiters) w();
    });
  }

  static connect(url: string, token: string): Promise<TestWsClient> {
    return TestWsClient.open(url, { authorization: `Bearer ${token}` });
  }

  /** Connect with these headers (a remote device's cookie and `Host`, say). */
  static async open(url: string, headers: Record<string, string>): Promise<TestWsClient> {
    const ws = new WebSocket(`${url.replace("http", "ws")}/ws`, { headers });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new TestWsClient(ws);
  }

  send(msg: UiClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolve with the first recorded message matching `predicate`. */
  waitFor<T extends UiServerMessage>(
    predicate: (m: UiServerMessage) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
  waitFor(predicate: (m: UiServerMessage) => boolean, timeoutMs?: number): Promise<UiServerMessage>;
  waitFor(
    predicate: (m: UiServerMessage) => boolean,
    timeoutMs = 60_000,
  ): Promise<UiServerMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.messages.find(predicate);
        if (!found) return false;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== listener);
        resolve(found);
        return true;
      };
      const listener = () => void check();
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== listener);
        reject(new Error("timed out waiting for a websocket message"));
      }, timeoutMs);
      if (!check()) this.waiters.push(listener);
    });
  }

  close(): void {
    this.ws.close();
  }
}
