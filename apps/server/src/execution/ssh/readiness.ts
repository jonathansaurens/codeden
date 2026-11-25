import type { MachineProvider, ProviderStatus } from "@codeden/contracts";

/** Issues after which a provider can't start new sessions. */
const BLOCKING = new Set(["not_installed", "broken_install", "not_logged_in"]);

/**
 * Whether a provider can run new sessions on a machine, from that machine's own detection
 * (`provider.detect`): installed, supported and signed in there. A provider whose sign-in can't
 * be told (`loggedIn: null`) counts as ready, as on the home runner. Before the first report it
 * is not ready, with that as the reason.
 */
export function providerReadiness(
  status: ProviderStatus | undefined,
): Pick<MachineProvider, "ready" | "reason"> {
  if (!status) return { ready: false, reason: "not checked yet" };
  if (!status.installed) return { ready: false, reason: "not installed" };
  const blocking = status.issues.find(
    (i) => BLOCKING.has(i.code) || (i.code === "version_unsupported" && i.minVersion),
  );
  if (blocking) return { ready: false, reason: blocking.message };
  if (status.loggedIn === false) return { ready: false, reason: "not signed in" };
  return { ready: true, reason: null };
}
