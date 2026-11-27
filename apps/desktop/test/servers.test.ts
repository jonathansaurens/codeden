import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeAllowed, parseRemoteTag, REMOTE_CALLS, remoteTag } from "../src/main/bridge-policy";
import { appMenuTemplate, serversMenu } from "../src/main/menu";
import { allowPermission, isServerUrl } from "../src/main/security";
import { healthCheck } from "../src/main/servers/health";
import { RemoteMonitor, type RemoteStatus } from "../src/main/servers/monitor";
import { parseServerUrl, partitionFor, ServerStore } from "../src/main/servers/store";
import { serverSummary, totalBadge, trayServers } from "../src/main/servers/summary";
import { trayView } from "../src/main/tray-view";

const ORIGIN = "https://omaweb.tail1234.ts.net:8446";

describe("server addresses", () => {
  it("accepts https://host[:port] and normalizes it", () => {
    expect(parseServerUrl("https://OmaWeb.tail1234.ts.net:8446")).toEqual({
      ok: true,
      origin: ORIGIN,
    });
    expect(parseServerUrl("https://x.ts.net:443")).toEqual({
      ok: true,
      origin: "https://x.ts.net",
    });
  });
  it("rejects http, paths, credentials, queries, IP addresses and this computer", () => {
    for (const bad of [
      "http://x.ts.net",
      "https://x.ts.net/app",
      "https://me:pw@x.ts.net",
      "https://x.ts.net?a=1",
      "https://100.64.0.1:8446",
      "https://localhost:4317",
      "ftp://x.ts.net",
      "x.ts.net",
    ]) {
      expect(parseServerUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe("health check", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const health = { ok: true, name: "codeden", version: "0.7.7", uptimeSec: 3 };

  it("asks /api/health without credentials or redirects", async () => {
    const fetchImpl = vi.fn(async () => json(health));
    await expect(healthCheck(fetchImpl as unknown as typeof fetch)(ORIGIN)).resolves.toEqual({
      ok: true,
      version: "0.7.7",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${ORIGIN}/api/health`,
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
  });
  it("fails for an unreachable server, a bad certificate and a non-CodeDen answer", async () => {
    const down = healthCheck((async () => {
      throw new TypeError("fetch failed", { cause: new Error("net::ERR_CERT_AUTHORITY_INVALID") });
    }) as typeof fetch);
    const result = await down(ORIGIN);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("ERR_CERT_AUTHORITY_INVALID");
    const other = healthCheck((async () => json({ hello: 1 })) as unknown as typeof fetch);
    expect((await other(ORIGIN)).ok).toBe(false);
    const gone = healthCheck((async () => json({}, 502)) as unknown as typeof fetch);
    expect((await gone(ORIGIN)).ok).toBe(false);
  });
});

describe("the server list", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-servers-"));
    file = join(dir, "servers.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const store = (version = "0.7.7") =>
    new ServerStore({
      file,
      appVersion: "0.7.7",
      check: async () => ({ ok: true, version }),
    });

  it("lists This Mac first, adds, renames, removes and persists", async () => {
    const list = store();
    expect(list.list()).toEqual([{ id: "local", name: "This Mac", url: null }]);
    const added = await list.add({ name: "  Omarchy ", url: ORIGIN });
    expect(added.ok && added.server).toMatchObject({ name: "Omarchy", url: ORIGIN });
    expect(added.ok && added.warning).toBeUndefined();
    const id = added.ok ? added.server.id : "";
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(partitionFor(id)).toBe(`persist:codeden-remote-${id}`);

    expect(
      store()
        .list()
        .map((s) => s.name),
    ).toEqual(["This Mac", "Omarchy"]);
    expect(list.rename(id, "Oma").ok).toBe(true);
    expect(store().get(id)?.name).toBe("Oma");
    expect(list.rename(id, "   ").ok).toBe(false);
    expect(list.remove("local")).toBe(false);
    expect(list.remove(id)).toBe(true);
    expect(store().list()).toHaveLength(1);
  });

  it("warns, never fails, for another CodeDen version", async () => {
    const added = await store("0.6.0").add({ name: "Old", url: ORIGIN });
    expect(added.ok && added.warning).toContain("0.6.0");
  });

  it("refuses bad addresses, repeats, an unreachable server and checks before saving", async () => {
    const list = store();
    expect((await list.add({ name: "x", url: "http://x.ts.net" })).ok).toBe(false);
    expect((await list.add({ name: "", url: ORIGIN })).ok).toBe(false);
    await list.add({ name: "A", url: ORIGIN });
    expect((await list.add({ name: "B", url: ORIGIN })).ok).toBe(false);
    const down = new ServerStore({
      file: join(dir, "other.json"),
      appVersion: "1",
      check: async () => ({ ok: false, error: "Could not reach it" }),
    });
    expect(await down.add({ name: "D", url: "https://d.ts.net" })).toEqual({
      ok: false,
      error: "Could not reach it",
    });
    expect(down.list()).toHaveLength(1);
  });

  it("drops hand-edited entries that break the address rules", () => {
    writeFileSync(
      file,
      JSON.stringify({
        servers: [
          { id: "aaaaaaaaaaaa", name: "Good", url: ORIGIN },
          { id: "bbbbbbbbbbbb", name: "Plain", url: "http://x.ts.net" },
          { id: "cccccccccccc", name: "Path", url: `${ORIGIN}/x` },
          { id: "not-an-id", name: "Bad id", url: ORIGIN },
        ],
      }),
    );
    expect(
      store()
        .list()
        .map((s) => s.name),
    ).toEqual(["This Mac", "Good"]);
    expect(readFileSync(file, "utf8")).toContain("Plain"); // read never rewrites
  });
});

describe("bridge gate", () => {
  const local = { kind: "local", origin: "http://127.0.0.1:4317" } as const;
  const remote = { kind: "remote", origin: ORIGIN } as const;

  it("lets a remote window use only the small set", () => {
    for (const call of [
      "info",
      "notify",
      "openExternal",
      "setBadge",
      "servers.list",
      "servers.open",
    ] as const) {
      expect(bridgeAllowed(call, remote, `${ORIGIN}/inbox`), call).toBe(true);
    }
    for (const call of ["pickFolder", "browser", "servers.manage"] as const) {
      expect(bridgeAllowed(call, remote, `${ORIGIN}/`), call).toBe(false);
    }
    expect(REMOTE_CALLS.has("pickFolder")).toBe(false);
  });
  it("lets This Mac's window use everything", () => {
    for (const call of ["pickFolder", "browser", "servers.manage", "notify"] as const) {
      expect(bridgeAllowed(call, local, "http://127.0.0.1:4317/")).toBe(true);
    }
  });
  it("refuses unknown windows, an unloaded window and a frame off the window's origin", () => {
    expect(bridgeAllowed("info", null, ORIGIN)).toBe(false);
    expect(bridgeAllowed("info", { kind: "remote", origin: null }, ORIGIN)).toBe(false);
    expect(bridgeAllowed("info", remote, "https://evil.example/")).toBe(false);
    expect(bridgeAllowed("notify", local, ORIGIN)).toBe(false);
    expect(bridgeAllowed("info", remote, "not a url")).toBe(false);
  });
  it("routes a notification tag back to its server", () => {
    const tag = remoteTag("abcdef012345", "batch:1");
    expect(parseRemoteTag(tag)).toEqual({ serverId: "abcdef012345", tag: "batch:1" });
    expect(parseRemoteTag("batch:1")).toBeNull();
  });
});

describe("a remote window's origin rules", () => {
  it("keeps navigation and permissions on the server's origin", () => {
    expect(isServerUrl(`${ORIGIN}/sessions/1`, ORIGIN)).toBe(true);
    expect(isServerUrl("https://omaweb.tail1234.ts.net:8447/", ORIGIN)).toBe(false);
    expect(isServerUrl("http://omaweb.tail1234.ts.net:8446/", ORIGIN)).toBe(false);
    expect(allowPermission("notifications", `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(allowPermission("media", `${ORIGIN}/`, ORIGIN, ["audio"])).toBe(true);
    expect(allowPermission("media", `${ORIGIN}/`, ORIGIN, ["audio", "video"])).toBe(false);
    expect(allowPermission("notifications", "https://evil.example/", ORIGIN)).toBe(false);
    expect(allowPermission("geolocation", `${ORIGIN}/`, ORIGIN)).toBe(false);
  });
});

describe("remote status", () => {
  const activity = { running: 2, waiting: 1, inbox: 3 };
  const reply = (status: number, body: unknown = activity) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const monitor = (fetchImpl: typeof fetch) =>
    new RemoteMonitor({ baseUrl: ORIGIN, fetch: fetchImpl, onChange: () => {} });

  it("polls /api/activity through the given (per-server) fetch", async () => {
    const calls: string[] = [];
    const m = monitor((async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(activity));
    }) as unknown as typeof fetch);
    expect(await m.poll()).toEqual({ state: "ok", activity });
    expect(calls).toEqual([`${ORIGIN}/api/activity`]);
  });
  it("shows signed out and unreachable as states, keeping the last counts, never throwing", async () => {
    const m = monitor(reply(200));
    await m.poll();
    const signedOut = new RemoteMonitor({ baseUrl: ORIGIN, fetch: reply(401), onChange: () => {} });
    expect((await signedOut.poll()).state).toBe("signed-out");
    const down = new RemoteMonitor({
      baseUrl: ORIGIN,
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
      onChange: () => {},
    });
    expect((await down.poll()).state).toBe("unreachable");
    expect((await monitor(reply(200, { nonsense: true })).poll()).state).toBe("unreachable");
    expect((await monitor(reply(502)).poll()).state).toBe("unreachable");
  });
});

describe("badge and tray across servers", () => {
  const ok = (running: number, waiting: number, inbox = 0): RemoteStatus => ({
    state: "ok",
    activity: { running, waiting, inbox },
  });

  it("totals waiting on This Mac and every reachable remote", () => {
    expect(totalBadge(2, [ok(1, 3), ok(0, 0, 4)])).toBe(2 + 3 + 4);
    expect(
      totalBadge(0, [{ state: "unreachable", activity: { running: 0, waiting: 9, inbox: 9 } }]),
    ).toBe(0);
    expect(totalBadge(1, [{ state: "signed-out", activity: null }])).toBe(1);
  });
  it("lists each remote with its counts or its state", () => {
    const servers = [
      { id: "local", name: "This Mac", url: null },
      { id: "a", name: "Omarchy", url: ORIGIN },
      { id: "b", name: "Lab", url: "https://lab.ts.net" },
      { id: "c", name: "New", url: "https://new.ts.net" },
    ];
    const lines = trayServers(
      servers,
      new Map<string, RemoteStatus>([
        ["a", ok(2, 1)],
        ["b", { state: "signed-out", activity: null }],
      ]),
    );
    expect(lines).toEqual([
      { id: "a", name: "Omarchy", summary: "2 running, 1 waiting" },
      { id: "b", name: "Lab", summary: "signed out" },
      { id: "c", name: "New", summary: "connecting..." },
    ]);
    expect(serverSummary({ state: "unreachable", activity: null })).toBe("unreachable");
    expect(serverSummary(ok(0, 0))).toBe("idle");
    const view = trayView({
      activity: null,
      connected: false,
      autoUpdate: false,
      update: {
        phase: "idle",
        current: "1",
        latest: null,
        checkedAt: null,
        percent: null,
        error: null,
        unsupported: null,
      },
      servers: lines,
    });
    expect(view.servers).toHaveLength(3);
  });
});

describe("Servers menu", () => {
  const servers = Array.from({ length: 11 }, (_, i) => ({
    id: `s${i}`,
    name: `S${i}`,
    url: i ? "https://x.ts.net" : null,
  }));
  it("binds Cmd/Ctrl+1 to 9, then Add server and Manage servers", () => {
    const opened: string[] = [];
    const menu = serversMenu({
      list: servers,
      open: (id) => opened.push(id),
      add: () => {},
      manage: () => {},
    });
    const items = (menu.submenu ?? []) as Array<{
      label?: string;
      accelerator?: string;
      click?: () => void;
    }>;
    expect(items.slice(0, 11).map((i) => i.accelerator)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `CommandOrControl+${i + 1}`),
      undefined,
      undefined,
    ]);
    items[1]?.click?.();
    expect(opened).toEqual(["s1"]);
    expect(items.map((i) => i.label).slice(-2)).toEqual(["Add server...", "Manage servers..."]);
  });
  it("is part of the application menu", () => {
    const noop = () => {};
    const menu = appMenuTemplate("darwin", {
      openSettings: noop,
      openInbox: noop,
      checkForUpdates: noop,
      openDocs: noop,
      openLogs: noop,
      exportDiagnostics: noop,
      retryLoading: noop,
      quit: noop,
      zoom: noop,
      servers: { list: servers, open: noop, add: noop, manage: noop },
    });
    expect(menu.some((m) => m.label === "Servers")).toBe(true);
  });
});
