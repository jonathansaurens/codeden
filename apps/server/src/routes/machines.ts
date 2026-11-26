import {
  AddMachineRequest,
  type AddMachineResponse,
  type ConnectCodeResponse,
  type ConnectCodeStatus,
  CreateConnectCodeRequest,
  type MachinesResponse,
  MachineWeight,
} from "@codeden/contracts";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { principalOf } from "../members/principal";
import type { AppServices } from "../services/container";
import { ServiceError } from "../services/errors";
import { jsonBody, queryOf } from "./validate";

function machinesOf(s: AppServices) {
  if (!s.machines) {
    throw new ServiceError(503, "machines_unavailable", "Machines aren't available here");
  }
  return s.machines;
}

function computersOf(s: AppServices) {
  if (!s.computers) {
    throw new ServiceError(503, "machines_unavailable", "Machines aren't available here");
  }
  return s.computers;
}

function principal(c: Context) {
  const who = principalOf(c);
  if (!who) throw new ServiceError(403, "forbidden", "Sign in to CodeDen");
  return who;
}

/**
 * `/api/machines` (`docs/machines-teams-and-agents.md` §A.2): list, add (after checking the
 * machine over `ssh`), change a machine's preference, and remove one (refused while sessions are
 * placed there or a clone holds unpushed work, unless `force=true`). People connect their own
 * computers with a pairing code (`connect-codes`, §D.5) and disconnect them (`disconnect`: its
 * person or an Owner, so the route is open to members and the service decides).
 */
export function machineRoutes(s: AppServices) {
  return (
    new Hono()
      .get("/", async (c) => {
        const machines = machinesOf(s);
        const [list, homeResources] = await Promise.all([
          machines.list(),
          machines.homeResources(),
        ]);
        return c.json<MachinesResponse>({
          machines: list,
          homeWeight: machines.homeWeight(),
          homeResources,
          command: machines.command,
        });
      })
      // A pairing code for the caller's own computer (any person, §D.5).
      .post("/connect-codes", jsonBody(CreateConnectCodeRequest), (c) =>
        c.json<ConnectCodeResponse>(
          computersOf(s).createCode(principal(c), c.req.valid("json")),
          201,
        ),
      )
      .get("/connect-codes/:id", (c) =>
        c.json<ConnectCodeStatus>(computersOf(s).codeStatus(principal(c), c.req.param("id"))),
      )
      .post(
        "/:id/disconnect",
        queryOf(z.object({ force: z.enum(["true"]).optional() })),
        async (c) => {
          await computersOf(s).disconnect(principal(c), c.req.param("id"), {
            force: c.req.valid("query").force === "true",
          });
          return c.json({ removed: true });
        },
      )
      .post("/", jsonBody(AddMachineRequest), async (c) =>
        c.json<AddMachineResponse>({ machine: await machinesOf(s).add(c.req.valid("json")) }, 201),
      )
      // Home's own preference: it is a candidate for automatic placement like any machine.
      .put("/home/weight", jsonBody(z.object({ weight: MachineWeight })), (c) => {
        machinesOf(s).setHomeWeight(c.req.valid("json").weight);
        return c.json({ weight: c.req.valid("json").weight });
      })
      .patch("/:id", jsonBody(z.object({ weight: MachineWeight })), (c) =>
        c.json(machinesOf(s).setWeight(c.req.param("id"), c.req.valid("json").weight)),
      )
      // A machine whose CodeDen data was wiped: removed and added again as new.
      .post("/:id/reconnect", async (c) =>
        c.json<AddMachineResponse>({ machine: await machinesOf(s).reconnect(c.req.param("id")) }),
      )
      .delete("/:id", queryOf(z.object({ force: z.enum(["true"]).optional() })), async (c) => {
        const force = c.req.valid("query").force === "true";
        const id = c.req.param("id");
        // A connected computer is disconnected, which also revokes its key.
        if (machinesOf(s).require(id).backend === "connected") {
          await computersOf(s).disconnect(principal(c), id, { force });
        } else {
          await machinesOf(s).remove(id, { force });
        }
        return c.json({ removed: true });
      })
  );
}
