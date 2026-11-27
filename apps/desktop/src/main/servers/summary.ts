import type { DesktopServer } from "@codeden/contracts";
import type { RemoteStatus } from "./monitor";

/** What waits on a person on one server: the larger of waiting agents and open inbox items. */
export function waitingOn(activity: { waiting: number; inbox: number } | null): number {
  return activity ? Math.max(activity.inbox, activity.waiting) : 0;
}

/** The dock badge: This Mac's count plus every reachable, signed-in remote's. */
export function totalBadge(local: number, remotes: readonly RemoteStatus[]): number {
  return remotes.reduce(
    (sum, r) => sum + (r.state === "ok" ? waitingOn(r.activity) : 0),
    Math.max(0, local),
  );
}

/** One server's tray line (Open is its own menu item). */
export interface TrayServer {
  id: string;
  name: string;
  summary: string;
}

/** `2 running, 1 waiting`, or why there are no counts. */
export function serverSummary(status: RemoteStatus): string {
  if (status.state === "signed-out") return "signed out";
  if (status.state === "unreachable") return "unreachable";
  if (!status.activity) return "connecting...";
  const { running, waiting } = status.activity;
  return (
    [running > 0 ? `${running} running` : null, waiting > 0 ? `${waiting} waiting` : null]
      .filter(Boolean)
      .join(", ") || "idle"
  );
}

export function trayServers(
  servers: readonly DesktopServer[],
  statuses: ReadonlyMap<string, RemoteStatus>,
): TrayServer[] {
  return servers
    .filter((s) => s.url !== null)
    .map((s) => ({
      id: s.id,
      name: s.name,
      summary: serverSummary(statuses.get(s.id) ?? { state: "starting", activity: null }),
    }));
}
