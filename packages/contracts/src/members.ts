import { z } from "zod";
import { Id, Timestamp } from "./common";
import { RemoteDevice } from "./network";

/**
 * Members (docs/machines-teams-and-agents.md Part B and C): the people and connected agents who
 * may use a CodeDen server. People join with an invite and their own passphrase; agents get a
 * token. Members are local to the server: nothing is hosted, and there is no outside identity
 * provider. A single-user install has exactly one member, the owner.
 */

/** Id of the first owner: the person behind the install token and the network password. */
export const OWNER_MEMBER_ID = "owner";

/** A person (signs in with a passphrase) or a connected agent (uses a bearer token). */
export const MemberKind = z.enum(["person", "agent"]);
export type MemberKind = z.infer<typeof MemberKind>;

/**
 * What a member may do (§B.3), lowest first:
 * - `none`: nothing; the member doesn't see the project (or, server-wide, sees only the projects
 *   given a role of their own).
 * - `viewer`: watch everything live, read-only terminals.
 * - `operator`: viewer, plus act on work: messages, sessions, answers, automations runs, git.
 * - `owner`: operator, plus administer: settings, projects, members, secrets, network access.
 */
export const MemberRole = z.enum(["none", "viewer", "operator", "owner"]);
export type MemberRole = z.infer<typeof MemberRole>;

/** Roles in order, lowest first (`MEMBER_ROLES.indexOf` compares them). */
export const MEMBER_ROLES: readonly MemberRole[] = MemberRole.options;

/** Is `role` at least `need`? */
export function roleAtLeast(role: MemberRole, need: MemberRole): boolean {
  return MEMBER_ROLES.indexOf(role) >= MEMBER_ROLES.indexOf(need);
}

/** The lower of two roles. */
export function lowerRole(a: MemberRole, b: MemberRole): MemberRole {
  return MEMBER_ROLES.indexOf(a) <= MEMBER_ROLES.indexOf(b) ? a : b;
}

