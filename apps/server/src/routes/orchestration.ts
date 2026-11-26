import {
  ListConflictsQuery,
  ListNoticesQuery,
  ResolveConflictRequest,
  RoleMessageRequest,
  type RoleMessageResponse,
  type RoleSessionResponse,
  StartFreshRoleRequest,
  type StartFreshRoleResponse,
} from "@codeden/contracts";
import { type Context, Hono } from "hono";
import { canSee } from "../members/authorize";
import { principalOf } from "../members/principal";
import { authorizeContext } from "../members/sockets";
import type { AppServices } from "../services/container";
import { forbidden } from "../services/errors";
import { personKey } from "../services/orchestration/role-keys";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/orchestration`: the orchestrator and PM chats (§8.1) and their "Start fresh", notices,
 * digests. Messages go through the same path as wakes, so every one carries a fresh status digest.
 */
export function orchestrationRoutes(s: AppServices) {
  const o = s.orchestration;
  /**
   * The caller's own orchestrator (§D.1): every person has one, and only they reach it.
   * Connected agents have none (they message PMs directly); `read` answers them with nothing.
   */
  const personOf = (c: Context, read = false): string | null => {
    const member = principalOf(c)?.member;
    if (member?.kind === "agent") {
      if (read) return AGENT_HAS_NONE;
      throw forbidden(
        "Connected agents have no orchestrator: message a project's PM instead.",
        "no_orchestrator",
      );
    }
    return personKey(member?.id);
  };
  const pmSession = (projectId: string): RoleSessionResponse => {
    s.projects.get(projectId);
    return { session: o.roles.find("pm", projectId) ?? null };
  };
  // "Start fresh" (§8.1): the person's action only; no MCP tool reaches it.
  const startFresh = async (
    role: "orchestrator" | "pm",
    projectId: string | null,
    sessionId: string,
  ): Promise<StartFreshRoleResponse> => {
    const { session, archived } = await o.roles.startFresh(role, projectId, sessionId);
    return { session, archivedSessionId: archived.id };
  };
  return (
    new Hono()
      .get("/orchestrator", (c) =>
        c.json<RoleSessionResponse>({
          session: o.roles.find("orchestrator", personOf(c, true)) ?? null,
        }),
      )
      .post("/orchestrator", async (c) =>
        c.json<RoleSessionResponse>({ session: await o.roles.ensure("orchestrator", personOf(c)) }),
      )
      .post("/orchestrator/messages", jsonBody(RoleMessageRequest), async (c) => {
        const { input, whenBusy } = c.req.valid("json");
        const body: RoleMessageResponse = await o.sendToRole(
          "orchestrator",
          personOf(c),
          input,
          whenBusy,
        );
        return c.json(body);
      })
      .post("/orchestrator/start-fresh", jsonBody(StartFreshRoleRequest), async (c) =>
        c.json(await startFresh("orchestrator", personOf(c), c.req.valid("json").sessionId)),
      )
      .get("/projects/:projectId/pm", (c) => c.json(pmSession(c.req.param("projectId"))))
      .post("/projects/:projectId/pm", async (c) => {
        const projectId = c.req.param("projectId");
        s.projects.get(projectId);
        return c.json<RoleSessionResponse>({ session: await o.roles.ensure("pm", projectId) });
      })
      .post("/projects/:projectId/pm/messages", jsonBody(RoleMessageRequest), async (c) => {
        const projectId = c.req.param("projectId");
        s.projects.get(projectId);
        const { input, whenBusy } = c.req.valid("json");
        const body: RoleMessageResponse = await o.sendToRole("pm", projectId, input, whenBusy);
        return c.json(body);
      })
      .post("/projects/:projectId/pm/start-fresh", jsonBody(StartFreshRoleRequest), async (c) => {
        const projectId = c.req.param("projectId");
        s.projects.get(projectId);
        return c.json(await startFresh("pm", projectId, c.req.valid("json").sessionId));
      })
      .get("/projects/:projectId/status", (c) => c.json(o.projectStatus(c.req.param("projectId"))))
      .get("/overview", (c) => {
        const member = principalOf(c)?.member;
        const visible = member
          ? (id: string) => canSee(member, id, authorizeContext(s))
          : undefined;
        return c.json(o.overview(visible, personKey(member?.id)));
      })
      .get("/roles", (c) => c.json(o.roles.refs(personKey(principalOf(c)?.member.id))))
      // Notices for orchestrators are their person's alone (§D.1).
      .get("/notices", queryOf(ListNoticesQuery), (c) => {
        const mine = personKey(principalOf(c)?.member.id);
        return c.json(
          o.notices
            .list(c.req.valid("query"))
            .filter((n) => n.target !== "orchestrator" || personKey(n.memberId) === mine),
        );
      })
  );
}

/** A person key no orchestrator has: what a connected agent's lookup finds (nothing). */
const AGENT_HAS_NONE = "(connected agent)";

/** `/api/conflicts`: persisted conflicts (§8.4) and their wait/skip/join/force resolution. */
export function conflictRoutes(s: AppServices) {
  const conflicts = s.orchestration.conflicts;
  return new Hono()
    .get("/", queryOf(ListConflictsQuery), (c) => c.json(conflicts.list(c.req.valid("query"))))
    .get("/:id", (c) => c.json(conflicts.get(c.req.param("id"))))
    .post("/:id/resolve", jsonBody(ResolveConflictRequest), async (c) =>
      c.json(await conflicts.resolve(c.req.param("id"), c.req.valid("json"))),
    );
}
