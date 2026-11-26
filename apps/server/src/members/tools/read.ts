import {
  type ItemRecord,
  memberRoleOn,
  type Session,
  SessionStatus,
  type SessionStatus as Status,
} from "@codeden/contracts";
import { z } from "zod";
import { compactSession } from "../../mcp/tools/shared/helpers";
import { lastAssistantMessage, questionItem } from "../../mcp/tools/shared/session-items";
import type { AppServices } from "../../services/container";
import { sessionSnapshot } from "../../services/sessions/snapshot";
import { canSee } from "../authorize";
import { authorizeContext } from "../sockets";
import { projectOfEntity } from "../visibility";
import { defineMemberTool, type MemberToolContext } from "./define";

/** Characters of each transcript entry `get_session` returns. */
const ENTRY_LIMIT = 2_000;
/** Most transcript entries `get_session` returns. */
const RECENT_ITEMS = 30;

const project = (projectId: string) => ({ kind: "project" as const, projectId });
const ofSession = (s: AppServices, sessionId: string) => ({
  kind: "project" as const,
  projectId: projectOfEntity(s, "session", sessionId),
});

function visible(ctx: MemberToolContext, projectId: string | null): boolean {
  return canSee(ctx.principal.member, projectId, authorizeContext(ctx.services));
}

/** A transcript entry as an agent reads it: who, and the text (tools by their title). */
function entry(record: ItemRecord): { kind: string; text: string } | null {
  const item = record.item;
  const cut = (text: string) =>
    text.length > ENTRY_LIMIT ? `${text.slice(0, ENTRY_LIMIT)}…` : text;
  switch (item.kind) {
    case "user_message":
      return { kind: item.input.from ?? "user", text: cut(item.input.text) };
    case "assistant_message":
      return item.text.trim() ? { kind: "assistant", text: cut(item.text) } : null;
    case "tool_call":
      return { kind: "tool", text: cut(item.title ?? item.toolName) };
    case "approval_request":
      return { kind: "approval", text: cut(item.title) };
    case "user_question":
      return { kind: "question", text: cut(item.questions.map((q) => q.question).join("\n")) };
    default:
      return null;
  }
}

export const listProjects = defineMemberTool({
  name: "list_projects",
  description:
    "The projects you can see on this CodeDen server, with your role on each (viewer, operator or owner).",
  input: z.object({}),
  need: "viewer",
  target: () => null,
  handler: async (_input, ctx) =>
    ctx.services.projects
      .list()
      .filter((p) => visible(ctx, p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        kind: p.kind,
        role: memberRoleOn(ctx.principal.member, p.id),
      })),
});

export const getProjectStatus = defineMemberTool({
  name: "get_project_status",
  description:
    "A project's status: its sessions in play, what waits on people, recent results and the factory's state.",
  input: z.object({ projectId: z.string().min(1) }),
  need: "viewer",
  target: (input) => project(input.projectId),
  handler: async ({ projectId }, { services }) => services.orchestration.projectStatus(projectId),
});

export const listSessions = defineMemberTool({
  name: "list_sessions",
  description:
    "Sessions on the projects you can see, newest first. Filter by project and status (e.g. running, waiting, idle, completed, failed, stopped).",
  input: z.object({
    projectId: z.string().min(1).optional(),
    status: z.array(SessionStatus).optional(),
    limit: z.int().min(1).max(100).optional(),
  }),
  need: "viewer",
  target: (input) => (input.projectId ? project(input.projectId) : null),
  handler: async (input, ctx) =>
    ctx.services.sessionRepo
      .list({ projectId: input.projectId, status: input.status })
      .filter((s) => visible(ctx, s.projectId))
      .slice(0, input.limit ?? 20)
      .map(compactSession),
});

