import {
  type InboxCounts,
  type InboxItem,
  type Member,
  type Project,
  parseGithubPrId,
  type Session,
  type Snapshot,
  type TranscriptSearchResponse,
} from "@codeden/contracts";
import type { AppServices } from "../services/container";
import { type AuthorizeContext, canSee } from "./authorize";
import { type Privacy, privacyFor } from "./privacy";
import type { EntityKind, ResponseFilter } from "./route-rules";

/**
 * The project an entity belongs to, for role checks (§B.3); null for work outside any project
 * (the orchestrator) and for entities that don't exist (the route answers 404 itself, and the
 * check falls back to the member's role across projects).
 */
export function projectOfEntity(s: AppServices, entity: EntityKind, id: string): string | null {
  try {
    switch (entity) {
      case "project":
        return id;
      case "session":
        return s.sessionRepo.find(id)?.session.projectId ?? null;
      case "inbox": {
        const item = s.inbox.find(id);
        if (!item) return null;
        if (item.projectId) return item.projectId;
        return item.sessionId ? projectOfEntity(s, "session", item.sessionId) : null;
      }
      case "automation": {
        const target = s.automations.definitions.find(id)?.target;
        return target?.type === "project" ? target.projectId : null;
      }
      case "run":
        return s.automations.runs.find(id)?.projectId ?? null;
      case "pr":
        return parseGithubPrId(id)?.projectId ?? null;
      case "conflict":
        return s.orchestration.conflicts.get(id).projectId;
      case "artifact": {
        const artifact = s.artifacts.get(id);
        if (artifact.projectId) return artifact.projectId;
        return artifact.sessionId ? projectOfEntity(s, "session", artifact.sessionId) : null;
      }
    }
  } catch {
    return null;
  }
}

/** The session an entity is about, if any (someone else's orchestrator is private, §D.1). */
export function sessionOfEntity(s: AppServices, entity: EntityKind, id: string): string | null {
  try {
    switch (entity) {
      case "session":
        return id;
      case "inbox":
        return s.inbox.find(id)?.sessionId ?? null;
      case "artifact":
        return s.artifacts.get(id).sessionId ?? null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * A session as the member sees it: in a project they can see (the orchestrator's are outside
 * any), and not someone else's orchestrator (§D.1).
 */
function sessionVisible(
  member: Member,
  session: Session,
  ctx: AuthorizeContext,
  privacy: Privacy,
): boolean {
  return !privacy.hidden.has(session.id) && canSee(member, session.projectId, ctx);
}

function inboxVisible(
  member: Member,
  item: InboxItem,
  ctx: AuthorizeContext,
  sessionProject: (id: string) => string | null,
  privacy: Privacy,
): boolean {
  if (item.sessionId && privacy.hidden.has(item.sessionId)) return false;
  const projectId = item.projectId ?? (item.sessionId ? sessionProject(item.sessionId) : null);
  return canSee(member, projectId, ctx);
}

/**
 * The snapshot cut down to the projects the member can see, without other people's
 * orchestrators; `orchestrator` is the member's own (§D.1).
 */
export function filterSnapshot(
  snapshot: Snapshot,
  member: Member,
  ctx: AuthorizeContext,
  privacy: Privacy = { hidden: new Set() },
  orchestrator: string | null = snapshot.roleSessions?.orchestrator ?? null,
): Snapshot {
  const projects = snapshot.projects.filter((p) => canSee(member, p.id, ctx));
  const visible = new Set(projects.map((p) => p.id));
  const sessions = snapshot.sessions.filter((x) => sessionVisible(member, x, ctx, privacy));
  const sessionProject = new Map(sessions.map((x) => [x.id, x.projectId]));
  return {
    ...snapshot,
    projects,
    sessions,
    archivedSessionCounts: Object.fromEntries(
      Object.entries(snapshot.archivedSessionCounts).filter(([id]) => visible.has(id)),
    ),
    inbox: snapshot.inbox.filter((i) =>
      inboxVisible(member, i, ctx, (id) => sessionProject.get(id) ?? null, privacy),
    ),
    automations: snapshot.automations.filter((a) =>
      canSee(member, a.target.type === "project" ? a.target.projectId : null, ctx),
    ),
    scheduled: snapshot.scheduled.filter((r) => canSee(member, r.projectId ?? null, ctx)),
    roleSessions: snapshot.roleSessions
      ? {
          ...snapshot.roleSessions,
          orchestrator: orchestrator && !privacy.hidden.has(orchestrator) ? orchestrator : null,
          pms: Object.fromEntries(
            Object.entries(snapshot.roleSessions.pms).filter(([id]) => visible.has(id)),
          ),
        }
      : undefined,
  };
}

/** Rewrite a JSON response for a member who can't see every project. */
export async function filterResponse(
  s: AppServices,
  member: Member,
  filter: ResponseFilter,
  res: Response,
  ctx: AuthorizeContext,
): Promise<Response> {
  const body = (await res.clone().json()) as unknown;
  const sessionProject = (id: string) => projectOfEntity(s, "session", id);
  const privacy = privacyFor(s.db, member);
  let next: unknown;
  switch (filter) {
    case "snapshot": {
      const own = member.kind === "agent" ? null : s.orchestration.roles.refs(member.id);
      next = filterSnapshot(body as Snapshot, member, ctx, privacy, own?.orchestrator ?? null);
      break;
    }
    case "projects":
      next = (body as Project[]).filter((p) => canSee(member, p.id, ctx));
      break;
    case "sessions":
      next = (body as Session[]).filter((x) => sessionVisible(member, x, ctx, privacy));
      break;
    case "inbox":
      next = (body as InboxItem[]).filter((i) =>
        inboxVisible(member, i, ctx, sessionProject, privacy),
      );
      break;
    case "inboxCounts": {
      const open = s.inbox
        .list()
        .filter((i) => inboxVisible(member, i, ctx, sessionProject, privacy));
      const counts: InboxCounts = { open: open.length, byProject: {}, byKind: {} };
      for (const item of open) {
        if (item.projectId)
          counts.byProject[item.projectId] = (counts.byProject[item.projectId] ?? 0) + 1;
        counts.byKind[item.kind] = (counts.byKind[item.kind] ?? 0) + 1;
      }
      next = counts;
      break;
    }
    case "search": {
      const search = body as TranscriptSearchResponse;
      next = {
        ...search,
        hits: search.hits.filter(
          (h) =>
            !privacy.hidden.has(h.sessionId) && canSee(member, sessionProject(h.sessionId), ctx),
        ),
      };
      break;
    }
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(next), { status: res.status, headers });
}
