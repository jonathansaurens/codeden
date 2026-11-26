import {
  AddMachineRequest,
  type AddMachineResponse,
  type MachinesResponse,
  MachineWeight,
} from "@codeden/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppServices } from "../services/container";
import { ServiceError } from "../services/errors";
import { jsonBody, queryOf } from "./validate";

function machinesOf(s: AppServices) {
  if (!s.machines) {
    throw new ServiceError(503, "machines_unavailable", "Machines aren't available here");
  }
  return s.machines;
}

/**
 * `/api/machines` (`docs/machines-teams-and-agents.md` §A.2): list, add (after checking the
 * machine over `ssh`), change a machine's preference, and remove one (refused while sessions are
 * placed there or a clone holds unpushed work, unless `force=true`).
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
        await machinesOf(s).remove(c.req.param("id"), {
          force: c.req.valid("query").force === "true",
        });
        return c.json({ removed: true });
      })
  );
}