export const getSession = defineMemberTool({
  name: "get_session",
  description:
    "One session in detail: status, progress and result, the questions and approvals it waits on (with inbox ids for answer_question and answer_approval), and its recent transcript.",
  input: z.object({ sessionId: z.string().min(1) }),
  need: "viewer",
  target: (input, s) => ofSession(s, input.sessionId),
  handler: async ({ sessionId }, { services }) => {
    const session = services.sessionRepo.get(sessionId);
    const snapshot = sessionSnapshot(services, sessionId, { turns: 3 });
    const waitingOn = services.inbox
      .list({ sessionId, status: "open" })
      .filter((i) => i.kind === "question" || i.kind === "approval")
      .map((i) => {
        const asked = i.requestId ? questionItem(services.db, sessionId, i.requestId) : undefined;
        return {
          inboxItemId: i.id,
          kind: i.kind,
          title: i.title,
          body: i.body,
          ...(asked
            ? {
                questions: asked.questions.map((q) => ({
                  id: q.id,
                  question: q.question,
                  options: q.options.map((o) => o.label),
                })),
              }
            : {}),
        };
      });
    const transcript = snapshot.items
      .filter((r) => r.threadId === session.rootThreadId)
      .flatMap((r) => entry(r) ?? [])
      .slice(-RECENT_ITEMS);
    return {
      session: compactSession(session),
      lastMessage: lastAssistantMessage(services.db, session),
      waitingOn,
      transcript,
    };
  },
});

export const getDiff = defineMemberTool({
  name: "get_diff",
  description:
    "The code changes a session made (every changed file with its patch), or only what isn't committed yet.",
  input: z.object({
    sessionId: z.string().min(1),
    uncommitted: z.boolean().optional(),
  }),
  need: "viewer",
  target: (input, s) => ofSession(s, input.sessionId),
  handler: async ({ sessionId, uncommitted }, { services }) => {
    const diff = await services.workbench.diff(sessionId, {
      kind: uncommitted ? "uncommitted" : "session",
    });
    return { scope: diff.scope, files: diff.files };
  },
});

export const listInbox = defineMemberTool({
  name: "list_inbox",
  description:
    "Open inbox items on the projects you can see: questions and approvals agents wait on, PRs to review, failed runs.",
  input: z.object({ projectId: z.string().min(1).optional() }),
  need: "viewer",
  target: (input) => (input.projectId ? project(input.projectId) : null),
  handler: async ({ projectId }, ctx) =>
    ctx.services.inbox
      .list({ status: "open", ...(projectId ? { projectId } : {}) })
      .filter((i) =>
        visible(
          ctx,
          i.projectId ??
            (i.sessionId ? projectOfEntity(ctx.services, "session", i.sessionId) : null),
        ),
      )
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        body: i.body,
        projectId: i.projectId,
        sessionId: i.sessionId,
        createdAt: i.createdAt,
      })),
});

/** Statuses `wait_for_session` stops at: the session needs someone, or its turn is over. */
const SETTLED: ReadonlySet<Status> = new Set(["idle", "waiting", "completed", "failed", "stopped"]);

/** Longest `wait_for_session` deadline. */
export const WAIT_MAX_SEC = 300;

export const waitForSession = defineMemberTool({
  name: "wait_for_session",
  description: `Wait until a session is idle, finished, or needs input (a question or approval), or until the deadline (timeoutSec, at most ${WAIT_MAX_SEC}, default 60). Returns the session's status and, once it settled, its last reply (lastMessage); call get_session for questions, approvals and the transcript. Use it to hand off work and come back.`,
  input: z.object({
    sessionId: z.string().min(1),
    timeoutSec: z.int().min(1).max(WAIT_MAX_SEC).optional(),
  }),
  need: "viewer",
  target: (input, s) => ofSession(s, input.sessionId),
  handler: async ({ sessionId, timeoutSec }, { services, signal }) => {
    const current = () => services.sessionRepo.get(sessionId);
    const done = (s: Session) => SETTLED.has(s.status);
    const answer = (s: Session, timedOut: boolean) => ({
      ...compactSession(s),
      timedOut,
      lastMessage: done(s) ? lastAssistantMessage(services.db, s) : null,
    });
    if (done(current())) return answer(current(), false);
    return new Promise((resolve) => {
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        resolve(answer(current(), timedOut));
      };
      const onAbort = () => finish(true);
      const unsubscribe = services.store.subscribe((events) => {
        if (events.some((e) => e.sessionId === sessionId) && done(current())) finish(false);
      });
      const timer = setTimeout(() => finish(true), (timeoutSec ?? 60) * 1000);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
});
