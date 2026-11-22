import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DESKTOP_SERVER_NAME_MAX,
  DESKTOP_SERVERS_MAX,
  type DesktopServer,
  type DesktopServerResult,
  LOCAL_SERVER_ID,
  parseTrustedOrigin,
} from "@codeden/contracts";
import { z } from "zod";
import type { HealthCheck } from "./health";

const StoredServer = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  name: z.string().min(1).max(DESKTOP_SERVER_NAME_MAX),
  url: z.string(),
});
type StoredServer = z.infer<typeof StoredServer>;

const StoredList = z.object({ servers: z.array(z.unknown()) });

/** The session partition of a remote server: its cookies and storage live only here. */
export function partitionFor(id: string): string {
  return `persist:codeden-remote-${id}`;
}

/**
 * A remote server's address (§17.1), checked like a trusted origin: `https://host[:port]`,
 * nothing else (no http, path, query, credentials or IP literal). Normalized to its origin.
 */
export function parseServerUrl(
  input: string,
): { ok: true; origin: string } | { ok: false; problem: string } {
  return parseTrustedOrigin(input);
}

/** A name for the list: trimmed, 1 to 40 characters, no control characters. */
export function parseServerName(input: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  const name = input.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return name.length >= 1 && name.length <= DESKTOP_SERVER_NAME_MAX ? name : null;
}

export interface ServerStoreOptions {
  /** `<home>/desktop/servers.json`: the desktop app's own list, never a server's settings. */
  file: string;
  /** `GET /api/health` on an address, without credentials. */
  check: HealthCheck;
  /** Version of this app, to warn about a server on another one. */
  appVersion: string;
}

/**
 * The remote servers the desktop app can open (§17.1). "This Mac" is implicit: always first,
 * never stored, never renamed or removed here. Entries are `{ id, name, url }`; the file is
 * read again on every change so an unreadable entry never costs the others.
 */
export class ServerStore {
  private servers: StoredServer[];

  constructor(private readonly opts: ServerStoreOptions) {
    this.servers = this.read();
  }

  /** This Mac first, then the remote servers in the order they were added. */
  list(localName = "This Mac"): DesktopServer[] {
    return [
      { id: LOCAL_SERVER_ID, name: localName, url: null },
      ...this.servers.map((s) => ({ ...s })),
    ];
  }

  get(id: string): StoredServer | undefined {
    return this.servers.find((s) => s.id === id);
  }

  async add(input: { name: string; url: string }): Promise<DesktopServerResult> {
    const name = parseServerName(input.name);
    if (!name) {
      return {
        ok: false,
        error: `Give the server a name of 1 to ${DESKTOP_SERVER_NAME_MAX} characters.`,
      };
    }
    const url = parseServerUrl(input.url);
    if (!url.ok) return { ok: false, error: url.problem };
    if (this.servers.length >= DESKTOP_SERVERS_MAX) {
      return { ok: false, error: `At most ${DESKTOP_SERVERS_MAX} servers.` };
    }
    if (this.servers.some((s) => s.url === url.origin)) {
      return { ok: false, error: "That server is already in the list." };
    }
    const health = await this.opts.check(url.origin);
    if (!health.ok) return { ok: false, error: health.error };
    // Another add may have finished while the check ran.
    if (this.servers.some((s) => s.url === url.origin)) {
      return { ok: false, error: "That server is already in the list." };
    }
    const entry: StoredServer = { id: randomBytes(6).toString("hex"), name, url: url.origin };
    this.servers = [...this.servers, entry];
    this.write();
    const warning =
      health.version !== this.opts.appVersion
        ? `This server runs CodeDen ${health.version} and this app is ${this.opts.appVersion}. It should still work; update the older one when you can.`
        : undefined;
    return { ok: true, server: { ...entry }, ...(warning ? { warning } : {}) };
  }

  rename(id: string, nameInput: string): DesktopServerResult {
    const entry = this.get(id);
    if (!entry) return { ok: false, error: "That server is not in the list." };
    const name = parseServerName(nameInput);
    if (!name) {
      return {
        ok: false,
        error: `Give the server a name of 1 to ${DESKTOP_SERVER_NAME_MAX} characters.`,
      };
    }
    this.servers = this.servers.map((s) => (s.id === id ? { ...s, name } : s));
    this.write();
    return { ok: true, server: { id, name, url: entry.url } };
  }

  /** Drop an entry; the caller clears the partition's session data. False for This Mac or unknown ids. */
  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.servers = this.servers.filter((s) => s.id !== id);
    this.write();
    return true;
  }

  private read(): StoredServer[] {
    try {
      const raw = StoredList.parse(JSON.parse(readFileSync(this.opts.file, "utf8")));
      const kept: StoredServer[] = [];
      for (const item of raw.servers) {
        const parsed = StoredServer.safeParse(item);
        if (!parsed.success) continue;
        // A hand-edited file gets the same address rules as Add.
        const url = parseServerUrl(parsed.data.url);
        if (!url.ok || kept.some((s) => s.id === parsed.data.id || s.url === url.origin)) continue;
        kept.push({ ...parsed.data, url: url.origin });
      }
      return kept.slice(0, DESKTOP_SERVERS_MAX);
    } catch {
      return [];
    }
  }

  private write(): void {
    mkdirSync(dirname(this.opts.file), { recursive: true });
    writeFileSync(this.opts.file, JSON.stringify({ servers: this.servers }, null, 2));
  }
}
