import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CreateInviteRequest,
  FactoryLimits,
  type MemberRole,
  type NewEvent,
  Project,
} from "@codeden/contracts";
import { type RunningServer, startServer } from "../../src";
import { sampleSession } from "../helpers";
import { removeTree } from "./remove-tree";

/**
 * A real server (no runner) with network access on behind a trusted proxy origin, so requests
 * from "other devices" can be made in-process: they name the proxy's host from a loopback peer,
 * which the server always treats as remote (session cookie or agent token only, never the
 * install token). `local` calls carry the install token, as this machine's browser does.
 */
export const MEMBERS_TOKEN = "m".repeat(64);
export const TEAM_HOST = "team.example.com";
export const TEAM_ORIGIN = `https://${TEAM_HOST}`;
export const OWNER_PASSWORD = "maple-river-quiet-orbit-candle";
export const MEMBER_PASSWORD = "harbor-violet-lantern-quiet-mesa";

export interface MembersEnv {
  server: RunningServer;
  home: string;
  /** A request as this machine's browser (install token, unless `authorization` is given). */
  local(path: string, init?: RequestInit): Promise<Response>;
  /** A request from another device through the proxy; `as` is a cookie or an agent token. */
  remote(path: string, init?: RequestInit & { as?: Credential; from?: string }): Promise<Response>;
  /** An owner's invite secret. */
  invite(role: MemberRole, extra?: Partial<CreateInviteRequest>): Promise<string>;
  /** Join with an invite from another device; returns the session cookie. */
  join(secret: string, name: string): Promise<Credential>;
  /** Add a connected agent (as the owner); returns its id and bearer credential. */
  agent(req: Record<string, unknown>): Promise<{ id: string; as: Credential }>;
  close(): Promise<void>;
}

/** How a remote request authenticates: a device's session cookie or a connected agent's token. */
export type Credential = { cookie: string } | { bearer: string };

export const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function startMembersEnv(
  opts: { home?: string; agentRateLimit?: { burst: number; perMinute: number } } = {},
): Promise<MembersEnv> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "codeden-members-"));
  const server = await startServer({
    port: 0,
    dataDir: home,
    token: MEMBERS_TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    github: { sync: false },
    agentRateLimit: opts.agentRateLimit,
  });
  if (!server.network.store.passwordSet)
    await server.network.setPassword({ password: OWNER_PASSWORD });
  server.network.store.addTrustedOrigin(TEAM_ORIGIN);
  await server.network.update({ enabled: true, loopbackOnly: true });

  const request = (path: string, init: RequestInit, host: string, headers: Headers) =>
    Promise.resolve(
      server.app.request(
        `http://${host}${path}`,
        { ...init, headers },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
      ),
    );
  const env: MembersEnv = {
    server,
    home,
    local(path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set("host", `127.0.0.1:${server.port}`);
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${MEMBERS_TOKEN}`);
      return request(path, init, `127.0.0.1:${server.port}`, headers);
    },
    remote(path, init = {}) {
      const headers = new Headers(init.headers);
      headers.set("host", TEAM_HOST);
      headers.set("x-forwarded-for", init.from ?? "203.0.113.7");
      if (init.as && "cookie" in init.as) headers.set("cookie", init.as.cookie);
      if (init.as && "bearer" in init.as) headers.set("authorization", `Bearer ${init.as.bearer}`);
      return request(path, init, TEAM_HOST, headers);
    },
    async invite(role, extra = {}) {
      const res = await env.local("/api/members/invites", jsonInit("POST", { role, ...extra }));
      if (!res.ok) throw new Error(`invite failed: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { secret: string }).secret;
    },
    async join(secret, name) {
      const res = await env.remote(
        "/api/auth/join",
        jsonInit("POST", { secret, name, password: MEMBER_PASSWORD }),
      );
      if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`);
      return { cookie: cookieOf(res) };
    },
    async agent(req) {
      const res = await env.local("/api/members/agents", jsonInit("POST", req));
      if (!res.ok) throw new Error(`add agent failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { member: { id: string }; token: string };
      return { id: body.member.id, as: { bearer: body.token } };
    },
    async close() {
      await server.close();
      if (!opts.home) await removeTree(home);
    },
  };
  return env;
}

/** The `name=value` part of a response's session cookie. */
export function cookieOf(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

/** A local project record for role tests (no folder or git needed). */
export function projectFixture(id: string): Project {
  const at = "2026-11-01T09:00:00.000Z";
  return Project.parse({
    id,
    kind: "local",
    name: id,
    slug: id,
    path: join(tmpdir(), `codeden-members-${id}`),
    defaultBranch: "main",
    defaultProvider: "fake",
    defaultModel: null,
    defaultEffort: null,
    autonomy: null,
    autonomyMode: "assisted",
    visionPath: ".codeden/VISION.md",
    factoryLimits: FactoryLimits.parse({}),
    killSwitch: false,
    timezone: null,
    agentCiEnv: true,
    execution: { backend: "local" },
    pinned: false,
    sortOrder: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
  });
}

/** Projects and one idle agent session in each (`s-<project>`), straight into the event log. */
export function seedProjects(server: RunningServer, ids: string[]): void {
  server.store.append(
    ids.flatMap((id): NewEvent[] => [
      { type: "project.created", sessionId: null, payload: { project: projectFixture(id) } },
      {
        type: "session.created",
        sessionId: `s-${id}`,
        payload: { session: { ...sampleSession, id: `s-${id}`, projectId: id, status: "idle" } },
      },
    ]),
  );
}
