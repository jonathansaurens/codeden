import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROLE_PLACEMENT_CODE, type Session } from "@codeden/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, type StartServerOptions, startServer } from "../src";
import { type Exec, runTool } from "../src/services/exec";
import type { GitBroker } from "../src/services/git-broker";
import { type FakeMachine, fakeMachine } from "./support/fake-ssh";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

/**
 * Where the orchestrator and the PMs run (`docs/machines-teams-and-agents.md` §D.4), end to end:
 * the server's own runner plus a machine behind a fake `ssh` (`support/fake-ssh.ts`), both real
 * runner processes with the Fake provider.
 */

const TOKEN = "e".repeat(64);
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
let serverHome: string;
let bare: string;
let work: string;
let local: string;
let machine: FakeMachine;
let server: RunningServer;
let projectId: string;
let localProjectId: string;
let machineId: string;
/** Clones from the origin fail while set: a start on the machine fails. */
let cloneFails = false;

function serverOptions(): StartServerOptions {
  const gitBroker: GitBroker = {
    cloneUrl: async () => (cloneFails ? join(base, "no-such-origin") : bare),
    credentialFor: async () => undefined,
    credentialForProject: async () => undefined,
  };
  return {
    port: 0,
    dataDir: serverHome,
    token: TOKEN,
    enableFakeProvider: true,
    waitForRunner: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: serverHome,
    exec: gitOnly,
    github: { sync: false },
    gitBroker,
    runnerRequestTimeoutFloorMs: 90_000,
    machines: { sshCommand: machine.ssh, command: machine.command, exec: runTool },
  };
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: the tests read loose JSON answers
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const say = (text: string) => ({ input: { text, attachments: [] } });

/** Message the project's PM and wait for its reply; returns the PM session. */
async function askPm(text: string, project = projectId): Promise<Session> {
  const sent = await api("POST", `/orchestration/projects/${project}/pm/messages`, say(text));
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const id = sent.body.sessionId as string;
  await waitUntil(() => replies(id).some((r) => r.includes(text)));
  await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
  return server.services.sessionRepo.get(id);
}

const items = (sessionId: string) =>
  server.store
    .listAfter(0, 100_000, [sessionId])
    .filter((e) => e.type === "agent.item.completed")
    .map((e) => (e.payload as { item: { kind: string; text?: string; code?: string } }).item);
const replies = (id: string) =>
  items(id)
    .filter((i) => i.kind === "assistant_message")
    .map((i) => i.text ?? "");
const placementNotes = (id: string) =>
  items(id)
    .filter((i) => i.kind === "notice" && i.code === ROLE_PLACEMENT_CODE)
    .map((i) => (i as { message?: string }).message ?? "");

const machineRunnerId = () => server.runners.list().find((r) => r.id === machineId)?.runnerId;
const machineClient = () => server.runners.client(machineId);

beforeEach(async () => {
  cloneFails = false;
  base = mkdtempSync(join(tmpdir(), "codeden-role-placement-"));
  serverHome = mkdtempSync(join(base, "server-"));
  bare = mkdtempSync(join(base, "origin-"));
  work = mkdtempSync(join(base, "project-"));
  local = mkdtempSync(join(base, "local-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  for (const dir of [work, local]) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.com");
    writeFileSync(join(dir, "README.md"), "# the project\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "initial");
  }
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  git(work, "remote", "set-url", "origin", "https://github.com/codeden-test/roles.git");
  machine = fakeMachine(base);
  server = await startServer(serverOptions());
  const created = await server.services.projects.create({ source: { type: "local", path: work } });
  projectId = created.project.id;
  expect(created.project.kind).toBe("github");
  const plain = await server.services.projects.create({ source: { type: "local", path: local } });
  localProjectId = plain.project.id;
  const added = await api("POST", "/machines", { destination: "dev@vps-1" });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  machineId = added.body.machine.id as string;
  await waitUntil(() => server.runner?.mcpProxyUrl ?? undefined);
});

afterEach(async () => {
  await server.close();
  await machine.stopRunner();
  await removeTree(base);
});

describe("Runs on (§D.4)", () => {
  it("runs a PM on its machine in the project's clone, read-only, with its tools over the link", async () => {
    const set = await api("PATCH", `/projects/${projectId}`, { pmRunsOn: machineId });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.pmRunsOn).toBe(machineId);

    const pm = await askPm("hello from the PM");
    expect(pm.runnerId).toBe(machineRunnerId());
    expect(realpathSync(pm.cwd)).toBe(
      realpathSync(join(machine.runnerHome, "repos", server.services.projects.get(projectId).slug)),
    );
    expect(pm.worktreePath).toBeNull();
    expect(git(pm.cwd, "remote", "get-url", "origin")).toBe(bare);
    expect(server.services.launcher.sessionOptions(pm).readOnly).toBe(true);

    // Fetched before each turn: a commit pushed meanwhile is in the clone at the next one.
    git(work, "remote", "set-url", "origin", bare);
    writeFileSync(join(work, "NEW.md"), "new\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "second");
    git(work, "push", "-q", "origin", "main");
    await askPm("second turn");
    expect(existsSync(join(pm.cwd, "NEW.md"))).toBe(true);

    // A PM's tools answer over the machine's link, with the PM's own token.
    const token = server.services.mcpTokens.mint({ role: "pm", sessionId: pm.id, projectId });
    const url = machineClient()?.mcpProxyUrl;
    expect(url).toBeTruthy();
    const agent = new Client({ name: "pm", version: "0.0.0" });
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(url as string), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const tools = (await agent.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["start_session", "get_project_status"]));
    const status = await agent.callTool({ name: "get_project_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    await agent.close();
  });

  it("runs the orchestrator on its machine in a folder of its person's", async () => {
    const set = await api("PUT", "/orchestration/orchestrator/runs-on", { runsOn: machineId });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.choices.map((c: { id: string }) => c.id)).toEqual(["server", machineId]);
    const sent = await api("POST", "/orchestration/orchestrator/messages", say("hi there"));
    expect(sent.status).toBe(200);
    const id = sent.body.sessionId as string;
    await waitUntil(() => replies(id).some((r) => r.includes("hi there")));
    const session = server.services.sessionRepo.get(id);
    expect(session.runnerId).toBe(machineRunnerId());
    expect(realpathSync(session.cwd)).toBe(
      realpathSync(join(machine.runnerHome, "orchestrator", "owner")),
    );
    // Its first conversation: nothing moved.
    expect(placementNotes(id)).toEqual([]);
  });

  it("gives each person's orchestrator on the server a folder of its own", async () => {
    const { roles } = server.services.orchestration;
    const first = await roles.ensure("orchestrator", null);
    const other = await roles.ensure("orchestrator", "mem-ann");
    await server.services.sessions.launching.get(first.id);
    await server.services.sessions.launching.get(other.id);
    const dir = join(serverHome, "orchestrator");
    expect(resolve(server.services.sessionRepo.get(first.id).cwd)).toBe(resolve(dir));
    expect(resolve(server.services.sessionRepo.get(other.id).cwd)).toBe(resolve(dir, "mem-ann"));
  });

  it("moves when Runs on changes, carrying the queue over to the new device", async () => {
    const { sessions, sessionRepo, outbox } = server.services;
    const before = await askPm("on the server");
    expect(before.runnerId).not.toBe(machineRunnerId());
    // A turn under way keeps the role where it is until it has ended.
    await sessions.send(before.id, {
      input: { text: "[approval] long one", attachments: [] },
      whenBusy: "queue",
    });
    await waitUntil(() => sessionRepo.get(before.id).status === "waiting");
    expect((await api("PATCH", `/projects/${projectId}`, { pmRunsOn: machineId })).status).toBe(
      200,
    );
    await server.services.orchestration.roles.applyPlacement("pm", projectId);
    expect(sessionRepo.get(before.id).archivedAt).toBeNull();
    const approval = await waitUntil(() =>
      server.services.inbox
        .list({ sessionId: before.id })
        .find((i) => i.kind === "approval" && i.status === "open"),
    );
    await sessions.respond(before.id, {
      requestId: approval.requestId as string,
      response: { kind: "approval", decision: "allow_once" },
    });
    await waitUntil(() => sessionRepo.get(before.id).status === "idle");

    // Idle with a message waiting: the move retires it at once, and the queue goes with it.
    outbox.push(before.id, { text: "queued behind it", attachments: [] }, "user");
    await server.services.orchestration.roles.applyPlacement("pm", projectId);
    expect(sessionRepo.get(before.id).archivedAt).not.toBeNull();
    const after = server.services.orchestration.roles.find("pm", projectId) as Session;
    expect(after.id).not.toBe(before.id);
    expect(after.runnerId).toBe(machineRunnerId());
    await waitUntil(() => replies(after.id).some((r) => r.includes("queued behind it")));
    expect(placementNotes(after.id)).toEqual(["Moved to vps-1."]);
  });

  it("falls back to the server while its machine is offline, and goes back later", async () => {
    await api("PATCH", `/projects/${projectId}`, { pmRunsOn: machineId });
    const onMachine = await askPm("first");
    expect(onMachine.runnerId).toBe(machineRunnerId());

    machine.setReachable(false);
    await machine.stopRunner();
    await waitUntil(() => machineClient()?.status.state !== "connected");
    const fallback = await askPm("while it is away");
    expect(fallback.id).not.toBe(onMachine.id);
    expect(fallback.runnerId).not.toBe(machineRunnerId());
    expect(placementNotes(fallback.id)).toEqual([
      "vps-1 is offline; this turn runs on the server, until vps-1 can take it again.",
    ]);
    // Still away: the next turn stays where it is.
    expect((await askPm("still away")).id).toBe(fallback.id);

    machine.setReachable(true);
    await waitUntil(() => machineClient()?.status.state === "connected");
    const back = await askPm("it is back");
    expect(back.id).not.toBe(fallback.id);
    expect(back.runnerId).toBe(machineRunnerId());
    expect(placementNotes(back.id)).toEqual(["Back on vps-1."]);
  });

  it("falls back to the server when the PM can't be started on its machine", async () => {
    await api("PATCH", `/projects/${projectId}`, { pmRunsOn: machineId });
    cloneFails = true;
    const sent = await api(
      "POST",
      `/orchestration/projects/${projectId}/pm/messages`,
      say("hello"),
    );
    expect(sent.status).toBe(200);
    const failed = sent.body.sessionId as string;
    const current = () => server.services.orchestration.roles.find("pm", projectId);
    await waitUntil(() => {
      const pm = current();
      return (
        pm !== undefined && pm.id !== failed && replies(pm.id).some((r) => r.includes("hello"))
      );
    });
    const fallback = current() as Session;
    await waitUntil(() => server.services.sessionRepo.get(fallback.id).status === "idle");
    expect(server.services.sessionRepo.get(failed).archivedAt).not.toBeNull();
    expect(fallback.runnerId).not.toBe(machineRunnerId());
    const [note] = placementNotes(fallback.id);
    expect(note).toMatch(
      /^vps-1 couldn't start it \(.+\); this turn runs on the server, until vps-1 can take it again\.$/,
    );

    // The machine is tried again on the next turn.
    cloneFails = false;
    const back = await askPm("try the machine again");
    expect(back.id).not.toBe(fallback.id);
    expect(back.runnerId).toBe(machineRunnerId());
    expect(placementNotes(back.id)).toEqual(["Back on vps-1."]);
  });

  it("keeps the PM of a project that isn't on GitHub on the server", async () => {
    const refused = await api("PATCH", `/projects/${localProjectId}`, { pmRunsOn: machineId });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("machine_unavailable");
    const pm = await askPm("local only", localProjectId);
    expect(pm.runnerId).not.toBe(machineRunnerId());
    expect(resolve(pm.cwd)).toBe(resolve(local));
  });

  it("refuses a machine that doesn't exist", async () => {
    const res = await api("PUT", "/orchestration/orchestrator/runs-on", { runsOn: "m-nope" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("unknown_machine");
  });
});
