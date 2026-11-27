import type { MachinesResponse, RunnerRecord, Snapshot } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { eventFilterFor } from "../src/members/sockets";
import { type MembersEnv, seedProjects, startMembersEnv } from "./support/members-env";

/**
 * A person's own computer is theirs and the server Owners' to see (§D.5): nobody else finds it in
 * `GET /api/machines`, the snapshot or the live runner events. Machines over SSH stay everyone's.
 */
let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const record = (over: Partial<RunnerRecord>): RunnerRecord => ({
  id: "rn-x",
  backend: "ssh",
  home: false,
  runnerId: null,
  sandboxRef: "dev@vps",
  label: "vps",
  weight: null,
  projectId: null,
  sessionId: null,
  state: "disconnected",
  version: null,
  imageVersion: null,
  createdAt: "2026-11-26T10:00:00.000Z",
  lastSeenAt: null,
  lastError: null,
  ownerMemberId: null,
  ...over,
});

describe("who sees a connected computer (§D.5)", () => {
  it("shows it to its person and the server's Owners only", async () => {
    const e = await startMembersEnv();
    env = e;
    const s = e.server.services;
    seedProjects(e.server, ["p1"]);
    const otto = await e.join(await e.invite("operator"), "Otto");
    const vera = await e.join(await e.invite("operator"), "Vera");
    const wanda = await e.join(await e.invite("owner"), "Wanda");
    const ottoId = s.members.findPersonByName("Otto")?.id as string;
    const laptop = record({
      id: "rn-laptop",
      backend: "connected",
      sandboxRef: "ottos-mbp",
      label: "ottos-mbp",
      ownerMemberId: ottoId,
    });
    e.server.store.append([
      { type: "runner.registered", sessionId: null, payload: { runner: record({}) } },
      { type: "runner.registered", sessionId: null, payload: { runner: laptop } },
    ]);

    const runnersOf = async (as: typeof otto) =>
      ((await (await e.remote("/api/snapshot", { as })).json()) as Snapshot).runners.map(
        (r) => r.id,
      );
    expect(await runnersOf(otto)).toEqual(expect.arrayContaining(["rn-x", "rn-laptop"]));
    expect(await runnersOf(wanda)).toEqual(expect.arrayContaining(["rn-x", "rn-laptop"]));
    expect(await runnersOf(vera)).toContain("rn-x");
    expect(await runnersOf(vera)).not.toContain("rn-laptop");

    if (s.machines) {
      const listed = async (as: typeof otto) =>
        ((await (await e.remote("/api/machines", { as })).json()) as MachinesResponse).machines.map(
          (m) => m.id,
        );
      expect(await listed(otto)).toContain("rn-laptop");
      expect(await listed(wanda)).toContain("rn-laptop");
      expect(await listed(vera)).not.toContain("rn-laptop");
    }

    const veraId = s.members.findPersonByName("Vera")?.id as string;
    const filter = eventFilterFor(s, { member: s.members.get(veraId), via: "session" });
    const registered = (runner: RunnerRecord) =>
      ({ seq: 1, type: "runner.registered", ts: "", payload: { runner } }) as never;
    const connected = (id: string) =>
      ({ seq: 2, type: "runner.connected", ts: "", payload: { id, runnerId: "r" } }) as never;
    expect(filter?.(registered(laptop))).toBe(false);
    expect(filter?.(connected("rn-laptop"))).toBe(false);
    expect(filter?.(registered(record({})))).toBe(true);
    expect(filter?.(connected("rn-x"))).toBe(true);
  });
});
