import {
  CreateAgentRequest,
  type CreateAgentResponse,
  CreateInviteRequest,
  type CreateInviteResponse,
  type Member,
  type MemberActivityResponse,
  type MemberDetail,
  type MemberRole,
  type MemberSummariesResponse,
  type MembersResponse,
  type MeResponse,
  type MintTokenResponse,
  memberGlobalRole,
  memberRoleOn,
  OWNER_MEMBER_ID,
  UpdateMemberRequest,
} from "@codeden/contracts";
import { and, desc, inArray, isNotNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { events } from "../db/schema";
import { ACTIVITY_QUERY_TYPES, activityOf } from "../members/activity";
import type { MemberAuth } from "../members/auth";
import { type Principal, principalOf } from "../members/principal";
import type { NetworkAccess } from "../network/access";
import { requestSocket } from "../security";
import type { AppServices } from "../services/container";
import { forbidden, notFound, ServiceError } from "../services/errors";
import { jsonBody } from "./validate";

/** Events in the activity list, and the rows read to find them (stops hide among updates). */
const ACTIVITY_LIMIT = 100;
const ACTIVITY_SCAN = 1000;

export interface MemberRouteContext {
  services: AppServices;
  auth: MemberAuth;
  network: NetworkAccess;
}

/** The caller (every `/api/members` route sits behind the security middleware). */
export function callerOf(c: Context): Principal {
  const principal = principalOf(c);
  if (!principal) throw new ServiceError(403, "forbidden", "Sign in first.");
  return principal;
}

/** Did a change alter what the member may see or do? */
function accessChanged(before: Member, after: Member): boolean {
  return (
    before.role !== after.role ||
    before.disabled !== after.disabled ||
    before.mayAnswerApprovals !== after.mayAnswerApprovals ||
    JSON.stringify(sortedRoles(before)) !== JSON.stringify(sortedRoles(after))
  );
}

function sortedRoles(member: Member): [string, string][] {
  return Object.entries(member.projectRoles).sort(([a], [b]) => a.localeCompare(b));
}

/** Owners' view of one member: its devices and tokens too. */
function detail(
  ctx: MemberRouteContext,
  memberId: string,
  currentSession: string | null,
): MemberDetail {
  const member = ctx.services.members.get(memberId);
  return {
    member,
    devices: member.kind === "person" ? ctx.auth.devices(member.id, currentSession) : [],
    tokens: member.kind === "agent" ? ctx.services.members.tokens(member.id) : [],
    hasPassphrase:
      member.id === OWNER_MEMBER_ID
        ? ctx.network.store.passwordSet
        : ctx.services.members.hasPassphrase(member.id),
  };
}

/** What the caller is and may do, so the UI can hide what the server would refuse. */
export function meResponse(s: AppServices, principal: Principal): MeResponse {
  const member = principal.member;
  const projectIds = s.projects.list({ includeArchived: true }).map((p) => p.id);
  const projectRoles: Record<string, MemberRole> = {};
  for (const id of projectIds) {
    const role = memberRoleOn(member, id);
    if (role !== "none") projectRoles[id] = role;
  }
  return {
    member,
    projectRoles,
    globalRole: memberGlobalRole(member, projectIds),
    team: s.members.isTeam(),
  };
}

/**
 * `/api/members` (§B.2): who the caller is, everyone's names (for attribution), and for owners:
 * the members with their devices and tokens, invites, roles, disabling and deleting. Who may call
 * which route is decided by the route table (`members/route-rules.ts`).
 */
export function memberRoutes(ctx: MemberRouteContext) {
  const s = ctx.services;
  return (
    new Hono()
      .get("/me", (c) => c.json(meResponse(s, callerOf(c))))
      .get("/summaries", (c) => {
        const body: MemberSummariesResponse = {
          members: s.members.list().map(({ id, kind, name }) => ({ id, kind, name })),
        };
        return c.json(body);
      })
      // Who did what (§B.4): the latest events a person or connected agent caused.
      .get("/activity", (c) => {
        const rows = s.db
          .select({
            seq: events.seq,
            type: events.type,
            actor: events.actor,
            sessionId: events.sessionId,
            ts: events.ts,
            payload: events.payload,
          })
          .from(events)
          .where(and(isNotNull(events.actor), inArray(events.type, ACTIVITY_QUERY_TYPES)))
          .orderBy(desc(events.seq))
          .limit(ACTIVITY_SCAN)
          .all();
        const body: MemberActivityResponse = {
          events: activityOf(
            rows.flatMap((r) => (r.actor ? [{ ...r, actor: r.actor }] : [])),
            ACTIVITY_LIMIT,
          ),
        };
        return c.json(body);
      })
      .get("/", (c) => {
        const current = callerOf(c).sessionId ?? null;
        const body: MembersResponse = {
          members: s.members.list().map((m) => detail(ctx, m.id, current)),
          invites: s.invites.list(),
        };
        return c.json(body);
      })
      .post("/invites", jsonBody(CreateInviteRequest), (c) => {
        const body: CreateInviteResponse = s.invites.create(
          c.req.valid("json"),
          callerOf(c).member.id,
        );
        return c.json(body);
      })
      .delete("/invites/:inviteId", (c) => {
        s.invites.revoke(c.req.param("inviteId"));
        return c.json({ ok: true as const });
      })
      .patch("/:id", jsonBody(UpdateMemberRequest), (c) => {
        const id = c.req.param("id");
        const before = s.members.get(id);
        const member = s.members.update(id, c.req.valid("json"));
        // A change of access reaches the member's open connections at once: they close (its
        // live updates, transcripts and terminals too) and reconnect with the new role, or not
        // at all when it was disabled. Nobody else's connections close, nor this request's.
        if (accessChanged(before, member)) {
          ctx.network.dropConnections({ memberId: id }, requestSocket(c));
        }
        return c.json(detail(ctx, id, callerOf(c).sessionId ?? null));
      })
      .delete("/:id", (c) => {
        const id = c.req.param("id");
        s.members.get(id);
        if (id === OWNER_MEMBER_ID)
          throw forbidden("The first owner can't be deleted.", "owner_locked");
        // Devices first: nothing may stay signed in as a member that is gone.
        ctx.auth.cutOff(id, requestSocket(c));
        s.members.delete(id);
        return c.json({ ok: true as const });
      })
      // Settings › Members › Add agent (§C.1): the token is shown once.
      .post("/agents", jsonBody(CreateAgentRequest), (c) => {
        const body: CreateAgentResponse = s.members.addAgent(
          c.req.valid("json"),
          callerOf(c).member.id,
        );
        return c.json(body);
      })
      .post("/:id/tokens", (c) => {
        const id = c.req.param("id");
        const token = s.members.mintToken(id);
        const body: MintTokenResponse = { token, member: detail(ctx, id, null) };
        return c.json(body);
      })
      .delete("/:id/tokens/:tokenId", (c) => {
        const id = c.req.param("id");
        const tokenId = c.req.param("tokenId");
        s.members.revokeToken(id, tokenId);
        // Its open connections (an MCP stream, a WebSocket) close too.
        ctx.network.dropConnections({ tokenId }, requestSocket(c));
        return c.json(detail(ctx, id, null));
      })
      .delete("/:id/devices/:deviceId", (c) => {
        const id = c.req.param("id");
        const device = ctx.auth.devices(id, null).find((d) => d.id === c.req.param("deviceId"));
        if (!device) throw notFound("No such device");
        ctx.network.revoke(device.id, requestSocket(c));
        return c.json(detail(ctx, id, callerOf(c).sessionId ?? null));
      })
  );
}
