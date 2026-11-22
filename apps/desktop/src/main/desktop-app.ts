import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  type DesktopInfo,
  type DesktopServer,
  type DesktopServerAdd,
  type DesktopServerResult,
  type DesktopUpdateCommand,
  deepLinkPath,
  LOCAL_SERVER_ID,
  parseDeepLink,
} from "@codeden/contracts";
import { app, dialog, Menu, Notification, net, session, shell } from "electron";
import { CHANNELS } from "../shared/channels";
import { ActivityMonitor, type ServerStatus } from "./activity";
import type { LaunchArgs } from "./args";
import { AppBadge } from "./badge";
import { parseRemoteTag } from "./bridge-policy";
import { NativeBrowserFeature } from "./browser/feature";
import { type Connection, connect, launchUrl } from "./connection";
import { Diagnostics } from "./diagnostics";
import { exportDiagnostics } from "./diagnostics-menu";
import { armQuitWatchdog, forceExit } from "./exit";
import { type BridgeCaller, registerBridge } from "./ipc";
import { appMenuTemplate } from "./menu";
import { loadAfterReady, waitForServer } from "./recovery";
import { redactToken } from "./security";
import { homeFiles, mayReconnect, serverHealthy } from "./server-plan";
import { healthCheck } from "./servers/health";
import { RemoteMonitor, type RemoteStatus } from "./servers/monitor";
import { partitionFor, ServerStore } from "./servers/store";
import { totalBadge, trayServers } from "./servers/summary";
import {
  applyLaunchAtLogin,
  fileLogger,
  KeepAwake,
  launchAtLoginSupported,
  macSigned,
  openedAtLogin,
} from "./system";
import { AppTray } from "./tray";
import { trayView } from "./tray-view";
import { UpdateController } from "./updates/controller";
import { quitAction, standaloneAction, updateSupport } from "./updates/policy";
import { loadUpdater, waitForRunnerExit } from "./updates/updater";
import { MainWindow } from "./window";
import { windowShot } from "./window-shot";

const DOCS_URL = "https://github.com/leonvanzyl/codeden/blob/main/docs/desktop.md";
/** Longest a quit may take (browser hand-off 15 s + server stop up to 30 s) before it's forced. */
const QUIT_LIMIT_MS = 45_000;

type QuitInitiator =
  | "menu"
  | "tray"
  | "window"
  | "server-stop"
  | "server-crash"
  | "startup"
  | "system";

/** A window on another CodeDen server (§17.1) and its status poller. */
interface Remote {
  id: string;
  window: MainWindow;
  monitor: RemoteMonitor;
  /** The first load failed (the server was unreachable): opening it again reloads. */
  loadFailed: boolean;
  /** The last count its page set on the badge, used only while polling can't answer. */
  uiBadge: number;
}

/**
 * The desktop app (§17): one window on the server's UI, a tray with live counts, the app
 * badge, keep-awake, native notifications and folder picking, `codeden://` links and updates
 * from GitHub Releases. It starts the server (or attaches to a running one for the same home)
 * and leaves the runner running when it quits, as `codeden` does.
 */
export class DesktopApp {
  private readonly log: (message: string) => void;
  private readonly dist = import.meta.dirname;
  private window!: MainWindow;
  private tray!: AppTray;
  private badge!: AppBadge;
  private readonly keepAwake = new KeepAwake();
  private updates!: UpdateController;
  private browser!: NativeBrowserFeature;
  private monitor: ActivityMonitor | undefined;
  private store!: ServerStore;
  private readonly remotes = new Map<string, Remote>();
  private localBadge = 0;
  private conn: Connection | undefined;
  private status: ServerStatus = { connected: false, activity: null, settings: null };
  private pendingPath: string | null = null;
  private loaded = false;
  private quitting = false;
  private quitInitiator: QuitInitiator = "system";
  private readonly diagnostics: Diagnostics;
  private uiLoad: Connection | undefined;
  private connecting = false;
  private quitReady = false;
  private standaloneTimer: NodeJS.Timeout | undefined;

