import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { insecureOriginSwitch } from "../src/main/servers/insecure-origins";
import { readServerFile } from "../src/main/servers/store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("secure-context switch for private http servers (§17.1)", () => {
  it("lists only the http origins on a private network or VPN", () => {
    expect(
      insecureOriginSwitch([
        "http://10.127.65.119:4317",
        "https://omaweb.tail1234.ts.net:8446",
        "http://192.168.1.20:4317",
        "http://10.127.65.119:4317",
        "http://[fd12::1]:4317",
      ]),
    ).toBe("http://10.127.65.119:4317,http://192.168.1.20:4317,http://[fd12::1]:4317");
  });

  it("is off without private http servers", () => {
    expect(insecureOriginSwitch([])).toBeNull();
    expect(insecureOriginSwitch(["https://x.ts.net", "http://8.8.8.8", "http://x.lan"])).toBeNull();
  });

  it("reads the saved list with the rules of Add, dropping what they refuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-servers-"));
    dirs.push(dir);
    const file = join(dir, "servers.json");
    writeFileSync(
      file,
      JSON.stringify({
        servers: [
          { id: "aaaaaaaaaaaa", name: "Squid", url: "http://10.127.65.119:4317/" },
          { id: "bbbbbbbbbbbb", name: "Public", url: "http://8.8.8.8:4317" },
          { id: "cccccccccccc", name: "Name", url: "http://box.lan:4317" },
          { id: "dddddddddddd", name: "Tail", url: "https://x.ts.net" },
        ],
      }),
    );
    const urls = readServerFile(file).map((s) => s.url);
    expect(urls).toEqual(["http://10.127.65.119:4317", "https://x.ts.net"]);
    expect(insecureOriginSwitch(urls)).toBe("http://10.127.65.119:4317");
    expect(readServerFile(join(dir, "missing.json"))).toEqual([]);
  });
});
