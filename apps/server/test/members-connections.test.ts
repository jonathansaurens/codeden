import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { closesWithin, connectAs } from "./support/member-sockets";
import {
  type Credential,
  jsonInit,
  type MembersEnv,
  seedProjects,
  startMembersEnv,
} from "./support/members-env";

let env: MembersEnv | undefined;
const open: WebSocket[] = [];
afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await env?.close();
  env = undefined;
});

const connect = (e: MembersEnv, path: string, as: Credential) => connectAs(e, path, as, open);

async function joined(
  e: MembersEnv,
  name: string,
  role: "viewer" | "operator",
  projectRoles: Record<string, string> = {},
): Promise<Credential> {
  return e.join(await e.invite(role, { projectRoles } as never), name);
}

describe("open connections follow access changes", () => {
  it("closes a member's sockets when its role changes, and nobody else's", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const ana = await joined(env, "Ana", "operator");
    const ben = await joined(env, "Ben", "operator");
    const anaWs = await connect(env, "/ws", ana);
    const benWs = await connect(env, "/ws", ben);
    expect([anaWs.status, benWs.status]).toEqual([101, 101]);
    const anaId = await idOf(env, "Ana");
    const res = await env.local(`/api/members/${anaId}`, jsonInit("PATCH", { role: "viewer" }));
    expect(res.status).toBe(200);
    expect(await closesWithin(anaWs.closed, 10_000)).toBe(true);
    expect(await closesWithin(benWs.closed, 200)).toBe(false);
    // A name change alters no access: nothing closes.
    const again = await connect(env, "/ws", ana);
    await env.local(`/api/members/${anaId}`, jsonInit("PATCH", { name: "Anna" }));
    expect(await closesWithin(again.closed, 200)).toBe(false);
  });

  it("closes only the disabled or deleted member's connections", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    const ana = await joined(env, "Ana", "viewer");
    const ben = await joined(env, "Ben", "viewer");
    const anaWs = await connect(env, "/ws", ana);
    const benWs = await connect(env, "/ws", ben);
    const anaId = await idOf(env, "Ana");
    await env.local(`/api/members/${anaId}`, jsonInit("PATCH", { disabled: true }));
    expect(await closesWithin(anaWs.closed, 10_000)).toBe(true);
    expect((await connect(env, "/ws", ana)).status).toBe(401);
    await env.local(`/api/members/${anaId}`, { method: "DELETE" });
    expect(await closesWithin(benWs.closed, 200)).toBe(false);
  });

  it("closes a device's connections when it is signed out, not the member's other devices", async () => {
    env = await startMembersEnv();
    const secret = await env.invite("viewer");
    const laptop = await env.join(secret, "Ana");
    const phoneRes = await env.remote(
      "/api/auth/sign-in",
      jsonInit("POST", { name: "Ana", password: "harbor-violet-lantern-quiet-mesa" }),
    );
    expect(phoneRes.status).toBe(200);
    const phone = { cookie: (phoneRes.headers.get("set-cookie") ?? "").split(";")[0] as string };
    const laptopWs = await connect(env, "/ws", laptop);
    const phoneWs = await connect(env, "/ws", phone);
    const anaId = await idOf(env, "Ana");
    const detail = (await (await env.local("/api/members")).json()) as {
      members: Array<{ member: { id: string }; devices: Array<{ id: string; createdAt: string }> }>;
    };
    const devices = detail.members.find((m) => m.member.id === anaId)?.devices ?? [];
    const first = [...devices].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    await env.local(`/api/members/${anaId}/devices/${first?.id}`, { method: "DELETE" });
    expect(await closesWithin(laptopWs.closed, 10_000)).toBe(true);
    expect(await closesWithin(phoneWs.closed, 200)).toBe(false);
  });
});

async function idOf(e: MembersEnv, name: string): Promise<string> {
  const body = (await (await e.local("/api/members/summaries")).json()) as {
    members: Array<{ id: string; name: string }>;
  };
  const found = body.members.find((m) => m.name === name);
  if (!found) throw new Error(`no member ${name}`);
  return found.id;
}