  /** True once a quit has started (startup errors after that are part of quitting). */
  get isQuitting(): boolean {
    return this.quitting;
  }
  private notifiedUpdate: string | null = null;

  constructor(private readonly args: LaunchArgs) {
    const { logs } = homeFiles(args.home);
    this.log = fileLogger(join(logs, "desktop.log"));
    this.diagnostics = new Diagnostics(join(logs, "desktop-diagnostics.json"));
    if (args.deepLink) this.pendingPath = this.pathFor(args.deepLink);
  }

  private asset(name: string): string {
    return join(this.dist, "assets", name);
  }

  async start(): Promise<void> {
    this.log(`app: CodeDen ${app.getVersion()} starting (home ${this.args.home})`);
    const unsupported = updateSupport({
      packaged: app.isPackaged,
      platform: process.platform,
      // `CodeDen.app/Contents/Resources/app` -> `CodeDen.app`.
      macSigned: await macSigned(join(app.getAppPath(), "..", "..", "..")),
    });
    this.updates = new UpdateController({
      current: app.getVersion(),
      unsupported,
      updater: () => loadUpdater(this.log),
      beforeInstall: () => this.prepareInstall(),
      log: this.log,
    });
    this.updates.onChange((state) => {
      this.conn?.server?.send({ type: "update.state", state });
      this.refresh();
      this.notifyUpdate();
    });

    app.on("child-process-gone", (_event, details) => {
      this.log(
        `app: ${details.type} child exited (code ${details.exitCode}, reason ${details.reason})`,
      );
      this.diagnostics.record({
        kind: "child-exit",
        reason: details.reason,
        code: details.exitCode,
      });
    });
    this.store = new ServerStore({
      file: join(homeFiles(this.args.home).desktop, "servers.json"),
      check: healthCheck(net.fetch.bind(net) as typeof fetch),
      appVersion: app.getVersion(),
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(this.menu()));
    this.tray = new AppTray(
      this.asset(process.platform === "darwin" ? "trayTemplate.png" : "tray.png"),
      {
        open: () => this.show(),
        openInbox: () => this.navigate("/inbox"),
        openServer: (id) => this.openServer(id),
        update: (command) => void this.runUpdate(command),
        quit: () => this.quit("tray"),
      },
    );
    this.window = new MainWindow({
      preload: join(this.dist, "preload.cjs"),
      icon: this.asset("icon.png"),
      stateFile: join(homeFiles(this.args.home).desktop, "window-state.json"),
      show: !this.args.hidden && !openedAtLogin(),
      hideOnClose: () => this.status.settings?.desktop.closeToTray ?? true,
      quit: () => this.quit("window"),
      onRendererGone: (details, retry) => {
        this.diagnostics.record({
          kind: "renderer-exit",
          reason: details.reason,
          code: details.exitCode,
        });
        if (this.uiLoad === this.conn) return;
        this.loaded = false;
        if (retry) void this.loadUi();
        else void this.window.showRecovery();
      },
      log: this.log,
    });
    this.badge = new AppBadge(() => this.window.window, this.asset("badge.png"));
    this.browser = new NativeBrowserFeature({ window: () => this.window.window, log: this.log });
    registerBridge({
      caller: (id) => this.callerOf(id),
      info: (caller) => this.info(caller),
      notificationClick: (tag) => this.notificationClick(tag),
      setBadge: (caller, count) => this.setBadge(caller, count),
      icon: this.asset("icon.png"),
      log: this.log,
      browser: this.browser.browsers,
      servers: {
        list: () => this.serverList(),
        open: (id) => this.openServer(id),
        add: (input) => this.addServer(input),
        rename: (id, name) => this.renameServer(id, name),
        remove: (id) => this.removeServer(id),
      },
    });
    this.exposeForTests();
    await this.open();
    // Saved servers load in the background, so their notifications and counts work from launch.
    for (const server of this.store.list().filter((x) => x.url)) this.startRemote(server.id, false);
  }

  /** Connect to (or start) the server and load the UI. */
  private async open(): Promise<void> {
    if (this.conn || this.connecting || this.quitting) return;
    this.connecting = true;
    try {
      this.conn = await connect({
        args: this.args,
        serverEntry: join(this.dist, "server.js"),
        onUpdateCommand: (id, command) => void this.onServerCommand(id, command),
        onExit: (exit) => this.diagnostics.record({ kind: "server-exit", ...exit }),
        onUnexpectedExit: (code) => {
          void this.onServerExit(code).catch(() => {
            this.log("app: server restart failed");
            return this.window.showRecovery();
          });
        },
        log: this.log,
      });
    } catch (error) {
      this.log(`app: no server: ${String(error)}`);
      await dialog.showMessageBox({
        type: "error",
        title: "CodeDen could not start",
        message: "CodeDen could not start its server.",
        detail: `${error instanceof Error ? error.message : String(error)}\n\nSee ${homeFiles(this.args.home).logs}.`,
      });
      await this.window.showRecovery();
      return;
    } finally {
      this.connecting = false;
    }
    if (this.quitting) {
      await this.conn.server?.stop({ stopRunner: false });
      return;
    }
    this.conn.server?.send({ type: "update.state", state: this.updates.state });
    this.browser.connect(this.conn);

    this.monitor?.stop();
    this.monitor = new ActivityMonitor({
      baseUrl: this.conn.url,
      token: this.conn.token,
      onChange: (status) => this.onStatus(status),
    });
    this.monitor.start();
    if (!this.conn.server) this.startStandaloneUpdates();
    await this.loadUi();
  }

  private async loadUi(): Promise<void> {
    const conn = this.conn;
    if (!conn || this.quitting || this.uiLoad === conn) return;
    this.uiLoad = conn;
    const pendingPath = this.pendingPath;
    const load = async () => {
      if (this.quitting || this.conn !== conn) return;
      await this.window.load(launchUrl(conn, pendingPath ?? "/"));
    };
    try {
      await loadAfterReady(load, () =>
        waitForServer(conn.url, () => !this.quitting && this.conn === conn),
      );
      if (this.quitting || this.conn !== conn) return;
      this.loaded = true;
      const nextPath = this.pendingPath;
      this.pendingPath = null;
      if (nextPath && nextPath !== pendingPath) this.navigate(nextPath);
    } catch (error) {
      if (this.quitting || this.conn !== conn) return;
      this.log(`app: UI navigation failed: ${String(error)}`);
      this.loaded = false;
      await this.window.showRecovery();
    } finally {
      if (this.uiLoad === conn) this.uiLoad = undefined;
    }
  }

  private async retryLoading(): Promise<void> {
    if (this.quitting) return;
    const conn = this.conn;
    if (conn && !conn.server) {
      const reconnect = !(await serverHealthy(conn.url)) && (await mayReconnect(this.args.home));
      if (this.conn !== conn || this.quitting) return;
      if (reconnect) {
        this.conn = undefined;
        this.loaded = false;
        this.monitor?.stop();
        clearInterval(this.standaloneTimer);
      }
    }
    if (this.conn) await this.loadUi();
    else await this.open();
  }

  private quit(reason: QuitInitiator): void {
    if (this.quitting) return;
    this.quitInitiator = reason;
    app.quit();
  }

  startupFailed(): void {
    this.log("app: quit initiated by startup failure");
    this.diagnostics.record({ kind: "quit", reason: "startup" });
    forceExit(1);
  }

  show(): void {
    this.window?.show();
  }

  /** A second launch (or a `codeden://` link on Windows and Linux) focuses this instance. */
  secondInstance(args: LaunchArgs): void {
    if (args.deepLink) this.openLink(args.deepLink);
    else if (!args.hidden) this.show();
  }

  openLink(url: string): void {
    const path = this.pathFor(url);
    if (!path) return;
    if (this.loaded) this.navigate(path);
    else this.pendingPath = path;
  }

  private pathFor(url: string): string | null {
    const target = parseDeepLink(url);
    if (!target) this.log(`app: ignored link ${url.slice(0, 200)}`);
    return target ? deepLinkPath(target) : null;
  }

  private navigate(path: string): void {
    this.show();
    if (this.loaded) this.window.window.webContents.send(CHANNELS.navigate, path);
    else this.pendingPath = path;
  }

  /** Quitting: install a downloaded update on the way out, else leave the runner running. */
  beforeQuit(event: Electron.Event): void {
    if (this.quitReady) return;
    event.preventDefault();
    if (this.quitting) return;
    this.quitting = true;
    this.log(`app: quit initiated by ${this.quitInitiator}`);
    this.diagnostics.record({ kind: "quit", reason: this.quitInitiator });
    // Every step below is bounded, but quitting must finish even if one isn't: a timer here,
    // and a separate process for when the main thread itself is stuck in native shutdown.
    const watchdog = setTimeout(() => {
      this.log(`app: still quitting after ${QUIT_LIMIT_MS / 1000} s; exiting now`);
      forceExit(0);
    }, QUIT_LIMIT_MS);
    const hardStop = armQuitWatchdog(QUIT_LIMIT_MS + 5_000, this.log);
    void (async () => {
      try {
        this.allowCloseAll();
        clearInterval(this.standaloneTimer);
        this.monitor?.stop();
        for (const remote of this.remotes.values()) remote.monitor.stop();
        this.keepAwake.set(false);
        // Open session browsers move to the runner's Chromium before the views go.
        await this.browser?.quit();
        if (this.updates && quitAction(this.updates.state.phase) === "install") {
          // Installing drains the runner first (up to 90 s); the installer ends the app.
          clearTimeout(watchdog);
          hardStop.cancel();
          await this.updates.installOnQuit();
          return;
        }
        await this.conn?.server?.stop({ stopRunner: false });
        this.tray?.destroy();
      } catch (error) {
        // A failed step must not leave the app unable to quit.
        this.log(`app: while quitting: ${String(error)}`);
      }
      this.quitReady = true;
      app.quit();
    })();
  }

  /** Before the installer runs: stop the server and drain the runner (as `codeden stop`). */
  private async prepareInstall(): Promise<void> {
    this.log("app: preparing to quit for an update");
    this.diagnostics.record({ kind: "quit", reason: "update" });
    this.allowCloseAll();
    this.monitor?.stop();
    const server = this.conn?.server;
    if (server) {
      await server.stop({ stopRunner: true, timeoutMs: 90_000 });
      await waitForRunnerExit(homeFiles(this.args.home).runnerLock, 15_000, this.log);
    }
    this.quitReady = true;
  }

  private async onServerCommand(id: string, command: DesktopUpdateCommand): Promise<void> {
    let error: string | null = null;
    try {
      await this.updates.run(command);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.conn?.server?.send({ type: "update.done", id, error });
  }

  private async runUpdate(command: DesktopUpdateCommand): Promise<void> {
    await this.updates.run(command).catch((e: unknown) => this.log(`updates: ${String(e)}`));
  }

  private async onServerExit(code: number | null): Promise<void> {
    if (this.quitting) return;
    this.loaded = false;
    this.conn = undefined;
    this.monitor?.stop();
    if (code === 0) {
      // Stopped on purpose (`codeden stop` from a terminal): quit with it.
      this.log("app: the server was stopped; quitting");
      this.quit("server-stop");
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "CodeDen",
      message: "The CodeDen server stopped unexpectedly.",
      detail: `Agents keep running in the runner. See ${homeFiles(this.args.home).logs}.`,
      buttons: ["Restart", "Quit"],
      defaultId: 0,
    });
    if (this.quitting) return;
    if (response === 0) await this.open();
    else this.quit("server-crash");
  }

  private onStatus(status: ServerStatus): void {
    this.status = status;
    const desktop = status.settings?.desktop;
    if (desktop) applyLaunchAtLogin(desktop.launchAtLogin);
    // Keep-awake follows This Mac's agents only: a remote server's work doesn't run here.
    const running = status.activity?.running ?? 0;
    this.keepAwake.set(Boolean(desktop?.keepAwake ?? true) && running > 0);
    this.refresh();
  }

  private refresh(): void {
    if (!this.tray || !this.updates) return;
    const view = trayView({
      activity: this.status.activity,
      connected: this.status.connected,
      update: this.updates.state,
      autoUpdate: this.status.settings?.updates.mode === "auto",
      servers: trayServers(this.store.list(), this.remoteStatuses()),
    });
    this.tray.update(view);
    if (this.status.connected) this.localBadge = view.badge;
    this.applyBadge();
  }

  private remoteStatuses(): Map<string, RemoteStatus> {
    return new Map([...this.remotes].map(([id, r]) => [id, r.monitor.status]));
  }

  /** The app icon's badge: what waits on you on This Mac and on every remote server. */
  private applyBadge(): void {
    const remotes = [...this.remotes.values()].map((r): RemoteStatus => {
      const status = r.monitor.status;
      // While a server can't be polled, the count its own page set stands in.
      return status.state !== "ok" && r.uiBadge > 0
        ? { state: "ok", activity: { running: 0, waiting: r.uiBadge, inbox: 0 } }
        : status;
    });
    this.badge?.set(totalBadge(this.localBadge, remotes));
  }

  private setBadge(caller: BridgeCaller, count: number): void {
    if (!caller.server) this.localBadge = count;
    else {
      const remote = this.remotes.get(caller.server.id);
      if (remote) remote.uiBadge = count;
    }
    this.applyBadge();
  }

  // ------------------------------------------------------------ other servers (§17.1)

  private serverList(): DesktopServer[] {
    return this.store.list().map((s) => ({
      ...s,
      open: s.url === null || this.remotes.has(s.id),
    }));
  }

  /** Every window, This Mac's first. */
  private windows(): Array<{ id: string; window: MainWindow }> {
    return [
      { id: LOCAL_SERVER_ID, window: this.window },
      ...[...this.remotes.values()].map((r) => ({ id: r.id, window: r.window })),
    ];
  }

  private allowCloseAll(): void {
    for (const { window } of this.windows()) window?.allowClose();
  }

  private callerOf(webContentsId: number): BridgeCaller | null {
    for (const { id, window } of this.windows()) {
      if (
        !window ||
        window.window.isDestroyed() ||
        window.window.webContents.id !== webContentsId
      ) {
        continue;
      }
      if (id === LOCAL_SERVER_ID) {
        return { kind: "local", origin: window.serverOrigin, server: null, window: window.window };
      }
      const entry = this.store.get(id);
      if (!entry) return null;
      return {
        kind: "remote",
        origin: window.serverOrigin,
        server: { id, name: entry.name },
        window: window.window,
      };
    }
    return null;
  }

  /** Create a remote server's window (hidden unless `show`) and start polling it. */
  private startRemote(id: string, show: boolean): Remote | undefined {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    const existing = this.remotes.get(id);
    if (existing) return existing;
    const partition = partitionFor(id);
    const window = new MainWindow({
      preload: join(this.dist, "preload.cjs"),
      icon: this.asset("icon.png"),
      stateFile: join(homeFiles(this.args.home).desktop, `server-${id}-window.json`),
      show,
      // Closing hides it: its page keeps running for notifications, and the app stays in the tray.
      hideOnClose: () => true,
      quit: () => this.quit("window"),
      onRendererGone: (details, retry) => {
        this.diagnostics.record({
          kind: "renderer-exit",
          reason: details.reason,
          code: details.exitCode,
        });
        const gone = this.remotes.get(id);
        if (!gone) return;
        // Reload once; after a second exit within 30 s, opening it from Servers reloads it.
        if (retry) void this.loadRemote(gone, entry.url);
        else gone.loadFailed = true;
      },
      log: this.log,
      remote: { id, name: entry.name, partition },
    });
    const ses = session.fromPartition(partition);
    const monitor = new RemoteMonitor({
      baseUrl: entry.url,
      // Through this server's own session, so its device cookie is sent and nothing else.
      fetch: (url, init) => ses.fetch(url, init),
      onChange: () => this.refresh(),
    });
    const remote: Remote = { id, window, monitor, loadFailed: false, uiBadge: 0 };
    this.remotes.set(id, remote);
    void this.loadRemote(remote, entry.url);
    monitor.start();
    return remote;
  }

  private async loadRemote(remote: Remote, url: string): Promise<void> {
    try {
      await remote.window.load(url);
      remote.loadFailed = false;
    } catch (error) {
      remote.loadFailed = true;
      this.log(`servers: could not load ${url}: ${redactToken(String(error)).slice(0, 300)}`);
    }
  }

  /** Show a server's window: This Mac's, or a remote's (opened on first use). */
  private openServer(id: string): void {
    if (id === LOCAL_SERVER_ID) {
      this.show();
      return;
    }
    const entry = this.store.get(id);
    if (!entry) return;
    const remote = this.remotes.get(id) ?? this.startRemote(id, true);
    if (!remote) return;
    if (remote.loadFailed) void this.loadRemote(remote, entry.url);
    remote.window.show();
  }

  private async addServer(input: DesktopServerAdd): Promise<DesktopServerResult> {
    const result = await this.store.add(input);
    if (result.ok) {
      this.startRemote(result.server.id, false);
      this.serversChanged();
    }
    return result;
  }

  private renameServer(id: string, name: string): DesktopServerResult {
    const result = this.store.rename(id, name);
    if (result.ok) {
      this.remotes.get(id)?.window.rename(result.server.name);
      this.serversChanged();
    }
    return result;
  }

  /** Remove a server: its window, its poller and everything stored in its session. */
  private async removeServer(id: string): Promise<boolean> {
    if (!this.store.remove(id)) return false;
    const remote = this.remotes.get(id);
    remote?.monitor.stop();
    remote?.window.destroy();
    this.remotes.delete(id);
    const ses = session.fromPartition(partitionFor(id));
    try {
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
    } catch (error) {
      this.log(`servers: could not clear a removed server's session: ${String(error)}`);
    }
    rmSync(join(homeFiles(this.args.home).desktop, `server-${id}-window.json`), { force: true });
    this.serversChanged();
    return true;
  }

  /** The list changed: menus, tray, badge and every page's switcher follow. */
  private serversChanged(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate(this.menu()));
    this.refresh();
    for (const { window } of this.windows()) {
      if (!window.window.isDestroyed()) window.window.webContents.send(CHANNELS.serversChanged);
    }
  }

