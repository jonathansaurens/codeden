import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, type StartServerOptions, startServer } from "../src";
import { runnerState } from "../src/db/schema";
import { type Exec, runTool } from "../src/services/exec";
import type { GitBroker } from "../src/services/git-broker";
import { type FakeMachine, fakeMachine } from "./support/fake-ssh";
import { waitUntil } from "./support/harness";
import { countEvents, storedReply } from "./support/link-turn";
import { removeTree } from "./support/remove-tree";

/**
 * Machines over SSH (`docs/machines-teams-and-agents.md` Part A, phase A1), end to end through
 * a fake `ssh` (`support/fake-ssh.ts`): it runs each remote command on this computer under a
 * temp `$HOME`, so the server checks the "machine", starts its runner detached with
 * `codeden runner --detach` and links to it with `codeden runner-link`, all real processes
 * over the real exec transport, with the Fake provider.
 */

const TOKEN = "d".repeat(64);
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
let machine: FakeMachine;
let server: RunningServer;
let projectId: string;

function serverOptions(): StartServerOptions {
  const gitBroker: GitBroker = {
    cloneUrl: async () => bare,
    credentialFor: async () => undefined,
    credentialForProject: async () => undefined,
  };
  return {
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

async function startSession(text: string): Promise<string> {
  const started = await api("POST", "/sessions", {
    projectId,
    provider: "fake",
    input: { text, attachments: [] },
  });
  expect(started.body.status).toBe("started");
  const id = started.body.sessionId as string;
  await server.services.sessions.launching.get(id);
  return id;
}

const replies = (sessionId: string) =>
  server.store
    .listAfter(0, 100_000, [sessionId])
    .filter((e) => e.type === "agent.item.completed")
    .map((e) => (e.payload as { item?: { kind?: string; text?: string } }).item)
    .filter((item) => item?.kind === "assistant_message")
    .map((item) => item?.text ?? "");

const machineRecord = () => server.runners.list().find((r) => r.backend === "ssh");

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "codeden-machines-"));
  serverHome = mkdtempSync(join(base, "server-"));
  bare = mkdtempSync(join(base, "origin-"));
  work = mkdtempSync(join(base, "project-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  writeFileSync(join(work, "README.md"), "# on a machine\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");
  git(work, "remote", "set-url", "origin", "https://github.com/codeden-test/machines.git");
  machine = fakeMachine(base);
  server = await startServer(serverOptions());
  const { project } = await server.services.projects.create({
    source: { type: "local", path: work },
  });
  projectId = project.id;

  const added = await api("POST", "/machines", { destination: "dev@vps-1" });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  expect(added.body.machine).toMatchObject({ label: "vps-1", state: "connected", sessions: 0 });
  const patched = await api("PATCH", `/projects/${projectId}`, {
    execution: { backend: "ssh", machine: "vps-1" },
  });
  expect(patched.status).toBe(200);
});

afterEach(async () => {
  await server.close();
  await machine.stopRunner();
  await removeTree(base);
});

describe("a machine over ssh", () => {
  it("is checked, gets a detached runner and runs a Fake session over the link", async () => {
    // The checks and the link, each with the command machines run CodeDen with.
    const commands = machine.commands();
    expect(commands[0]).toBe("node --version");
    expect(commands[1]).toBe(`${machine.command} --version`);
    expect(commands[2]).toContain(
      `${machine.command} runner --home ~/.codeden-runner --detach --backend ssh --fake`,
    );
    expect(commands[2]).toContain("&& exec");
    expect(machine.runnerPid()).toBeDefined();

    const listed = await api("GET", "/machines");
    expect(listed.body.command).toBe(machine.command);
    expect(listed.body.machines[0].providers).toContainEqual(
      expect.objectContaining({ id: "fake", ready: true }),
    );

    const id = await startSession("hello from vps-1");
    const record = machineRecord();
    const session = server.services.sessionRepo.get(id);
    expect(session.runnerId).toBe(record?.runnerId);
    // Cloned in the machine's runner home, from GitHub (the broker's bare repository here).
    expect(relative(machine.runnerHome, session.cwd)).not.toMatch(/^\.\./);
    expect(git(session.cwd, "remote", "get-url", "origin")).toBe(bare);
    await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
    expect(storedReply(server, id).completed).toContain("hello from vps-1");
  });

  it("loses no events when the link is killed mid-turn", async () => {
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const id = await startSession(words);
    const client = server.runners.client(machineRecord()?.id as string);
    await waitUntil(() => countEvents(server, id, "agent.item.delta") >= 3);
    const pid = client?.linkPid;
    expect(pid).toBeDefined();
    process.kill(pid as number, "SIGKILL");

    await waitUntil(() => countEvents(server, id, "agent.turn.completed") === 1);
    expect(countEvents(server, id, "agent.turn.started")).toBe(1);
    const reply = storedReply(server, id);
    expect(reply.streamed).toBe(reply.completed);
    expect(reply.streamed).toContain("w299");
    expect(client?.linkPid).not.toBe(pid);
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

  it("can't be removed while sessions are placed there, or while a clone holds unpushed work", async () => {
    const id = await startSession("keep me");
    await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
    const inUse = await api("DELETE", "/machines/vps-1");
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe("machine_in_use");

    await server.services.worktreeCleanup.archive(id);
    const { cwd } = server.services.sessionRepo.get(id);
    writeFileSync(join(cwd, "draft.md"), "only here\n");
    const unpushed = await api("DELETE", "/machines/vps-1");
    expect(unpushed.status).toBe(409);
    expect(unpushed.body.error.code).toBe("machine_unpushed");
    expect(unpushed.body.error.message).toContain("uncommitted changes in 1 file");

    const forced = await api("DELETE", "/machines/vps-1?force=true");
    expect(forced.status).toBe(200);
    expect(machineRecord()?.state).toBe("deleted");
    await waitUntil(() => machine.runnerPid() === undefined);
  });

  it("is linked again after a server restart, even when its runner stopped meanwhile", async () => {
    const id = await startSession("before the restart");
    await waitUntil(() => server.services.sessionRepo.get(id).status === "idle");
    const record = machineRecord();
    await server.close();
    await machine.stopRunner();

    server = await startServer(serverOptions());
    await server.services.machines?.reattached;
    const client = server.runners.client(record?.id as string);
    await waitUntil(() => client?.status.state === "connected");
    expect(client?.status.runnerId).toBe(record?.runnerId);
    expect(machine.runnerPid()).toBeDefined();

    await server.services.sessions.send(id, {
      input: { text: "after the restart", attachments: [] },
      whenBusy: "queue",
    });
    await waitUntil(() => replies(id).some((text) => text.includes("after the restart")));
    expect(server.services.sessionRepo.get(id).runnerId).toBe(record?.runnerId);
  });
});
