import type { Member, RunnerRecord } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { placementRefusal } from "../src/execution/connected/access";
import type { Principal } from "../src/members/principal";

/** Who may place work on a person's own computer (`docs/machines-teams-and-agents.md` §D.5). */

const person = (id: string, over: Partial<Member> = {}): Member => ({
  id,
  kind: "person",
  name: id === "alice" ? "Alice" : "Bob",
  role: "operator",
  projectRoles: {},
  disabled: false,
  mayAnswerApprovals: false,
  createdBy: null,
  createdAt: "2026-11-26T09:00:00.000Z",
  updatedAt: "2026-11-26T09:00:00.000Z",
  ...over,
});

const laptop = { id: "c-1", label: "alice-mbp", ownerMemberId: "alice" } as RunnerRecord;
const as = (member: Member): Principal => ({ member, via: "session" });

describe("a person's own computer", () => {
  it("takes its person's sessions and refuses everyone else's", () => {
    const alice = person("alice");
    const members = (id: string) => (id === "alice" ? alice : undefined);
    expect(placementRefusal(laptop, "p-1", members, as(alice))).toBeNull();
    expect(placementRefusal(laptop, "p-1", members, as(person("bob", { role: "owner" })))).toBe(
      "Alice's computer (alice-mbp) is Alice's own computer; only they can run sessions there",
    );
    const agent = person("bot", { kind: "agent" });
    expect(placementRefusal(laptop, "p-1", members, as(agent))).not.toBeNull();
  });

  it("takes work nobody in particular started only where its person is an Owner", () => {
    const operator = person("alice");
    const owner = person("alice", { projectRoles: { "p-1": "owner" } });
    expect(placementRefusal(laptop, "p-1", () => operator, undefined)).toMatch(
      /only work they start/,
    );
    expect(placementRefusal(laptop, "p-1", () => owner, undefined)).toBeNull();
    expect(placementRefusal(laptop, "p-2", () => owner, undefined)).not.toBeNull();
  });

  it("refuses all work once its person is gone, and leaves other machines alone", () => {
    expect(placementRefusal(laptop, "p-1", () => undefined, undefined)).toMatch(/person is gone/);
    const vps = { id: "m-1", label: "vps-1", ownerMemberId: null } as RunnerRecord;
    expect(placementRefusal(vps, "p-1", () => undefined, undefined)).toBeNull();
  });
});