  /** The server manager lives in This Mac's window. */
  private manageServers(add: boolean): void {
    this.show();
    if (this.loaded) this.window.window.webContents.send(CHANNELS.serversManage, { add });
  }

  private notificationClick(tag: string): void {
    const remote = parseRemoteTag(tag);
    if (!remote) {
      this.show();
      this.window.window.webContents.send(CHANNELS.notificationClick, tag);
      return;
    }
    const target = this.remotes.get(remote.serverId);
    if (!target) return;
    target.window.show();
    target.window.window.webContents.send(CHANNELS.notificationClick, remote.tag);
  }

  /** Attached to a server started by `codeden`: follow the update mode here (§17). */
  private startStandaloneUpdates(): void {
    const conn = this.conn;
    const tick = () => {
      if (this.conn !== conn) return;
      const settings = this.status.settings;
      if (!settings) return;
      const state = this.updates.state;
      const action = standaloneAction({
        mode: settings.updates.mode,
        phase: state.phase,
        unsupported: state.unsupported,
        checkedAt: state.checkedAt ? Date.parse(state.checkedAt) : null,
        now: Date.now(),
      });
      if (action) void this.runUpdate(action);
    };
    this.standaloneTimer = setInterval(tick, 60_000);
    setTimeout(tick, 5_000).unref();
  }

