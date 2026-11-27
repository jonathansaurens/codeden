import { describe, expect, it } from "vitest";
import { ROUTE_RULES } from "../src/members/route-rules";
import { type ApiContext, createApi } from "../src/routes/api";

/** Services are only reached when a request runs; building the routes needs none of them. */
const inert: unknown = new Proxy(() => inert, { get: () => inert, apply: () => inert });

function registeredRoutes(): string[] {
  const api = createApi(inert as ApiContext);
  const keys = api.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
  return [...new Set(keys)];
}

describe("route classification (§B.3)", () => {
  it("classifies every HTTP route the API registers", () => {
    const missing = registeredRoutes().filter((key) => !(key in ROUTE_RULES));
    // A new route needs a line in members/route-rules.ts: who may call it, on what.
    expect(missing).toEqual([]);
  });

  it("lists no route that doesn't exist", () => {
    const registered = new Set(registeredRoutes());
    expect(Object.keys(ROUTE_RULES).filter((key) => !registered.has(key))).toEqual([]);
  });

  it("keeps administration with owners", () => {
    const ownerOnly = [
      "PATCH /settings",
      "PUT /secrets/:key",
      "PUT /network",
      "POST /network/password",
      "POST /members/invites",
      "PATCH /members/:id",
      "POST /projects",
      "DELETE /projects/:id",
      "POST /automations",
      "PUT /agent-config/mcp",
      "GET /fs/list",
      "POST /shutdown",
    ];
    for (const key of ownerOnly) expect(ROUTE_RULES[key]?.need, key).toBe("owner");
    const publicRoutes = Object.entries(ROUTE_RULES)
      .filter(([, rule]) => rule.need === "public")
      .map(([key]) => key);
    expect(publicRoutes.sort()).toEqual(
      [
        "GET /health",
        "GET /auth/status",
        "POST /auth/sign-in",
        "POST /auth/invite",
        "POST /auth/join",
        "POST /auth/sign-out",
      ].sort(),
    );
  });
});
