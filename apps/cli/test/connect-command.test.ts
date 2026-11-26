import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectCommand } from "../src/connect-command";
import {
  connectFilePath,
  connectHome,
  previousMachineFor,
  readConnectFile,
  runningLinkPid,
  writeConnectFile,
  writeLinkPid,
} from "../src/connect-file";

/**
 * `codeden connect`'s own state (`docs/machines-teams-and-agents.md` §D.5): `connect.json` and
 * the pairing against a scripted server. That server says it runs another CodeDen version, so
 * the link ends before any runner starts (the link itself is covered by the server's
 * `machines-connected` suite).
 */

let home: string;
let server: Server;
let url: string;
let pairs: Array<Record<string, unknown>>;
let pairStatus: number;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-connect-"));
  pairs = [];
  pairStatus = 201;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/runner-connect/pair") {
        pairs.push(JSON.parse(body));
        res.statusCode = pairStatus;
        res.end(
          JSON.stringify(
            pairStatus === 201
              ? { machineId: "c-1", label: "laptop", key: "cdk_secret", fake: false }
              : { error: { code: "code_used", message: "That pairing code was already used." } },
          ),
        );
        return;
      }
      res.end(JSON.stringify({ ok: true, name: "codeden", version: "0.0.1", uptimeSec: 1 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

const saved = (machineId = "c-0") => ({
  server: url,
  machineId,
  label: "laptop",
  key: "cdk_old",
  fake: false,
  pairedAt: "2026-11-26T09:00:00.000Z",
});

describe("connect.json", () => {
  it("is written for this user only and read back", () => {
    writeConnectFile(home, saved());
    expect(statSync(connectFilePath(home)).mode & 0o777).toBe(0o600);
    expect(readConnectFile(home)).toEqual(saved());
    writeFileSync(connectFilePath(home), "{ not json");
    expect(readConnectFile(home)).toBeNull();
  });

  it("names the machine to pair as again only for the same server", () => {
    expect(previousMachineFor(saved(), url)).toBe("c-0");
    expect(previousMachineFor(saved(), "https://other.example.com")).toBeUndefined();
    expect(previousMachineFor(null, url)).toBeUndefined();
    expect(connectHome(undefined)).toMatch(/\.codeden-runner$/);
  });

  it("keeps the pid of a live link only", () => {
    writeLinkPid(home, process.pid);
    expect(runningLinkPid(home)).toBe(process.pid);
    writeLinkPid(home, 2 ** 22 + 12345);
    expect(runningLinkPid(home)).toBeUndefined();
  });
});

describe("codeden connect", () => {
  it("pairs, saves the key, and pairs again as the same machine", async () => {
    const run = (code: string) =>
      connectCommand({ home, server: `${url}/`, code, detach: false, stop: false });
    // Paired, then the link stops at once: the server runs another version.
    expect(await run("cdp_first")).toBe(1);
    expect(pairs[0]).toMatchObject({ code: "cdp_first" });
    expect(pairs[0]?.previousMachineId).toBeUndefined();
    expect(readConnectFile(home)).toMatchObject({
      server: url,
      machineId: "c-1",
      key: "cdk_secret",
    });
    expect(statSync(connectFilePath(home)).mode & 0o777).toBe(0o600);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("now runs CodeDen 0.0.1"));
    expect(runningLinkPid(home)).toBeUndefined();

    await run("cdp_second");
    expect(pairs[1]).toMatchObject({ code: "cdp_second", previousMachineId: "c-1" });
  });

  it("says why a code is refused, and keeps the earlier pairing", async () => {
    writeConnectFile(home, saved());
    pairStatus = 401;
    expect(
      await connectCommand({ home, server: url, code: "cdp_x", detach: false, stop: false }),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("already used"));
    expect(readConnectFile(home)?.key).toBe("cdk_old");
  });

  it("needs a pairing before it can link, and the same server", async () => {
    expect(await connectCommand({ home, detach: false, stop: false })).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("isn't paired yet"));
    writeConnectFile(home, saved());
    expect(
      await connectCommand({
        home,
        server: "https://other.example.com",
        detach: false,
        stop: false,
      }),
    ).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`is paired with ${url}`));
    expect(await connectCommand({ home, detach: false, stop: true })).toBe(1);
  });
});