  /** Without our own server there is no update banner: say it with a notification. */
  private notifyUpdate(): void {
    const state = this.updates.state;
    if (this.conn?.server !== null || !Notification.isSupported() || !state.latest) return;
    if (state.phase !== "available" && state.phase !== "downloaded") return;
    const key = `${state.phase}:${state.latest}`;
    if (this.notifiedUpdate === key) return;
    this.notifiedUpdate = key;
    new Notification({
      title: `CodeDen ${state.latest} is ${state.phase === "downloaded" ? "ready" : "available"}`,
      body:
        state.phase === "downloaded"
          ? "It installs when you quit CodeDen, or choose Restart to update in the tray menu."
          : "Download it from the tray menu.",
    }).show();
  }

  private info(caller: BridgeCaller): DesktopInfo {
    if (caller.server) {
      // A window on another server: nothing about this Mac's own server or its integrations.
      return {
        version: app.getVersion(),
        platform: process.platform as DesktopInfo["platform"],
        packaged: app.isPackaged,
        ownsServer: false,
        launchAtLoginSupported: false,
        nativeBrowser: false,
        server: { ...caller.server, remote: true },
      };
    }
    return {
      version: app.getVersion(),
      platform: process.platform as DesktopInfo["platform"],
      packaged: app.isPackaged,
      ownsServer: Boolean(this.conn?.server),
      launchAtLoginSupported,
      nativeBrowser: true,
      server: { id: LOCAL_SERVER_ID, name: "This Mac", remote: false },
    };
  }

