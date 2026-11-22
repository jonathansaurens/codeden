import {
  type DesktopInfo,
  DesktopNotification,
  type DesktopServer,
  DesktopServerAdd,
  type DesktopServerResult,
  Id,
  type NativeBrowserBounds,
  NativeBrowserShow,
} from "@codeden/contracts";
import {
  type BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Notification,
  shell,
} from "electron";
import { z } from "zod";
import { CHANNELS } from "../shared/channels";
import { type BridgeCall, bridgeAllowed, type CallerWindow, remoteTag } from "./bridge-policy";
import { createNotifier } from "./notifications";
import { externalUrl, redactToken } from "./security";

/** A window that may call the bridge: This Mac's, or one on a remote server (§17.1). */
export interface BridgeCaller extends CallerWindow {
  /** The remote server this window shows; null for This Mac's window. */
  server: { id: string; name: string } | null;
  window: BrowserWindow;
}

export interface BridgeHost {
  /** The window with this web contents, null for anything that isn't one of ours. */
  caller: (webContentsId: number) => BridgeCaller | null;
  info: (caller: BridgeCaller) => DesktopInfo;
  /** A notification was clicked: bring its window up and hand the tag to its page. */
  notificationClick: (tag: string) => void;
  /** `notify` from a remote window is named after its server; the tag routes the click back. */
  setBadge: (caller: BridgeCaller, count: number) => void;
  icon: string;
  log: (message: string) => void;
  /** Native browser views (§17 Phase 2); This Mac's window only. */
  browser: {
    show(sessionId: string, bounds: NativeBrowserBounds): void;
    hide(sessionId: string): void;
    capture(sessionId: string): Promise<string | null>;
    inspect(sessionId: string): void;
  };
  servers: {
    list: () => DesktopServer[];
    open: (id: string) => void;
    add: (input: DesktopServerAdd) => Promise<DesktopServerResult>;
    rename: (id: string, name: string) => DesktopServerResult;
    remove: (id: string) => Promise<boolean>;
  };
}

const PickFolder = z
  .object({ title: z.string().max(200).optional(), defaultPath: z.string().max(4096).optional() })
  .default({});

/**
 * The main-process side of `window.codedenDesktop` (§17). Calls are accepted only from the
 * CodeDen window showing the server's UI, and every payload is validated.
 */
export function registerBridge(host: BridgeHost): void {
  /** The calling window, when this call is allowed from it; else null (and logged). */
  const allow = (
    call: BridgeCall,
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): BridgeCaller | null => {
    const caller = host.caller(event.sender.id);
    const url = event.senderFrame?.url ?? "";
    if (caller && bridgeAllowed(call, caller, url)) return caller;
    host.log(
      `bridge: refused ${call} from ${caller?.kind ?? "an unknown"} window (${redactToken(url).slice(0, 100) || "no frame"})`,
    );
    return null;
  };

  ipcMain.handle(CHANNELS.info, (event) => {
    const caller = allow("info", event);
    return caller ? host.info(caller) : null;
  });

  ipcMain.handle(CHANNELS.pickFolder, async (event, raw) => {
    const caller = allow("pickFolder", event);
    if (!caller) return null;
    const opts = PickFolder.parse(raw ?? {});
    const options = {
      title: opts.title ?? "Choose a folder",
      defaultPath: opts.defaultPath,
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    };
    const result = await dialog.showOpenDialog(caller.window, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // A notification with the tag of one still on screen replaces it (a grouped burst stays one).
  const notifier = createNotifier(
    (opts) =>
      new Notification({ ...opts, icon: process.platform === "darwin" ? undefined : host.icon }),
    (tag) => {
      if (tag) host.notificationClick(tag);
    },
  );
  let anonymous = 0;
  ipcMain.on(CHANNELS.notify, (event, raw) => {
    const caller = allow("notify", event);
    if (!caller || !Notification.isSupported()) return;
    const parsed = DesktopNotification.safeParse(raw);
    if (!parsed.success) return;
    const { title, body, tag } = parsed.data;
    if (caller.server) {
      // Named after the server, and tagged with it so a click finds that server's window.
      notifier.show({
        title: `${caller.server.name}: ${title}`.slice(0, 200),
        body: body ?? "",
        tag: remoteTag(caller.server.id, tag || `n${++anonymous}`),
      });
      return;
    }
    notifier.show({ title, body: body ?? "", tag: tag || undefined });
  });

  ipcMain.on(CHANNELS.openExternal, (event, raw) => {
    if (!allow("openExternal", event) || typeof raw !== "string") return;
    const url = externalUrl(raw);
    if (url) void shell.openExternal(url);
  });

  ipcMain.on(CHANNELS.setBadge, (event, raw) => {
    const caller = allow("setBadge", event);
    if (!caller) return;
    const count = z.int().min(0).max(100_000).safeParse(raw);
    if (count.success) host.setBadge(caller, count.data);
  });

  // Native browser views: the UI only places them; tabs and navigation go through the server.
  // This Mac's window only: a remote runner can't be reached by the relay on this machine.
  ipcMain.on(CHANNELS.browserShow, (event, raw) => {
    if (!allow("browser", event)) return;
    const show = NativeBrowserShow.safeParse(raw);
    if (show.success) host.browser.show(show.data.sessionId, show.data.bounds);
  });
  ipcMain.on(CHANNELS.browserHide, (event, raw) => {
    if (!allow("browser", event)) return;
    const sessionId = Id.safeParse(raw);
    if (sessionId.success) host.browser.hide(sessionId.data);
  });
  ipcMain.handle(CHANNELS.browserCapture, (event, raw) => {
    if (!allow("browser", event)) return null;
    const sessionId = Id.safeParse(raw);
    return sessionId.success ? host.browser.capture(sessionId.data) : null;
  });
  ipcMain.on(CHANNELS.browserInspect, (event, raw) => {
    if (!allow("browser", event)) return;
    const sessionId = Id.safeParse(raw);
    if (sessionId.success) host.browser.inspect(sessionId.data);
  });

  // The server list: every window reads it and opens another; only This Mac's window changes it.
  const ServerId = z.string().min(1).max(40);
  ipcMain.handle(CHANNELS.serversList, (event) =>
    allow("servers.list", event) ? host.servers.list() : [],
  );
  ipcMain.on(CHANNELS.serversOpen, (event, raw) => {
    const id = ServerId.safeParse(raw);
    if (allow("servers.open", event) && id.success) host.servers.open(id.data);
  });
  ipcMain.handle(CHANNELS.serversAdd, async (event, raw): Promise<DesktopServerResult> => {
    const refused = { ok: false, error: "Not allowed here." } as const;
    if (!allow("servers.manage", event)) return refused;
    const input = DesktopServerAdd.safeParse(raw);
    return input.success ? host.servers.add(input.data) : { ok: false, error: "Invalid server." };
  });
  ipcMain.handle(CHANNELS.serversRename, (event, id, name): DesktopServerResult => {
    const ok = ServerId.safeParse(id);
    if (!allow("servers.manage", event) || !ok.success || typeof name !== "string") {
      return { ok: false, error: "Not allowed here." };
    }
    return host.servers.rename(ok.data, name.slice(0, 200));
  });
  ipcMain.handle(CHANNELS.serversRemove, async (event, raw) => {
    const id = ServerId.safeParse(raw);
    if (!allow("servers.manage", event) || !id.success) return false;
    return host.servers.remove(id.data);
  });
}
