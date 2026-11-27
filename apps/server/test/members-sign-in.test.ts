import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MembersResponse, MeResponse } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { memberInvites } from "../src/db/schema";
import { hashPassword } from "../src/network/password";
import {
  cookieOf,
  jsonInit,
  MEMBER_PASSWORD,
  type MembersEnv,
  OWNER_PASSWORD,
  startMembersEnv,
} from "./support/members-env";
import { removeTree } from "./support/remove-tree";

let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const me = async (res: Response) => (await res.json()) as MeResponse;

describe("members: the first owner, invites and sign-in", () => {
  it("migrates a password install: its devices stay signed in as the owner", async () => {
    // An install from before members: a password and a signed-in phone, no member rows.
    const home = mkdtempSync(join(tmpdir(), "codeden-members-migrate-"));
    const deviceToken = `cds_${"p".repeat(43)}`;
    writeFileSync(
      join(home, "remote-access.json"),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        password: { hash: await hashPassword(OWNER_PASSWORD), setAt: "2026-11-01T09:00:00.000Z" },
        sessions: [
          {
            id: "old-phone",
            tokenHash: createHash("sha256").update(deviceToken).digest("hex"),
            label: "Mozilla/5.0 (iPhone)",
            address: "192.168.1.30",
            createdAt: "2026-11-20T09:00:00.000Z",
            lastSeenAt: "2026-11-20T09:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
        trustedOrigins: [],
      }),
    );
    try {
      env = await startMembersEnv({ home });
      const cookie = `codeden_session_${env.server.port}=${deviceToken}`;
      const res = await env.remote("/api/members/me", { as: { cookie } });
      expect(res.status).toBe(200);
      const body = await me(res);
      expect(body.member).toMatchObject({ id: "owner", role: "owner", kind: "person" });
      expect(body.team).toBe(false);
      // The old password still signs the owner in, with no name.
      const signIn = await env.remote(
        "/api/auth/sign-in",
        jsonInit("POST", { password: OWNER_PASSWORD }),
      );
      expect(signIn.status).toBe(200);
      const again = await env.remote("/api/members/me", { as: { cookie: cookieOf(signIn) } });
      expect((await me(again)).member.id).toBe("owner");
    } finally {
      await env?.close();
      env = undefined;
      await removeTree(home);
    }
  });

  it("acts as the owner with the install token, and writes nothing on a single-user install", async () => {
    env = await startMembersEnv();
    const before = env.server.store.headSeq();
    const body = await me(await env.local("/api/members/me"));
    expect(body.member.id).toBe("owner");
    expect(body.globalRole).toBe("owner");
    expect(env.server.store.headSeq()).toBe(before);
  });

  it("joins with an invite once, then signs in by name", async () => {
    env = await startMembersEnv();
    const secret = await env.invite("operator", { note: "Ana" });
    const check = await env.remote("/api/auth/invite", jsonInit("POST", { secret }));
    expect(await check.json()).toMatchObject({ role: "operator", ownerName: "Owner" });

    const cookie = await env.join(secret, "Ana");
    const body = await me(await env.remote("/api/members/me", { as: cookie }));
    expect(body.member).toMatchObject({ name: "Ana", role: "operator", kind: "person" });
    expect(body.team).toBe(true);

    // Replay: the secret never works again, not even for another name.
    const replay = await env.remote(
      "/api/auth/join",
      jsonInit("POST", { secret, name: "Mallory", password: MEMBER_PASSWORD }),
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: "invalid_invite" } });

    const status = (await (await env.remote("/api/auth/status")).json()) as { askName: boolean };
    expect(status.askName).toBe(true);
    const byName = await env.remote(
      "/api/auth/sign-in",
      jsonInit("POST", { name: "ana", password: MEMBER_PASSWORD }),
    );
    expect(byName.status).toBe(200);
    expect(
      (await me(await env.remote("/api/members/me", { as: { cookie: cookieOf(byName) } }))).member
        .name,
    ).toBe("Ana");
    // Someone else's passphrase doesn't sign the owner in, nor the other way round.
    const wrong = await env.remote(
      "/api/auth/sign-in",
      jsonInit("POST", { name: "Ana", password: OWNER_PASSWORD }),
    );
    expect(wrong.status).toBe(401);
  });

  it("never resets the throttle on guesses at another member when one signs in", async () => {
    env = await startMembersEnv();
    await env.join(await env.invite("viewer"), "Ana");
    await env.join(await env.invite("viewer"), "Ben");
    const from = "198.51.100.40";
    const signIn = async (name: string, password: string) =>
      (
        await env?.remote("/api/auth/sign-in", {
          ...jsonInit("POST", { name, password }),
          from,
        })
      )?.status;
    const wrong = "orbit-candle-maple-river-quiet";
    // Mallory (here: Ana's own account) guesses at Ben's, signing in as herself in between.
    const statuses = [
      await signIn("Ben", wrong),
      await signIn("Ben", wrong),
      await signIn("Ana", MEMBER_PASSWORD),
      await signIn("Ben", wrong),
      await signIn("Ben", wrong),
    ];
    expect(statuses).toEqual([401, 401, 200, 401, 429]);
  });

  it("never resets the throttle on invite guesses when a valid invite is used", async () => {
    env = await startMembersEnv();
    const secret = await env.invite("viewer");
    const from = "198.51.100.41";
    const check = async (s: string) =>
      (await env?.remote("/api/auth/invite", { ...jsonInit("POST", { secret: s }), from }))?.status;
    const guess = `cdi_${"x".repeat(43)}`;
    const statuses = [await check(guess), await check(guess), await check(secret)];
    statuses.push(await check(guess), await check(guess));
    expect(statuses).toEqual([400, 400, 200, 400, 429]);
  });

  it("refuses expired and revoked invites", async () => {
    env = await startMembersEnv();
    const expired = await env.invite("viewer");
    env.server.database.db
      .update(memberInvites)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
      .run();
    const late = await env.remote(
      "/api/auth/join",
      jsonInit("POST", { secret: expired, name: "Late", password: MEMBER_PASSWORD }),
    );
    expect(late.status).toBe(400);

    const revoked = await env.invite("viewer");
    const list = (await (await env.local("/api/members")).json()) as MembersResponse;
    const open = list.invites.find(
      (i) => i.usedAt === null && Date.parse(i.expiresAt) > Date.now(),
    );
    await env.local(`/api/members/invites/${open?.id}`, { method: "DELETE" });
    const res = await env.remote(
      "/api/auth/join",
      jsonInit("POST", { secret: revoked, name: "Gone", password: MEMBER_PASSWORD }),
    );
    expect(res.status).toBe(400);
    // Nobody joined.
    const after = (await (await env.local("/api/members")).json()) as MembersResponse;
    expect(after.members.map((m) => m.member.name)).toEqual(["Owner"]);
  });

  it("refuses weak passphrases and taken names without using the invite", async () => {
    env = await startMembersEnv();
    const secret = await env.invite("viewer");
    const weak = await env.remote(
      "/api/auth/join",
      jsonInit("POST", { secret, name: "Ana", password: "password123" }),
    );
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({ error: { code: "invalid_request" } });
    const taken = await env.remote(
      "/api/auth/join",
      jsonInit("POST", { secret, name: "owner", password: MEMBER_PASSWORD }),
    );
    expect(taken.status).toBe(409);
    expect(await env.join(secret, "Ana")).toMatchObject({
      cookie: expect.stringContaining("codeden_session_"),
    });
  });

  it("refuses a disabled member's devices, and signs out a deleted member's", async () => {
    env = await startMembersEnv();
    const cookie = await env.join(await env.invite("viewer"), "Ana");
    const ana = (await me(await env.remote("/api/members/me", { as: cookie }))).member;

    await env.local(`/api/members/${ana.id}`, jsonInit("PATCH", { disabled: true }));
    expect((await env.remote("/api/members/me", { as: cookie })).status).toBe(401);
    const signIn = await env.remote(
      "/api/auth/sign-in",
      jsonInit("POST", { name: "Ana", password: MEMBER_PASSWORD }),
    );
    expect(signIn.status).toBe(401);

    await env.local(`/api/members/${ana.id}`, jsonInit("PATCH", { disabled: false }));
    expect((await env.remote("/api/members/me", { as: cookie })).status).toBe(200);

    await env.local(`/api/members/${ana.id}`, { method: "DELETE" });
    expect((await env.remote("/api/members/me", { as: cookie })).status).toBe(401);
    expect(env.server.network.store.liveSessions().filter((s) => s.memberId === ana.id)).toEqual(
      [],
    );
  });

  it("keeps the first owner an enabled owner", async () => {
    env = await startMembersEnv();
    expect(
      (await env.local("/api/members/owner", jsonInit("PATCH", { role: "viewer" }))).status,
    ).toBe(403);
    expect((await env.local("/api/members/owner", { method: "DELETE" })).status).toBe(403);
    const renamed = await env.local("/api/members/owner", jsonInit("PATCH", { name: "Leon" }));
    expect(renamed.status).toBe(200);
    expect((await me(await env.local("/api/members/me"))).member.name).toBe("Leon");
  });

  it("never accepts the install token from another device", async () => {
    env = await startMembersEnv();
    const res = await env.remote("/api/members/me", {
      headers: { authorization: `Bearer ${"m".repeat(64)}` },
    });
    expect(res.status).toBe(401);
  });
});
