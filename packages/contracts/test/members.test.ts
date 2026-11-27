import { describe, expect, it } from "vitest";
import {
  CreateAgentRequest,
  CreateInviteRequest,
  CreateInviteResponse,
  EventEnvelope,
  JoinRequest,
  type Member,
  Member as MemberSchema,
  MembersResponse,
  MeResponse,
  memberGlobalRole,
  memberRoleOn,
  OWNER_MEMBER_ID,
  RemoteAccessFile,
  roleAtLeast,
  UpdateMemberRequest,
} from "../src";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

const at = "2026-11-25T09:00:00.000Z";
const ana: Member = {
  id: "m-ana",
  kind: "person",
  name: "Ana",
  role: "viewer",
  projectRoles: { helpdesk: "operator", secret: "none" },
  disabled: false,
  mayAnswerApprovals: false,
  createdBy: OWNER_MEMBER_ID,
  createdAt: at,
  updatedAt: at,
};

describe("member contracts", () => {
  it("round-trips members, invites, requests and events", () => {
    roundTrip(MemberSchema, ana);
    roundTrip(CreateInviteRequest, { role: "operator", projectRoles: { p1: "viewer" } });
    roundTrip(CreateInviteResponse, {
      invite: {
        id: "i1",
        role: "viewer",
        projectRoles: {},
        note: "for Ana",
        createdBy: OWNER_MEMBER_ID,
        createdAt: at,
        expiresAt: "2026-12-02T09:00:00.000Z",
        usedAt: null,
        usedBy: null,
        revokedAt: null,
      },
      secret: "cdi_abc",
    });
    roundTrip(JoinRequest, { secret: "cdi_abcdefgh", name: "Ana", password: "x" });
    roundTrip(UpdateMemberRequest, { disabled: true });
    roundTrip(MeResponse, {
      member: ana,
      projectRoles: { helpdesk: "operator" },
      globalRole: "none",
      team: true,
    });
    roundTrip(MembersResponse, {
      members: [{ member: ana, devices: [], tokens: [], hasPassphrase: true }],
      invites: [],
    });
    roundTrip(EventEnvelope, {
      seq: 1,
      sessionId: null,
      ts: at,
      type: "member.created",
      payload: { member: ana },
    });
    roundTrip(EventEnvelope, {
      seq: 2,
      sessionId: null,
      ts: at,
      type: "member.deleted",
      payload: { memberId: "m-ana" },
    });
  });

  it("trims names and refuses empty or control-character names", () => {
    expect(JoinRequest.parse({ secret: "cdi_abcdefgh", name: "  Ana ", password: "x" }).name).toBe(
      "Ana",
    );
    expect(
      JoinRequest.safeParse({ secret: "cdi_abcdefgh", name: "  ", password: "x" }).success,
    ).toBe(false);
    expect(
      JoinRequest.safeParse({ secret: "cdi_abcdefgh", name: "a\u0007b", password: "x" }).success,
    ).toBe(false);
  });

  it("never lets an agent be an owner", () => {
    expect(CreateAgentRequest.safeParse({ name: "bot", role: "owner" }).success).toBe(false);
    expect(
      CreateAgentRequest.safeParse({ name: "bot", role: "viewer", projectRoles: { p: "owner" } })
        .success,
    ).toBe(false);
    expect(CreateAgentRequest.parse({ name: "bot", role: "operator" }).mayAnswerApprovals).toBe(
      false,
    );
  });

  it("resolves roles per project, globally and for disabled members", () => {
    expect(memberRoleOn(ana, "helpdesk")).toBe("operator");
    expect(memberRoleOn(ana, "secret")).toBe("none");
    expect(memberRoleOn(ana, "other")).toBe("viewer");
    expect(memberRoleOn(ana, null)).toBe("viewer");
    // A hidden project lowers the role for work across projects.
    expect(memberGlobalRole(ana, ["helpdesk", "secret"])).toBe("none");
    expect(memberGlobalRole(ana, ["helpdesk", "other"])).toBe("viewer");
    expect(memberRoleOn({ ...ana, disabled: true }, "helpdesk")).toBe("none");
    expect(roleAtLeast("operator", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "operator")).toBe(false);
  });

  it("reads devices stored before members as the first owner's", () => {
    const file = RemoteAccessFile.parse({
      enabled: true,
      sessions: [
        {
          id: "s1",
          tokenHash: "a".repeat(64),
          label: "Safari",
          address: null,
          createdAt: at,
          lastSeenAt: at,
          expiresAt: "2027-02-23T09:00:00.000Z",
        },
      ],
    });
    expect(file.sessions[0]?.memberId).toBe(OWNER_MEMBER_ID);
  });
});