  private menu() {
    return appMenuTemplate(process.platform, {
      openSettings: () => this.navigate("/settings/general"),
      openInbox: () => this.navigate("/inbox"),
      checkForUpdates: () => {
        this.navigate("/settings/about");
        void this.runUpdate("check");
      },
      openDocs: () => void shell.openExternal(DOCS_URL),
      openLogs: () => void shell.openPath(homeFiles(this.args.home).logs),
      exportDiagnostics: () => void exportDiagnostics(this.diagnostics),
      retryLoading: () => {
        void this.retryLoading().catch(() => this.log("app: could not retry loading the UI"));
      },
      quit: () => this.quit("menu"),
      zoom: (command) => {
        // The window in front: each remembers its own zoom.
        const focused = this.windows().find((w) => w.window.window.isFocused());
        (focused?.window ?? this.window)?.zoom(command);
        if (!focused || focused.id === LOCAL_SERVER_ID) this.browser?.browsers.layout();
      },
      servers: {
        list: this.store.list(),
        open: (id) => this.openServer(id),
        add: () => this.manageServers(true),
        manage: () => this.manageServers(false),
      },
    });
  }

  /** Read-only hooks for the desktop smoke test (`CODEDEN_DESKTOP_TEST=1`). */
  private exposeForTests(): void {
    if (process.env.CODEDEN_DESKTOP_TEST !== "1") return;
    (globalThis as Record<string, unknown>).__codedenDesktopTest = {
      trayLabels: () => this.tray.menuLabels(),
      status: () => this.status,
      ownsServer: () => Boolean(this.conn?.server),
      serverPid: () => this.conn?.server?.pid ?? null,
      keepAwake: () => this.keepAwake.active,
      updateState: () => this.updates.state,
      zoomFactor: () => this.window.zoomFactor,
      nativeViews: () => this.browser.browsers.views(),
      windowShot: () => windowShot(this.window.window),
    };
  }
}
