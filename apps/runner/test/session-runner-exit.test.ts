import { tmpdir } from "node:os";
import type { AgentEvent, RunnerEvent, SessionOptions } from "@codeden/contracts";
import { FakeProvider, ProviderRegistry } from "@codeden/providers";
import { describe, expect, it } from "vitest";
import { SessionHost } from "../src/session-host";

const options: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setImmediate(r));
  }
}

describe("a runner exiting mid-turn", () => {
  it("reports the turn it cuts off as a restart, not the user's Stop", async () => {
    const events: RunnerEvent[] = [];
    const host = new SessionHost(new ProviderRegistry([new FakeProvider()]), (e) => {
      events.push(e);
    });
    await host.start({
      name: "session.start",
      sessionId: "s1",
      providerId: "fake",
      options,
      checkpoints: false,
    });
    const agent = () => events.flatMap((e): AgentEvent[] => (e.kind === "agent" ? [e.event] : []));
    await host.send({
      name: "session.send",
      sessionId: "s1",
      input: { text: "clean up [approval]", attachments: [] },
    });
    // The turn waits on an approval when the runner shuts down.
    await until(() =>
      agent().some((e) => e.type === "item.started" && e.item.kind === "approval_request"),
    );
    await host.closeAll();
    const exited = () => events.find((e) => e.kind === "session.process" && e.state === "exited");
    await until(() => exited() !== undefined);
    expect(agent().find((e) => e.type === "turn.interrupted")).toMatchObject({
      reason: "runner_restart",
    });
    expect(exited()).toMatchObject({
      reason: "runner_exit",
      interruptedTurn: true,
    });
  });
});
