import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppServices } from "../services/container";
import { type AuthTarget, authorize, ownsEverything, roleFor } from "./authorize";
import { principalOf } from "./principal";
import { type EntityKind, ROUTE_RULES, type RouteRule, type Scope } from "./route-rules";
import { filterResponse, projectOfEntity } from "./visibility";

/** Where the API is mounted; route patterns in `ROUTE_RULES` are relative to it. */
const API_PREFIX = "/api";

/** The pattern (`GET /sessions/:id`) of the route that will answer this request, if any. */
export function routeKeyOf(c: Context): { key: string; pattern: string } | undefined {
  // The first route that isn't middleware is the one that answers (as Hono runs them in order).
  const route = matchedRoutes(c).find((r) => r.method !== "ALL" && r.path.startsWith(API_PREFIX));
  if (!route) return undefined;
  const pattern = route.path.slice(API_PREFIX.length) || "/";
  return { key: `${route.method} ${pattern}`, pattern };
}

/** Path parameters of `pattern` in `path` (both relative to `/api`). */
function paramsOf(pattern: string, path: string): Record<string, string> {
  const names = pattern.split("/");
  const values = path.split("/");
  const params: Record<string, string> = {};
  names.forEach((name, i) => {
    if (name.startsWith(":") && values[i] !== undefined) {
      params[name.slice(1)] = decodeURIComponent(values[i] as string);
    }
  });
  return params;
}

/** The target a rule's scope names for this request. */
async function targetOf(
  s: AppServices,
  c: Context,
  scope: Scope,
  params: Record<string, string>,
): Promise<AuthTarget> {
  if (scope === "server") return { kind: "server" };
  if (scope === "global") return { kind: "global" };
  if ("param" in scope) {
    const id = params[scope.param];
    return { kind: "project", projectId: id ? projectOfEntity(s, scope.entity, id) : null };
  }
  if ("body" in scope) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null;
    const value = body?.[scope.body];
    if (typeof value !== "string") return { kind: "global" };
    return {
      kind: "project",
      projectId: scope.body === "projectId" ? value : projectOfEntity(s, "session", value),
    };
  }
  for (const name of scope.query) {
    const value = c.req.query(name);
    if (value) {
      const entity = name === "projectId" ? "project" : "session";
      return { kind: "project", projectId: projectOfEntity(s, entity, value) };
    }
  }
  return { kind: "global" };
}

/**
 * Does the entity a path parameter names exist? For a member with a hidden project, a missing
 * one is refused as "not found", like one in the hidden project, so the two can't be told apart.
 * Kinds without a cheap lookup count as existing.
 */
function entityExists(s: AppServices, entity: EntityKind, id: string): boolean {
  try {
    switch (entity) {
      case "project":
        return s.projects.list({ includeArchived: true }).some((p) => p.id === id);
      case "session":
        return s.sessionRepo.find(id) !== undefined;
      case "inbox":
        return s.inbox.find(id) !== undefined;
      case "automation":
        return s.automations.definitions.find(id) !== undefined;
      case "run":
        return s.automations.runs.find(id) !== undefined;
      case "conflict":
        s.orchestration.conflicts.get(id);
        return true;
      case "artifact":
        s.artifacts.get(id);
        return true;
      case "pr":
        return true;
    }
  } catch {
    return false;
  }
}

function deny(c: Context, status: 401 | 403 | 404, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/**
 * Role checks for every `/api` route (§B.3), from the one table in `route-rules.ts`. Owners of
 * everything (every single-user install) pass straight through, unchanged. For everyone else the
 * route's rule is looked up by the route Hono matched; a route with no rule is refused.
 */
export function routeGate(s: AppServices): MiddlewareHandler {
  const ctx = { projectIds: () => s.projects.list({ includeArchived: true }).map((p) => p.id) };
  return async (c, next) => {
    const principal = principalOf(c);
    const route = routeKeyOf(c);
    const rule: RouteRule | undefined = route ? ROUTE_RULES[route.key] : undefined;
    if (rule?.need === "public") return next();
    // Only public paths get past the security middleware without a principal.
    if (!principal) return deny(c, 401, "unauthorized", "Sign in first.");
    if (ownsEverything(principal.member)) return next();
    if (!route) return next(); // no route: Hono answers 404
    if (!rule) return deny(c, 403, "forbidden", "Only owners can use this.");
    if (rule.need !== "member") {
      const params = paramsOf(route.pattern, c.req.path.slice(API_PREFIX.length));
      const target = await targetOf(s, c, rule.scope ?? "server", params);
      const decision = authorize(principal, rule.need, target, ctx);
      if (!decision.ok) {
        const scope = rule.scope;
        const id = scope && typeof scope === "object" && "param" in scope && params[scope.param];
        // For a member with a hidden project, a missing entity answers like a hidden one.
        const hides = roleFor(principal.member, { kind: "global" }, ctx) === "none";
        if (decision.status === 403 && hides && id && !entityExists(s, scope.entity, id)) {
          return deny(c, 404, "not_found", "Not found");
        }
        return deny(c, decision.status, decision.code, decision.message);
      }
    }
    await next();
    if (rule.filter && c.res.ok) {
      c.res = await filterResponse(s, principal.member, rule.filter, c.res, ctx);
    }
  };
}