/** Roles a connected agent may hold: never Owner (§C.1). */
export const AgentRole = z.enum(["none", "viewer", "operator"]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Per-project overrides of a member's server-wide role, by project id. */
export const ProjectRoles = z.record(Id, MemberRole);
export type ProjectRoles = z.infer<typeof ProjectRoles>;

/** Longest display name. */
export const MEMBER_NAME_MAX = 60;

/** A display name: trimmed, 1 to 60 characters, no control characters. */
export const MemberName = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(MEMBER_NAME_MAX, `Use at most ${MEMBER_NAME_MAX} characters.`)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Use letters, digits and punctuation only.");

/** A member, as projected from `member.*` events. Holds no secret of any kind. */
export const Member = z.object({
  id: Id,
  kind: MemberKind,
  name: MemberName,
  /** Server-wide role; `projectRoles` raise or lower it per project. */
  role: MemberRole,
  projectRoles: ProjectRoles.default({}),
  /** A disabled member's devices and tokens are refused until it is enabled again. */
  disabled: z.boolean().default(false),
  /** Agents only: may answer approvals on projects where it is an Operator (§C.3). Off by default. */
  mayAnswerApprovals: z.boolean().default(false),
  /** Member who created it (an invite's owner, or the owner adding an agent); null for the first owner. */
  createdBy: Id.nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Member = z.infer<typeof Member>;

/** Who caused an event (§B.4): a person or a connected agent. */
export const Actor = z.object({ memberId: Id, kind: MemberKind });
export type Actor = z.infer<typeof Actor>;

/** What every signed-in client knows about the other members: enough to show names. */
export const MemberSummary = Member.pick({ id: true, kind: true, name: true });
export type MemberSummary = z.infer<typeof MemberSummary>;

/** The effective role of `member` on `projectId` (null: work outside any project). */
export function memberRoleOn(
  member: Pick<Member, "role" | "projectRoles" | "disabled">,
  projectId: string | null,
): MemberRole {
  if (member.disabled) return "none";
  if (projectId === null) return member.role;
  return member.projectRoles[projectId] ?? member.role;
}

/**
 * The member's role across the whole server: its server-wide role, lowered by any project where
 * it has less. Work that spans projects (the orchestrator, reports, search across projects)
 * needs this, so nothing about a hidden project reaches the member through it.
 */
export function memberGlobalRole(
  member: Pick<Member, "role" | "projectRoles" | "disabled">,
  projectIds: readonly string[],
): MemberRole {
  if (member.disabled) return "none";
  let role = member.role;
  for (const id of projectIds) role = lowerRole(role, member.projectRoles[id] ?? member.role);
  return role;
}

// ---------------------------------------------------------------------------- events

/** `member.created` / `member.updated`: the whole member, projected into `members`. */
export const MemberEventPayload = z.object({ member: Member });
/** `member.deleted`: the member's row goes; its devices and tokens were revoked first. */
export const MemberDeletedPayload = z.object({ memberId: Id });

// ---------------------------------------------------------------------------- invites

/** How long an invite link works. */
export const INVITE_DAYS = 7;

/** An invite, as owners see it (never its secret). */
export const MemberInvite = z.object({
  id: Id,
  role: MemberRole,
  projectRoles: ProjectRoles.default({}),
  /** An optional note for the owner, e.g. who it is for. */
  note: z.string().max(200).nullable().default(null),
  createdBy: Id,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  /** Set once someone joined with it: it never works again. */
  usedAt: Timestamp.nullable().default(null),
  usedBy: Id.nullable().default(null),
  revokedAt: Timestamp.nullable().default(null),
});
export type MemberInvite = z.infer<typeof MemberInvite>;

/** `POST /api/members/invites` (owners): a role, optional per-project roles, a note. */
export const CreateInviteRequest = z.object({
  role: MemberRole,
  projectRoles: ProjectRoles.default({}),
  note: z.string().trim().max(200).optional(),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>;

/**
 * The new invite and its secret, shown once. The link is `<origin>/join#<secret>`: the secret
 * sits in the fragment, so browsers never send it in a request line or a `Referer`.
 */
export const CreateInviteResponse = z.object({ invite: MemberInvite, secret: z.string() });
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

/** Prefix of invite secrets. */
export const INVITE_SECRET_PREFIX = "cdi_";
/** Prefix of connected agents' tokens. */
export const AGENT_TOKEN_PREFIX = "cda_";

const Secret = z.string().min(8).max(200);

/** `POST /api/auth/invite`: is this invite still good? (public, throttled like sign-in) */
export const InviteCheckRequest = z.object({ secret: Secret });
export type InviteCheckRequest = z.infer<typeof InviteCheckRequest>;

export const InviteCheckResponse = z.object({
  role: MemberRole,
  expiresAt: Timestamp,
  /** The server's name for the page title: the first owner's display name. */
  ownerName: z.string(),
});
export type InviteCheckResponse = z.infer<typeof InviteCheckResponse>;

/** `POST /api/auth/join`: take an invite with a display name and a passphrase (the §15.1 rules). */
export const JoinRequest = z.object({
  secret: Secret,
  name: MemberName,
  password: z.string().max(256),
});
export type JoinRequest = z.infer<typeof JoinRequest>;

// ---------------------------------------------------------------------------- agents

/** A connected agent's token, as owners see it (never the token). */
export const AgentTokenInfo = z.object({
  id: Id,
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
});
export type AgentTokenInfo = z.infer<typeof AgentTokenInfo>;

/** `POST /api/members/agents` (owners): Settings › Members › Add agent. */
export const CreateAgentRequest = z.object({
  name: MemberName,
  role: AgentRole,
  projectRoles: z.record(Id, AgentRole).default({}),
  mayAnswerApprovals: z.boolean().default(false),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

/** The agent and its token, shown once (`Authorization: Bearer <token>`). */
export const CreateAgentResponse = z.object({ member: Member, token: z.string() });
export type CreateAgentResponse = z.infer<typeof CreateAgentResponse>;

// ---------------------------------------------------------------------------- management

/** `PATCH /api/members/:id` (owners). Agents can't become owners anywhere. */
export const UpdateMemberRequest = z
  .object({
    name: MemberName.optional(),
    role: MemberRole.optional(),
    projectRoles: ProjectRoles.optional(),
    disabled: z.boolean().optional(),
    mayAnswerApprovals: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Say what to change." });
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

/** A member with what owners manage about it: its devices (people) and tokens (agents). */
export const MemberDetail = z.object({
  member: Member,
  devices: z.array(RemoteDevice),
  tokens: z.array(AgentTokenInfo),
  /** People only: a passphrase is set (the first owner's is the network password). */
  hasPassphrase: z.boolean(),
});
export type MemberDetail = z.infer<typeof MemberDetail>;

/** `POST /api/members/:id/tokens` (owners): a new token for an agent, shown once. */
export const MintTokenResponse = z.object({ token: z.string(), member: MemberDetail });
export type MintTokenResponse = z.infer<typeof MintTokenResponse>;

/** `GET /api/members` (owners): everyone, and the invites. */
export const MembersResponse = z.object({
  members: z.array(MemberDetail),
  invites: z.array(MemberInvite),
});
export type MembersResponse = z.infer<typeof MembersResponse>;

/** `GET /api/members/me`: who the caller is, and what it may do (the UI hides the rest). */
export const MeResponse = z.object({
  member: Member,
  /** Its effective role per project, for every project it can see. */
  projectRoles: z.record(Id, MemberRole),
  /** Its role for work across projects (`memberGlobalRole`). */
  globalRole: MemberRole,
  /** More than one member exists: the UI shows names and presence. */
  team: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** `GET /api/members/summaries`: names for attribution, for every signed-in member. */
export const MemberSummariesResponse = z.object({ members: z.array(MemberSummary) });
export type MemberSummariesResponse = z.infer<typeof MemberSummariesResponse>;

/** One attributed event in the activity list (Settings › Members). */
export const MemberActivity = z.object({
  seq: z.int().positive(),
  type: z.string(),
  actor: Actor,
  sessionId: Id.nullable(),
  ts: Timestamp,
});
export type MemberActivity = z.infer<typeof MemberActivity>;

export const MemberActivityResponse = z.object({ events: z.array(MemberActivity) });
export type MemberActivityResponse = z.infer<typeof MemberActivityResponse>;

/** Who answered a question or approval first (§B.4), recorded on the inbox item's resolution. */
export const AnsweredBy = z.object({ answeredBy: Actor });
export type AnsweredBy = z.infer<typeof AnsweredBy>;
