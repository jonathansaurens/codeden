import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { RUNNER_CONNECT_PATH } from "@codeden/contracts";
import { runnerConnectUrl } from "@codeden/runner/connect";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RunningServer, startServer } from "../src";
import { machineCredentials, runnerState } from "../src/db/schema";
import { type Exec, runTool } from "../src/services/exec";
import type { GitBroker } from "../src/services/git-broker";
import { type FakeComputer, fakeComputer, paired } from "./support/fake-computer";
import { waitUntil } from "./support/harness";
import { countEvents, storedReply } from "./support/link-turn";
import { cookieOf } from "./support/members-env";
import { removeTree } from "./support/remove-tree";

/**
 * Connecting your own computer (`docs/machines-teams-and-agents.md` §D.5), end to end: a pairing
 * code traded for a device key, a real runner process on the "computer" (a temp home here) linked
 * in over the server's `/api/runner-connect` WebSocket by `codeden connect`'s own link code, and
 * Fake-provider sessions placed on it. Other people reach the server through a trusted proxy
 * origin, in-process, as in the members suites.
 */

const TOKEN = "e".repeat(64);
const TEAM_HOST = "team.example.com";
const OWNER_PASSWORD = "maple-river-quiet-orbit-candle";
const MEMBER_PASSWORD = "harbor-violet-lantern-quiet-mesa";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const gitOnly: Exec = (command, args, opts) =>
  command === "git"
    ? runTool(command, args, opts)
    : Promise.resolve({
        code: null,
        stdout: "",
        stderr: "",
        notFound: true,
        timedOut: false,
        path: null,
      });

let base: string;
let bare: string;
let server: RunningServer;
let computer: FakeComputer;
let projectId: string;

// biome-ignore lint/suspicious/noExplicitAny: the tests read loose JSON answers
type Json = Record<string, any>;

