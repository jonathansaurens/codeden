import {
  AddMachineResponse,
  ConnectCodeResponse,
  ConnectCodeStatus,
  Machine,
  MachinesResponse,
  MachineWeight,
} from "@codeden/contracts";
import { z } from "zod";
import type { CodeDenClient } from "./client";
import type { Fetcher } from "./http";

/** The client's machine calls (`/api/machines`). */
export type MachinesMethods = Pick<
  CodeDenClient,
  | "machines"
  | "addMachine"
  | "setMachineWeight"
  | "setHomeWeight"
  | "removeMachine"
  | "reconnectMachine"
  | "createConnectCode"
  | "connectCodeStatus"
  | "disconnectMachine"
>;

/**
 * Machines over HTTP. Refusals arrive as `ApiRequestError` with the server's `code` and message,
 * which the UI shows as they are.
 */
export function httpMachinesApi(http: Fetcher): MachinesMethods {
  const path = (id: string) => `/machines/${encodeURIComponent(id)}`;
  return {
    machines: () => http.get("/machines", (v) => MachinesResponse.parse(v)),
    addMachine: (req) =>
      http.post("/machines", req, (v) => AddMachineResponse.parse(v)).then((r) => r.machine),
    setMachineWeight: (id, weight) =>
      http.call("PATCH", path(id), { weight }, (v) => Machine.parse(v)),
    setHomeWeight: (weight) =>
      http.call(
        "PUT",
        "/machines/home/weight",
        { weight },
        (v) => z.object({ weight: MachineWeight }).parse(v).weight,
      ),
    reconnectMachine: (id) =>
      http
        .post(`${path(id)}/reconnect`, {}, (v) => AddMachineResponse.parse(v))
        .then((r) => r.machine),
    async removeMachine(id, opts) {
      await http.call("DELETE", `${path(id)}${opts?.force ? "?force=true" : ""}`);
    },
    createConnectCode: (serverUrl) =>
      http.post("/machines/connect-codes", { serverUrl }, (v) => ConnectCodeResponse.parse(v)),
    connectCodeStatus: (id) =>
      http.get(`/machines/connect-codes/${encodeURIComponent(id)}`, (v) =>
        ConnectCodeStatus.parse(v),
      ),
    async disconnectMachine(id, opts) {
      await http.post(`${path(id)}/disconnect${opts?.force ? "?force=true" : ""}`, {});
    },
  };
}
