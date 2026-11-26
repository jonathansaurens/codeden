import { z } from "zod";
import { Id, Timestamp } from "./common";

/**
 * Connecting your own computer (`docs/machines-teams-and-agents.md` §D.5): a laptop can't
 * usually be reached over SSH, so it links out to the server instead. A signed-in person asks
 * for a single-use pairing code (Settings › Machines › Connect this computer); running
 * `codeden connect <server> --code <code>` on the laptop trades it for a device key, starts a
 * runner there and links it over a WebSocket to `RUNNER_CONNECT_PATH`, carrying the runner
 * protocol unchanged. The computer is a machine with backend `connected`, owned by that person.
 */

/** Pairing codes start with this (`cdp_…`); they are single-use and valid for 10 minutes. */
export const CONNECT_CODE_PREFIX = "cdp_";
/** Device keys start with this (`cdk_…`): the laptop's credential for its link. */
export const DEVICE_KEY_PREFIX = "cdk_";
/** How long a pairing code may be used. */
export const CONNECT_CODE_TTL_MS = 10 * 60_000;

/** The WebSocket a connected computer links to, with `Authorization: Bearer <device key>`. */
export const RUNNER_CONNECT_PATH = "/api/runner-connect";
/** Where `codeden connect` trades a pairing code for a device key (`PairRequest`). */
export const RUNNER_CONNECT_PAIR_PATH = "/api/runner-connect/pair";

/**
 * WebSocket close codes the server ends a link with:
 * - `replaced`: the same computer linked again (after sleep or a network change);
 * - `revoked`: the computer was disconnected (its key revoked); `codeden connect` stops.
 */
export const RunnerConnectClose = { replaced: 4000, revoked: 4401 } as const;

/**
 * A CodeDen server's address as a browser or a laptop reaches it: `http(s)://host[:port]`, with
 * no credentials, path, query or fragment (a trailing `/` is dropped).
 */
export const ServerAddress = z
  .string()
  .trim()
  .max(500)
  .transform((s) => s.replace(/\/+$/, ""))
  .refine(
    (s) => {
      try {
        const url = new URL(s);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          !url.username &&
          !url.password &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    },
    { message: "Use the server's address, like https://codeden.example.com" },
  );
export type ServerAddress = z.infer<typeof ServerAddress>;

/** `POST /api/machines/connect-codes`: a pairing code for one of your own computers. */
export const CreateConnectCodeRequest = z.object({
  /** The address the browser reached the server by; the command names it. */
  serverUrl: ServerAddress,
});
export type CreateConnectCodeRequest = z.infer<typeof CreateConnectCodeRequest>;

/** A new pairing code and the command to run with it (shown once). */
export const ConnectCodeResponse = z.object({
  /** The code's id, to follow it (`GET /api/machines/connect-codes/:id`); not secret. */
  id: Id,
  code: z.string(),
  expiresAt: Timestamp,
  /** `npx -y codeden@<server version> connect <server> --code <code>`. */
  command: z.string(),
});
export type ConnectCodeResponse = z.infer<typeof ConnectCodeResponse>;

/**
 * Where a pairing code is: `waiting` to be used, `paired` (a computer traded it for a key and
 * is linking), `connected` (its runner is linked) or `expired` (unused for 10 minutes).
 */
export const ConnectCodeState = z.enum(["waiting", "paired", "connected", "expired"]);
export type ConnectCodeState = z.infer<typeof ConnectCodeState>;

/** `GET /api/machines/connect-codes/:id`: the code's state, and its machine once paired. */
export const ConnectCodeStatus = z.object({
  state: ConnectCodeState,
  machineId: Id.nullable(),
});
export type ConnectCodeStatus = z.infer<typeof ConnectCodeStatus>;

/** `POST /api/runner-connect/pair` (public: the code is the credential). */
export const PairRequest = z.object({
  code: z.string().trim().min(1).max(200),
  /** The computer's host name, for its label. */
  hostname: z.string().trim().max(255).default(""),
  /**
   * The machine this computer was paired as before (its `connect.json`), to be the same machine
   * again: kept only when it is a computer of the same person. Its runner keeps its journal,
   * which no other machine may take over.
   */
  previousMachineId: Id.optional(),
});
export type PairRequest = z.infer<typeof PairRequest>;

/** The device key for the computer (shown once; only its hash is stored). */
export const PairResponse = z.object({
  machineId: Id,
  label: z.string(),
  key: z.string(),
  /** Load the Fake provider in the computer's runner (a server with it on: development, tests). */
  fake: z.boolean().default(false),
});
export type PairResponse = z.infer<typeof PairResponse>;

/** `~/.codeden-runner/connect.json` on the computer (mode 0600): how to link again. */
export const ConnectFile = z.object({
  server: ServerAddress,
  machineId: Id,
  label: z.string(),
  key: z.string().startsWith(DEVICE_KEY_PREFIX),
  fake: z.boolean().default(false),
  pairedAt: Timestamp,
});
export type ConnectFile = z.infer<typeof ConnectFile>;
