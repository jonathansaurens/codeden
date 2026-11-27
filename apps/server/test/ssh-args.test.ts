import { describe, expect, it } from "vitest";
import {
  checkCodeden,
  checkNode,
  defaultLabel,
  detachCommand,
  linkCommand,
  parseNodeMajor,
  pinnedCommand,
  type SshRun,
  sshArgs,
  sshFailure,
} from "../src/execution/ssh/args";

/** Machines phase A1 (`docs/machines-teams-and-agents.md` §A.2, §A.3): ssh commands, no ssh. */

const ok: SshRun = { notFound: false, code: 0, stdout: "", stderr: "", timedOut: false };
const failed = (stderr: string): SshRun => ({ ...ok, code: 255, stderr });

describe("ssh commands", () => {
  it("never prompts, keeps the link alive, and can't read a destination as an option", () => {
    expect(sshArgs("dev@vps-1", "node --version")).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-T",
      "--",
      "dev@vps-1",
      "node --version",
    ]);
  });

  it("pins the server's version, starts the runner detached, then links to it", () => {
    const prefix = pinnedCommand("0.7.10");
    expect(prefix).toBe("npx -y codeden@0.7.10");
    expect(detachCommand(prefix)).toBe(
      "npx -y codeden@0.7.10 runner --home ~/.codeden-runner --detach --backend ssh 1>&2",
    );
    expect(linkCommand(prefix, { fake: true })).toBe(
      "npx -y codeden@0.7.10 runner --home ~/.codeden-runner --detach --backend ssh --fake 1>&2" +
        " && exec npx -y codeden@0.7.10 runner-link --home ~/.codeden-runner",
    );
  });

  it("labels a machine after its host", () => {
    expect(defaultLabel("dev@vps-1.example.com")).toBe("vps-1");
    expect(defaultLabel("ssh://dev@box:2222")).toBe("box");
    expect(defaultLabel("home")).toBe("home-1");
    expect(defaultLabel("100.64.0.2")).toBe("100");
  });
});

describe("the add checks", () => {
  it("say what to fix when ssh can't get in", () => {
    expect(sshFailure({ ...ok, notFound: true }, "vps")?.code).toBe("ssh_failed");
    expect(sshFailure({ ...ok, timedOut: true }, "vps")?.code).toBe("ssh_unreachable");
    expect(sshFailure(failed("dev@vps: Permission denied (publickey)."), "vps")).toMatchObject({
      code: "ssh_auth",
      message: expect.stringContaining("ssh-copy-id vps"),
    });
    expect(sshFailure(failed("Host key verification failed."), "vps")?.code).toBe("ssh_host_key");
    expect(
      sshFailure(failed("ssh: Could not resolve hostname vps: nodename nor servname"), "vps")?.code,
    ).toBe("ssh_unreachable");
    expect(
      sshFailure(failed("kex_exchange_identification: read: Connection reset"), "vps"),
    ).toMatchObject({ code: "ssh_failed", message: expect.stringContaining("Connection reset") });
    // The remote command ran and failed by itself: not ssh's failure.
    expect(sshFailure({ ...ok, code: 127 }, "vps")).toBeNull();
  });

  it("need Node.js 24 or newer", () => {
    expect(parseNodeMajor("v24.11.1\n")).toBe(24);
    expect(checkNode({ ...ok, stdout: "v24.1.0\n" }, "dev@vps", "vps")).toBeNull();
    expect(checkNode({ ...ok, stdout: "v20.11.0\n" }, "dev@vps", "vps")).toEqual({
      code: "node_too_old",
      message: "Node.js 24 or newer is needed on vps; found 20.11.0",
    });
    expect(
      checkNode({ ...ok, code: 127, stderr: "sh: node: not found" }, "dev@vps", "vps")?.code,
    ).toBe("node_missing");
  });

  it("need the server's own CodeDen version to run there", () => {
    const prefix = pinnedCommand("0.7.10");
    expect(checkCodeden({ ...ok, stdout: "0.7.10\n" }, "d", "vps", "0.7.10", prefix)).toBeNull();
    expect(checkCodeden({ ...ok, stdout: "0.7.9\n" }, "d", "vps", "0.7.10", prefix)).toEqual({
      code: "codeden_failed",
      message: "vps runs CodeDen 0.7.9 through npx -y codeden@0.7.10; this server is 0.7.10",
    });
    expect(
      checkCodeden(
        { ...ok, code: 1, stderr: "npm error 404 Not Found\n" },
        "d",
        "vps",
        "0.7.10",
        prefix,
      ),
    ).toMatchObject({ code: "codeden_failed", message: expect.stringContaining("404") });
  });
});
