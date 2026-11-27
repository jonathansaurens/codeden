import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import type { Exec, ExecResult } from "../src/services/exec";
import { removeTree } from "./support/remove-tree";

/**
 * Machines phase A1 (§A.2): adding a machine checks it over `ssh` first, and each failure says
 * what to fix with nothing saved. `ssh` is scripted here; `machines-ssh.test.ts` runs it for real.
 */

const TOKEN = "c".repeat(64);
const result = (over: Partial<ExecResult>): ExecResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  notFound: false,
  timedOut: false,
  path: "/usr/bin/ssh",
  ...over,
});

let base: string;
let server: RunningServer;
/** What the scripted `ssh` answers for `node --version` and `… --version`. */
let answers: { node: Partial<ExecResult>; codeden: Partial<ExecResult> };
let asked: string[][];

const ssh: Exec = async (_command, args) => {
  asked.push(args);
  const remote = args.at(-1) ?? "";
  return result(remote === "node --version" ? answers.node : answers.codeden);
};

async function add(body: unknown) {
  const res = await fetch(`${server.url}/api/machines`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as { error?: { code: string; message: string } },
  };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "codeden-machines-add-"));
  answers = { node: { stdout: "v24.2.0\n" }, codeden: { stdout: "0.7.10\n" } };
  asked = [];
  server = await startServer({
    port: 0,
    dataDir: base,
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: base,
    github: { sync: false },
    machines: { exec: ssh, command: "npx -y codeden@0.7.10" },
  });
});

afterEach(async () => {
  await server.close();
  await removeTree(base);
});

describe("adding a machine", () => {
  it.each([
    [{ node: { code: 255, stderr: "dev@vps-1: Permission denied (publickey)." } }, "ssh_auth"],
    [{ node: { code: 255, stderr: "Host key verification failed." } }, "ssh_host_key"],
    [
      { node: { code: 255, stderr: "ssh: connect to host vps-1 port 22: Connection refused" } },
      "ssh_unreachable",
    ],
    [{ node: { code: 127, stderr: "bash: node: command not found" } }, "node_missing"],
    [{ node: { stdout: "v22.4.0\n" } }, "node_too_old"],
    [{ codeden: { code: 1, stderr: "npm error code E404" } }, "codeden_failed"],
    [{ codeden: { stdout: "0.7.9\n" } }, "codeden_failed"],
  ])("refuses with what to fix (%#)", async (override, code) => {
    answers = { ...answers, ...override };
    const res = await add({ destination: "dev@vps-1" });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe(code);
    expect(res.body.error?.message).toMatch(/vps-1/);
    expect(server.runners.list().filter((r) => r.backend === "ssh")).toEqual([]);
  });

  it("asks ssh in batch mode, never passing the destination as an option", async () => {
    answers.node = { stdout: "v20.1.0\n" };
    await add({ destination: "dev@vps-1" });
    expect(asked[0]).toContain("BatchMode=yes");
    expect(asked[0]?.slice(-3)).toEqual(["--", "dev@vps-1", "node --version"]);
  });

  it("refuses a destination ssh could read as an option before running anything", async () => {
    const res = await add({ destination: "-oProxyCommand=touch /tmp/x" });
    expect(res.status).toBe(400);
    expect(asked).toEqual([]);
  });
});
