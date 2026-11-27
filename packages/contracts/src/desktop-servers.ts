import { parseTrustedOrigin } from "./network";

// ------------------------------------------------- other servers' addresses (§17.1)

/** One IPv4 octet in plain decimal (no leading zeros, which URL parsing reads as octal). */
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const PRIVATE_HTTP_RE = new RegExp(
  `^http://(${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}|\\[[0-9a-f:.]+\\])(?::(\\d{1,5}))?/?$`,
);

/**
 * True for an IP literal on a private network or VPN: 10/8, 172.16/12, 192.168/16, CGNAT
 * 100.64/10 (Tailscale) and IPv6 unique-local fd00::/8 (ZeroTier, WireGuard). Link-local,
 * loopback, public addresses and host names are false. `host` is as `URL.hostname` gives it.
 */
export function isPrivateNetworkHost(host: string): boolean {
  if (host.startsWith("[")) {
    // URL normalization drops leading zeros, so fd00::/8 always starts with a 4-digit `fdXX`.
    const first = host.slice(1).split(":")[0] ?? "";
    return first.length === 4 && first.startsWith("fd");
  }
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * A plain `http://` origin the desktop app accepts: an IP literal on a private network or
 * VPN (`isPrivateNetworkHost`), with an optional port and nothing else. Such a connection is
 * not encrypted, so it is only for networks the user controls.
 */
export function isPrivateHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && isPrivateNetworkHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * A remote server's address in the desktop app (§17.1), normalized to its origin.
 * `https://host[:port]` follows `parseTrustedOrigin` exactly. `http://` is accepted only for
 * an IP literal on a private network or VPN (`10.1.2.3:4317`, `[fd12::1]:4317`): never a host
 * name or a public address, and no path, query or credentials.
 */
export function parseDesktopServerUrl(
  input: string,
): { ok: true; origin: string } | { ok: false; problem: string } {
  const text = input.trim().toLowerCase();
  if (!text.startsWith("http://")) return parseTrustedOrigin(input);
  const refused = {
    ok: false as const,
    problem:
      "Plain http:// works only with a private or VPN IP address (10.x, 172.16-31.x, 192.168.x, 100.64-127.x, fd00::/8). Use an https:// address otherwise.",
  };
  if (!PRIVATE_HTTP_RE.test(text)) return refused;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refused;
  }
  if (!isPrivateNetworkHost(url.hostname)) return refused;
  const port = url.port === "" ? 80 : Number(url.port);
  if (port < 1 || port > 65535) return { ok: false, problem: "That port is not valid." };
  return { ok: true, origin: url.origin };
}
