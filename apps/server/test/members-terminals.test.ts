import type { RunnerRecord } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { sampleSession } from "./helpers";
import { connectAs } from "./support/member-sockets";
import {
  type Credential,
  type MembersEnv,
  seedProjects,
  startMembersEnv,
} from "./support/members-env";

let env: MembersEnv | undefined;
const open: WebSocket[] = [];
afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await env?.close();
  env = undefined;
});

const connect = (e: MembersEnv, path: string, as: Credential) => connectAs(e, path, as, open);

async function joined(
  e: MembersEnv,
  name: string,
  role: "viewer" | "operator",
  projectRoles: Record<string, string> = {},
): Promise<Credential> {
  return e.join(await e.invite(role, { projectRoles } as never), name);
}

const ts = "2026-11-13T10:00:00.000Z";
/** A machine (an SSH runner) and a session `s-machine` of project p1 on it. */
function seedMachineSession(e: MembersEnv): void {
  const machine: RunnerRecord = {
    id: "rn-vps",
    backend: "ssh",
    home: false,
    runnerId: "r-vps",
    sandboxRef: "dev@vps",
    label: "vps",
    weight: null,
    projectId: null,
    sessionId: null,
    state: "connected",
    version: null,
    imageVersion: null,
    createdAt: ts,
    lastSeenAt: null,
    lastError: null,
    ownerMemberId: null,
  };
  e.server.store.append([
    { type: "runner.registered", sessionId: null, payload: { runner: machine } },
    {
      type: "session.created",
      sessionId: "s-machine",
      payload: {
        session: {
          ...sampleSession,
          id: "s-machine",
          projectId: "p1",
          status: "idle",
          runnerId: "r-vps",
        },
      },
    },
  ]);
}

describe("terminals on the server and on machines (§B.3)", () => {
  it("keeps a full shell on the server to Owners; Operators drive terminals on machines", async () => {
    env = await startMembersEnv();
    seedProjects(env.server, ["p1"]);
    seedMachineSession(env);
    const operator = await joined(env, "Olga", "operator");
    // On the home runner an Operator may only watch an open terminal: no new shell, no command.
    expect((await connect(env, "/ws/pty?sessionId=s-p1", operator)).status).toBe(403);
    expect(
      (await connect(env, "/ws/pty?sessionId=s-p1&ptyId=pty-x&command=id", operator)).status,
    ).toBe(403);
    expect((await connect(env, "/ws/pty?sessionId=s-p1&ptyId=pty-x", operator)).status).toBe(101);
    // On a machine an Operator opens one (it is not connected here, but the socket is allowed).
    expect((await connect(env, "/ws/pty?sessionId=s-machine", operator)).status).toBe(101);
    // An Owner (who isn't the install token) opens one on the server.
    const owner = await env.join(await env.invite("owner"), "Omar");
    expect((await connect(env, "/ws/pty?sessionId=s-p1", owner)).status).toBe(101);
  });
});
