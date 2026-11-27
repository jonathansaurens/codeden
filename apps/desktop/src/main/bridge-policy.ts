import { isServerUrl } from "./security";

/** The bridge calls (`window.codedenDesktop`), by what they do. */
export type BridgeCall =
  | "info"
  | "pickFolder"
  | "notify"
  | "openExternal"
  | "setBadge"
  | "browser"
  | "servers.list"
  | "servers.open"
  | "servers.manage";

/**
 * What a window on another CodeDen server may call (§17.1). `pickFolder` would hand that
 * server a path on this Mac, and the session browser's native views are relayed on this Mac,
 * which can't reach a remote runner; changing the server list is This Mac's window only.
 * (`onNotificationClick` and `onNavigate` are events the main process sends, not calls.)
 */
export const REMOTE_CALLS: ReadonlySet<BridgeCall> = new Set<BridgeCall>([
  "info",
  "notify",
  "openExternal",
  "setBadge",
  "servers.list",
  "servers.open",
]);

/** The window a call came from: its kind and the one origin it may show. */
export interface CallerWindow {
  kind: "local" | "remote";
  origin: string | null;
}

/**
 * Whether a bridge call is accepted: the sender must be one of our windows, showing that
 * window's own server (the frame's URL on its origin), and a remote window only makes the
 * calls above.
 */
export function bridgeAllowed(
  call: BridgeCall,
  caller: CallerWindow | null,
  frameUrl: string,
): boolean {
  if (!caller || caller.origin === null || !isServerUrl(frameUrl, caller.origin)) return false;
  return caller.kind === "local" || REMOTE_CALLS.has(call);
}

/** The notification tag of a remote server's notification: `r:<server id>:<the page's tag>`. */
export function remoteTag(serverId: string, tag: string): string {
  return `r:${serverId}:${tag}`;
}

/** Split a notification tag back into its server and the page's own tag (null for This Mac's). */
export function parseRemoteTag(tag: string): { serverId: string; tag: string } | null {
  const match = /^r:([a-f0-9]{12}):([\s\S]*)$/.exec(tag);
  return match ? { serverId: match[1] as string, tag: match[2] as string } : null;
}
