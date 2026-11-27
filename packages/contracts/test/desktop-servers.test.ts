import { describe, expect, it } from "vitest";
import { isPrivateHttpOrigin, parseDesktopServerUrl } from "../src/desktop-servers";

describe("a remote server's address in the desktop app (§17.1)", () => {
  it.each([
    ["http://10.127.65.119:4317", "http://10.127.65.119:4317"],
    ["  HTTP://10.0.0.1:4317/ ", "http://10.0.0.1:4317"],
    ["http://10.1.2.3", "http://10.1.2.3"],
    ["http://10.1.2.3:80", "http://10.1.2.3"],
    ["http://172.16.0.5:4317", "http://172.16.0.5:4317"],
    ["http://172.31.255.254:4317", "http://172.31.255.254:4317"],
    ["http://192.168.1.20:4317", "http://192.168.1.20:4317"],
    ["http://100.64.0.1:4317", "http://100.64.0.1:4317"],
    ["http://100.127.255.1:4317", "http://100.127.255.1:4317"],
    ["http://[fd12:3456::1]:4317", "http://[fd12:3456::1]:4317"],
    ["http://[FD00::1]", "http://[fd00::1]"],
    // https follows the trusted-origin rules unchanged.
    ["https://omaweb.tail1234.ts.net:8446", "https://omaweb.tail1234.ts.net:8446"],
    ["https://x.ts.net:443", "https://x.ts.net"],
  ])("accepts %s", (input, origin) => {
    expect(parseDesktopServerUrl(input)).toEqual({ ok: true, origin });
  });

  it.each([
    "http://example.com:4317", // host name over http
    "http://x.ts.net",
    "http://localhost:4317",
    "http://8.8.8.8:4317", // public IPv4
    "http://172.15.0.1:4317",
    "http://172.32.0.1:4317",
    "http://100.63.255.1:4317",
    "http://100.128.0.1:4317",
    "http://192.169.1.1:4317",
    "http://11.0.0.1:4317",
    "http://127.0.0.1:4317", // loopback
    "http://169.254.1.1:4317", // link-local
    "http://[fe80::1]:4317",
    "http://[::1]:4317",
    "http://[2001:db8::1]:4317", // public IPv6
    "http://[fd::1]:4317", // 00fd::, not fd00::/8
    "http://[fc00::1]:4317",
    "http://[::ffff:10.0.0.1]:4317",
    "http://010.0.0.1:4317", // octal-looking octet
    "http://0x0a.0.0.1:4317",
    "http://10.1:4317",
    "http://10.0.0.1:4317/app",
    "http://10.0.0.1:4317?a=1",
    "http://me:pw@10.0.0.1:4317",
    "http://10.0.0.1:0",
    "http://10.0.0.1:99999",
    "https://10.0.0.1:4317", // https rules unchanged: no IP literal
    "https://x.ts.net/app",
    "ftp://10.0.0.1",
  ])("refuses %s", (input) => {
    expect(parseDesktopServerUrl(input).ok).toBe(false);
  });

  it("tells a refused http address to use https", () => {
    const result = parseDesktopServerUrl("http://example.com:4317");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/private or VPN IP address.*https:\/\//);
  });

  it("knows which origins are plain http on a private network", () => {
    expect(isPrivateHttpOrigin("http://10.127.65.119:4317")).toBe(true);
    expect(isPrivateHttpOrigin("http://[fd12::1]:4317")).toBe(true);
    expect(isPrivateHttpOrigin("https://10.127.65.119:4317")).toBe(false);
    expect(isPrivateHttpOrigin("http://8.8.8.8")).toBe(false);
    expect(isPrivateHttpOrigin("http://example.com")).toBe(false);
    expect(isPrivateHttpOrigin("not a url")).toBe(false);
  });
});