/** A request from this machine's browser (the install token: the first owner). */
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** A request from another person's device, through the proxy. */
async function remote(cookie: string, method: string, path: string, body?: unknown) {
  const headers = new Headers({
    host: TEAM_HOST,
    "x-forwarded-for": "203.0.113.9",
    cookie,
    "content-type": "application/json",
  });
  const res = await server.app.request(
    `http://${TEAM_HOST}/api${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  return { status: res.status, body: (await res.json()) as Json };
}

/** Another person, an Operator everywhere, signed in on another device: their cookie. */
async function operator(name: string): Promise<{ id: string; cookie: string }> {
  const invite = await api("POST", "/members/invites", { role: "operator" });
  const res = await server.app.request(
    `http://${TEAM_HOST}/api/auth/join`,
    {
      method: "POST",
      headers: new Headers({
        host: TEAM_HOST,
        "x-forwarded-for": "203.0.113.9",
        "content-type": "application/json",
      }),
      body: JSON.stringify({ secret: invite.body.secret, name, password: MEMBER_PASSWORD }),
    },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const members = await api("GET", "/members");
  const id = members.body.members.find((m: Json) => m.member.name === name)?.member.id as string;
  return { id, cookie: cookieOf(res) };
}

async function newCode(): Promise<Json> {
  const res = await api("POST", "/machines/connect-codes", { serverUrl: server.url });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Pair the fake computer as the first owner's and link it; resolves once connected. */
async function connectComputer(): Promise<{ machineId: string; label: string; key: string }> {
  const code = await newCode();
  const pair = await paired(await computer.pair(server.url, code.code));
  computer.connect(server.url, pair.key);
  await waitUntil(() => machine()?.state === "connected");
  return pair;
}

const machine = () => server.runners.list().find((r) => r.backend === "connected");

async function startSession(text: string, cookie?: string) {
  const req = {
    projectId,
    provider: "fake",
    machine: machine()?.label,
    input: { text, attachments: [] },
  };
  return cookie ? remote(cookie, "POST", "/sessions", req) : api("POST", "/sessions", req);
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "codeden-connected-"));
  const serverHome = mkdtempSync(join(base, "server-"));
  bare = mkdtempSync(join(base, "origin-"));
  const work = mkdtempSync(join(base, "project-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  writeFileSync(join(work, "README.md"), "# on my laptop\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  git(work, "remote", "set-url", "origin", "https://github.com/codeden-test/laptop.git");
  const gitBroker: GitBroker = {
    cloneUrl: async () => bare,
    credentialFor: async () => undefined,
    credentialForProject: async () => undefined,
  };
  server = await startServer({
    port: 0,
    dataDir: serverHome,
    token: TOKEN,
    runner: false,
    enableFakeProvider: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: serverHome,
    exec: gitOnly,
    github: { sync: false },
    gitBroker,
  });
  await server.network.setPassword({ password: OWNER_PASSWORD });
  server.network.store.addTrustedOrigin(`https://${TEAM_HOST}`);
  await server.network.update({ enabled: true, loopbackOnly: true });
  const { project } = await server.services.projects.create({
    source: { type: "local", path: work },
  });
  projectId = project.id;
  computer = fakeComputer(base);
});

afterEach(async () => {
  await computer.stop();
  await server.close();
  await computer.stopRunner();
  await removeTree(base);
});

describe("pairing a computer", () => {
  it("trades a single-use code for a device key, and refuses an expired one", async () => {
    const code = await newCode();
    expect(code.command).toBe(
      `npx -y codeden@${(await api("GET", "/health")).body.version} connect ${server.url} --code ${code.code}`,
    );
    expect((await api("GET", `/machines/connect-codes/${code.id}`)).body.state).toBe("waiting");

    const pair = await paired(await computer.pair(server.url, code.code));
    expect(pair).toMatchObject({ label: "Laptop-1", fake: true });
    expect(pair.key).toMatch(/^cdk_/);
    expect((await api("GET", `/machines/connect-codes/${code.id}`)).body).toEqual({
      state: "paired",
      machineId: pair.machineId,
    });
    // Only the hashes are stored.
    const stored = server.database.db.select().from(machineCredentials).all();
    expect(JSON.stringify(stored)).not.toContain(pair.key);
    expect(JSON.stringify(stored)).not.toContain(code.code);

    const again = await computer.pair(server.url, code.code);
    expect(again.status).toBe(401);
    expect(((await again.json()) as Json).error.code).toBe("code_used");

    const late = await newCode();
    server.database.db
      .update(machineCredentials)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(machineCredentials.id, late.id))
      .run();
    expect((await api("GET", `/machines/connect-codes/${late.id}`)).body.state).toBe("expired");
    const expired = await computer.pair(server.url, late.code);
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as Json).error.code).toBe("code_expired");
    expect((await computer.pair(server.url, "cdp_nonsense")).status).toBe(401);
  });

  it("is something only a person does", async () => {
    const agent = await api("POST", "/members/agents", { name: "Helper", role: "operator" });
    const res = await fetch(`${server.url}/api/machines/connect-codes`, {
      method: "POST",
      headers: { authorization: `Bearer ${agent.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ serverUrl: server.url }),
    });
    expect(res.status).toBe(403);
  });
});

describe("a connected computer", () => {
  it("links in and runs a Fake session in a clone there", async () => {
    const pair = await connectComputer();
    const code = await api("GET", "/machines");
    const listed = code.body.machines.find((m: Json) => m.id === pair.machineId);
    expect(listed).toMatchObject({
      kind: "connected",
      owner: { id: "owner" },
      label: "Laptop-1",
      state: "connected",
    });
    expect(listed.providers).toContainEqual(expect.objectContaining({ id: "fake", ready: true }));

    const started = await startSession("hello from my laptop");
    expect(started.body.status, JSON.stringify(started.body)).toBe("started");
    const id = started.body.sessionId as string;
    await server.services.sessions.launching.get(id);
    const session = server.services.sessionRepo.get(id);
    expect(session.runnerId).toBe(machine()?.runnerId);
    expect(relative(computer.home, session.cwd)).not.toMatch(/^\.\./);
    expect(git(session.cwd, "remote", "get-url", "origin")).toBe(bare);
    await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
    expect(storedReply(server, id).completed).toContain("hello from my laptop");
  });

  it("loses no events when its link drops mid-turn and comes back", async () => {
    await connectComputer();
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const started = await startSession(words);
    const id = started.body.sessionId as string;
    await server.services.sessions.launching.get(id);
    await waitUntil(() => countEvents(server, id, "agent.item.delta") >= 3);
    computer.drop();

    await waitUntil(() => countEvents(server, id, "agent.turn.completed") === 1);
    expect(countEvents(server, id, "agent.turn.started")).toBe(1);
    const reply = storedReply(server, id);
    expect(reply.streamed).toBe(reply.completed);
    expect(reply.streamed).toContain("w299");
    expect(
      server.store.listAfter(0, 100_000).filter((e) => e.type === "runner.disconnected").length,
    ).toBeGreaterThanOrEqual(1);
    const client = server.runners.client(machine()?.id as string);
    const runnerId = client?.status.runnerId;
    const journal = await waitUntil(async () => {
      const status = await client?.request({ name: "runner.status" });
      return status?.journal.unacked === 0 ? status.journal : undefined;
    });
    const acked = server.database.db
      .select()
      .from(runnerState)
      .all()
      .find((r) => r.runnerId === runnerId);
    expect(acked?.lastAckedSeq).toBe(journal.lastSeq);
  });

  it("refuses unknown and revoked keys, and stops linking once disconnected", async () => {
    const pair = await connectComputer();
    const refusedWith = (key: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(runnerConnectUrl(server.url), {
          headers: { authorization: `Bearer ${key}` },
        });
        ws.on("error", () => undefined);
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => {
          ws.terminate();
          resolve(101);
        });
      });
    expect(await refusedWith("cdk_unknown")).toBe(401);

    const disconnected = await api("POST", `/machines/${pair.machineId}/disconnect`);
    expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(200);
    expect(await computer.ended()).toMatchObject({ kind: "revoked" });
    expect(await refusedWith(pair.key)).toBe(401);
    expect(machine()?.state).toBe("deleted");
    expect(RUNNER_CONNECT_PATH).toBe("/api/runner-connect");
  });

  it("takes work only from its person, and comes back as the same machine when paired again", async () => {
    const pair = await connectComputer();
    const bob = await operator("Bob");

    const listed = await remote(bob.cookie, "GET", "/machines");
    expect(listed.body.machines[0]).toMatchObject({ owner: { id: "owner" } });
    const refused = await startSession("on someone else's laptop", bob.cookie);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("machine_not_yours");
    const notHis = await remote(bob.cookie, "POST", `/machines/${pair.machineId}/disconnect`);
    expect(notHis.status).toBe(403);
    // A project can't send everyone's sessions there.
    const project = await api("PATCH", `/projects/${projectId}`, {
      execution: { backend: "ssh", machine: pair.label },
    });
    expect(project.status).toBe(400);
    expect(project.body.error.code).toBe("machine_personal");

    // Its person disconnects it and pairs it again: the same record, the same runner journal.
    await computer.stop();
    expect((await api("POST", `/machines/${pair.machineId}/disconnect`)).status).toBe(200);
    const code = await newCode();
    const again = await paired(
      await computer.pair(server.url, code.code, { previousMachineId: pair.machineId }),
    );
    expect(again.machineId).toBe(pair.machineId);
    computer.connect(server.url, again.key);
    await waitUntil(() => machine()?.state === "connected");
  });

  it("goes when its person is deleted", async () => {
    const bob = await operator("Bob");
    const code = await remote(bob.cookie, "POST", "/machines/connect-codes", {
      serverUrl: `https://${TEAM_HOST}`,
    });
    expect(code.status).toBe(201);
    expect(code.body.command).toContain(`connect https://${TEAM_HOST} --code`);
    const pair = await paired(await computer.pair(server.url, code.body.code));
    expect(server.services.computers?.authenticate(pair.key)).toBe(pair.machineId);
    expect((await api("DELETE", `/members/${bob.id}`)).status).toBe(200);
    await waitUntil(() => machine()?.state === "deleted");
    expect(server.services.computers?.authenticate(pair.key)).toBeUndefined();
  });
});
