import { isPrivateHttpOrigin } from "@codeden/contracts";

/** Chromium's switch that gives listed `http://` origins secure-context features. */
export const INSECURE_ORIGIN_SWITCH = "unsafely-treat-insecure-origin-as-secure";

/**
 * The value of `INSECURE_ORIGIN_SWITCH` for the saved servers (§17.1): only the `http://`
 * origins on a private network or VPN, so their windows get notifications and the microphone.
 * Null when there are none (the switch is then left off). Chromium reads it once at start, so
 * a server added later gets these features after the app restarts.
 */
export function insecureOriginSwitch(urls: readonly string[]): string | null {
  const origins = [...new Set(urls.filter(isPrivateHttpOrigin))];
  return origins.length > 0 ? origins.join(",") : null;
}
