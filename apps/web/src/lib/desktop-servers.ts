import {
  type CodedenDesktopApi,
  type CodedenDesktopServersApi,
  type DesktopServer,
  LOCAL_SERVER_ID,
} from "@codeden/contracts";
import { useEffect, useState } from "react";

/** The desktop app's server list (§17.1), or null in a browser and in older apps. */
export function desktopServersApi(
  target: { codedenDesktop?: CodedenDesktopApi } | undefined = typeof window === "undefined"
    ? undefined
    : (window as { codedenDesktop?: CodedenDesktopApi }),
): CodedenDesktopServersApi | null {
  return target?.codedenDesktop?.servers ?? null;
}

/** The id of the server this window shows: a remote's, else This Mac's. */
export function currentServerId(
  target: { codedenDesktop?: CodedenDesktopApi } | undefined = typeof window === "undefined"
    ? undefined
    : (window as { codedenDesktop?: CodedenDesktopApi }),
): string {
  return target?.codedenDesktop?.remote?.id ?? LOCAL_SERVER_ID;
}

/** The server list, kept current while the component is mounted; empty outside the desktop app. */
export function useDesktopServers(): DesktopServer[] {
  const api = desktopServersApi();
  const [servers, setServers] = useState<DesktopServer[]>([]);
  useEffect(() => {
    if (!api) return;
    let live = true;
    const load = () =>
      void api.list().then(
        (list) => live && setServers(list),
        () => {},
      );
    load();
    const off = api.onChange(load);
    return () => {
      live = false;
      off();
    };
  }, [api]);
  return servers;
}
