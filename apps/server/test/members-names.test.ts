import { afterEach, describe, expect, it } from "vitest";
import { nameKey, nameProblem, normalizeName } from "../src/members/names";
import { jsonInit, MEMBER_PASSWORD, type MembersEnv, startMembersEnv } from "./support/members-env";

let env: MembersEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe("member names that look alike", () => {
  it("refuses invisible and formatting characters", () => {
    for (const name of [
      "Ana​", // zero-width space
      "A‍na", // zero-width joiner
      "‮anA", // right-to-left override
      "Ana⁦", // bidi isolate
      "An­a", // soft hyphen
      "Ana️", // variation selector
      "Anaㅤ", // a filler that shows blank
    ]) {
      expect(nameProblem(name), JSON.stringify(name)).toMatch(/invisible/);
    }
    expect(nameProblem("Ana María")).toBeNull();
    expect(nameProblem("Иван")).toBeNull();
    expect(nameProblem("李小龍")).toBeNull();
  });

  it("refuses names mixing Latin with Greek or Cyrillic letters", () => {
    expect(nameProblem("Аna")).toMatch(/mix/); // Cyrillic А, Latin "na"
    expect(nameProblem("Adοm")).toMatch(/mix/); // Greek ο
    expect(nameProblem("Ana 李")).toBeNull();
  });

  it("compares names as they look", () => {
    expect(nameKey("ＡＮＡ")).toBe(nameKey("ana")); // full-width forms
    expect(nameKey("Аре")).toBe(nameKey("Ape")); // all Cyrillic
    expect(nameKey("AIice")).toBe(nameKey("Alice"));
    expect(nameKey("B0b")).toBe(nameKey("Bob"));
    expect(nameKey("Ana  Maria")).toBe(nameKey("ana maria"));
    expect(nameKey("Ana")).not.toBe(nameKey("Anna"));
    expect(normalizeName("  ﬁona  ")).toBe("fiona");
  });

  it("keeps a look-alike name from joining or being given", async () => {
    env = await startMembersEnv();
    await env.join(await env.invite("viewer"), "Alice");
    const join = async (name: string) =>
      env?.remote(
        "/api/auth/join",
        jsonInit("POST", {
          secret: await env.invite("viewer"),
          name,
          password: MEMBER_PASSWORD,
        }),
      );
    expect((await join("AIice"))?.status).toBe(409);
    expect((await join("ＡＬＩＣＥ"))?.status).toBe(409);
    expect((await join("Alice​"))?.status).toBe(400);
    expect((await join("Аlice"))?.status).toBe(400);
    const bot = await env.local(
      "/api/members/agents",
      jsonInit("POST", { name: "A​lice", role: "viewer" }),
    );
    expect(bot.status).toBe(400);
    const renamed = await env.local("/api/members/owner", jsonInit("PATCH", { name: "a1ice" }));
    expect(renamed.status).toBe(409);
    // Signing in by name finds the member the same way.
    const signIn = await env.remote(
      "/api/auth/sign-in",
      jsonInit("POST", { name: "ALICE", password: MEMBER_PASSWORD }),
    );
    expect(signIn.status).toBe(200);
  });
});
