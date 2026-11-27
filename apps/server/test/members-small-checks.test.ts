import type { RoleSessionResponse, Session } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Credential,
  jsonInit,
  type MembersEnv,
  startMembersEnv,
  TEAM_ORIGIN,
} from "./support/members-env";

/** Smaller checks on a team's server: what is refused first, and with which answer. */
let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function orchestratorOf(e: MembersEnv, as: Credential): Promise<Session> {
  const res = await e.remote("/api/orchestration/orchestrator", { ...jsonInit("POST", {}), as });
  return ((await res.json()) as RoleSessionResponse).session as Session;
}

describe("refusals on a team's server", () => {
  it("answers Start fresh on someone else's orchestrator as if it didn't exist", async () => {
    const e = await startMembersEnv();
    env = e;
    const otto = await e.join(await e.invite("operator"), "Otto");
    const wanda = await e.join(await e.invite("owner"), "Wanda");
    const wandas = await orchestratorOf(e, wanda);
    await orchestratorOf(e, otto);
    const res = await e.remote("/api/orchestration/orchestrator/start-fresh", {
      ...jsonInit("POST", { sessionId: wandas.id }),
      as: otto,
    });
    expect(res.status).toBe(404);
  });

  it("refuses a connected agent a pairing code before reading the request", async () => {
    const e = await startMembersEnv();
    env = e;
    const bot = await e.agent({ name: "ci-bot", role: "operator" });
    const res = await e.remote("/api/machines/connect-codes", {
      ...jsonInit("POST", { serverUrl: "not a url" }),
      as: bot.as,
    });
    expect(res.status).toBe(403);
  });

  it("names only the server's own addresses in a pairing command", async () => {
    const e = await startMembersEnv();
    env = e;
    const otto = await e.join(await e.invite("operator"), "Otto");
    const code = (serverUrl: string) =>
      e.remote("/api/machines/connect-codes", { ...jsonInit("POST", { serverUrl }), as: otto });
    const elsewhere = await code("https://attacker.example.net");
    expect(elsewhere.status).toBe(400);
    expect(((await elsewhere.json()) as { error: { code: string } }).error.code).toBe(
      "unknown_server_address",
    );
    expect((await code(TEAM_ORIGIN)).status).toBe(201);
  });

  it("refuses names that differ only in spaces or punctuation", async () => {
    const e = await startMembersEnv();
    env = e;
    await e.join(await e.invite("viewer"), "Sam");
    for (const name of ["S am", "Sam."]) {
      const res = await e.remote("/api/auth/join", {
        ...jsonInit("POST", {
          secret: await e.invite("viewer"),
          name,
          password: "harbor-violet-lantern-quiet-mesa",
        }),
      });
      expect(res.status, name).toBe(409);
    }
  });
});
