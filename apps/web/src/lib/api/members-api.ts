import {
  type CreateInviteRequest,
  CreateInviteResponse,
  type Member,
  MemberActivityResponse,
  MemberDetail,
  MemberSummariesResponse,
  MembersResponse,
  MeResponse,
  OWNER_MEMBER_ID,
  type UpdateMemberRequest,
} from "@codeden/contracts";
import type { Fetcher } from "./http";

/** Members (§B.2): who I am, everyone's names, and the owners' management calls. */
export interface MembersApi {
  me(): Promise<MeResponse>;
  summaries(): Promise<MemberSummariesResponse>;
  /** Owners: everyone, with devices and tokens, and the invites. */
  list(): Promise<MembersResponse>;
  createInvite(
    req: Partial<CreateInviteRequest> & Pick<CreateInviteRequest, "role">,
  ): Promise<CreateInviteResponse>;
  revokeInvite(id: string): Promise<void>;
  update(id: string, patch: UpdateMemberRequest): Promise<MemberDetail>;
  remove(id: string): Promise<void>;
  signOutDevice(memberId: string, deviceId: string): Promise<MemberDetail>;
  /** Owners: the latest things people and connected agents did (§B.4). */
  activity(): Promise<MemberActivityResponse>;
}

const enc = encodeURIComponent;

export function httpMembersApi(http: Fetcher): MembersApi {
  return {
    me: () => http.get("/members/me", (v) => MeResponse.parse(v)),
    summaries: () => http.get("/members/summaries", (v) => MemberSummariesResponse.parse(v)),
    list: () => http.get("/members", (v) => MembersResponse.parse(v)),
    createInvite: (req) => http.post("/members/invites", req, (v) => CreateInviteResponse.parse(v)),
    async revokeInvite(id) {
      await http.call("DELETE", `/members/invites/${enc(id)}`);
    },
    update: (id, patch) =>
      http.call("PATCH", `/members/${enc(id)}`, patch, (v) => MemberDetail.parse(v)),
    async remove(id) {
      await http.call("DELETE", `/members/${enc(id)}`);
    },
    activity: () => http.get("/members/activity", (v) => MemberActivityResponse.parse(v)),
    signOutDevice: (memberId, deviceId) =>
      http.call("DELETE", `/members/${enc(memberId)}/devices/${enc(deviceId)}`, undefined, (v) =>
        MemberDetail.parse(v),
      ),
  };
}

/** The mock is a single-user install: the owner alone. */
export function mockMembersApi(): MembersApi {
  const at = new Date().toISOString();
  let members: Member[] = [
    {
      id: OWNER_MEMBER_ID,
      kind: "person",
      name: "Owner",
      role: "owner",
      projectRoles: {},
      disabled: false,
      mayAnswerApprovals: false,
      createdBy: null,
      createdAt: at,
      updatedAt: at,
    },
  ];
  const detail = (m: Member): MemberDetail => ({
    member: m,
    devices: [],
    tokens: [],
    hasPassphrase: true,
  });
  const find = (id: string) => {
    const m = members.find((x) => x.id === id);
    if (!m) throw new Error("No such member");
    return m;
  };
  return {
    me: async () => ({
      member: find(OWNER_MEMBER_ID),
      projectRoles: {},
      globalRole: "owner",
      team: members.length > 1,
    }),
    summaries: async () => ({ members: members.map(({ id, kind, name }) => ({ id, kind, name })) }),
    list: async () => ({ members: members.map(detail), invites: [] }),
    createInvite: async (req) => ({
      invite: {
        id: crypto.randomUUID(),
        role: req.role,
        projectRoles: req.projectRoles ?? {},
        note: req.note ?? null,
        createdBy: OWNER_MEMBER_ID,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        usedAt: null,
        usedBy: null,
        revokedAt: null,
      },
      secret: "cdi_mock-invite-secret",
    }),
    revokeInvite: async () => {},
    async update(id, patch) {
      const next = { ...find(id), ...patch, updatedAt: new Date().toISOString() } as Member;
      members = members.map((m) => (m.id === id ? next : m));
      return detail(next);
    },
    async remove(id) {
      members = members.filter((m) => m.id !== id);
    },
    signOutDevice: async (memberId) => detail(find(memberId)),
    activity: async () => ({ events: [] }),
  };
}
