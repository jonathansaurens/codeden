import {
  AddTrustedOriginRequest,
  SetNetworkAccessRequest,
  SetNetworkPasswordRequest,
  type SetNetworkPasswordResponse,
} from "@codeden/contracts";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { MemberAuth } from "../members/auth";
import type { InviteService } from "../members/invites";
import type { NetworkAccess } from "../network/access";
import { PasswordRuleError, TrustedOriginError } from "../network/store";
import { isRemoteRequest } from "../security";
import { badRequest, forbidden, notFound } from "../services/errors";
import { jsonBody } from "./validate";

export interface NetworkRouteContext {
  network: NetworkAccess;
  /** Members (§B.2): sign-in by name, invites and joining. Without it only the owner signs in. */
  members?: { auth: MemberAuth; invites: InviteService };
  /** Remote session cookie name (includes the port). */
  sessionCookie: () => string;
  /** Install-token cookie name, to tell whether a local browser is signed in. */
  tokenCookie: () => string;
  token: string;
}

/** Session id of a remote caller, from its cookie. */
export function remoteSessionId(c: Context, ctx: NetworkRouteContext): string | null {
  return ctx.network.store.verifySession(getCookie(c, ctx.sessionCookie()))?.id ?? null;
}

/** Changing network access is for this machine only (and the CLI). */
function requireLocal(c: Context): void {
  if (isRemoteRequest(c)) {
    throw forbidden("Network access can only be changed on the computer running CodeDen.");
  }
}

/**
 * `/api/network` (§15.1): status for everyone signed in; turning access on or off and the
 * password are loopback-only. Signed-in devices can be signed out from anywhere.
 */
export function networkRoutes(ctx: NetworkRouteContext) {
  const { network } = ctx;
  const statusFor = (c: Context) =>
    network.status({ remote: isRemoteRequest(c), sessionId: remoteSessionId(c, ctx) });
  return new Hono()
    .get("/", (c) => c.json(statusFor(c)))
    .put("/", jsonBody(SetNetworkAccessRequest), async (c) => {
      requireLocal(c);
      const { enabled, loopbackOnly } = c.req.valid("json");
      if (enabled && !network.store.passwordSet) {
        throw badRequest("Set a password before turning network access on.", "password_required");
      }
      // One serialized step: save both choices, then move the listener once.
      await network.update({ enabled, loopbackOnly });
      return c.json(statusFor(c));
    })
    .post("/origins", jsonBody(AddTrustedOriginRequest), (c) => {
      requireLocal(c);
      try {
        network.store.addTrustedOrigin(c.req.valid("json").url);
      } catch (error) {
        if (error instanceof TrustedOriginError) throw badRequest(error.message, error.code);
        throw error;
      }
      return c.json(statusFor(c));
    })
    .delete("/origins", (c) => {
      requireLocal(c);
      const url = c.req.query("url") ?? "";
      if (!network.store.removeTrustedOrigin(url)) throw notFound("No such trusted origin");
      // Whoever signed in through it keeps a cookie that no longer reaches anything.
      network.dropProxied();
      return c.json(statusFor(c));
    })
    .post("/password", jsonBody(SetNetworkPasswordRequest), async (c) => {
      requireLocal(c);
      let generated: string | null;
      try {
        generated = await network.setPassword(c.req.valid("json"));
      } catch (error) {
        if (error instanceof PasswordRuleError) throw badRequest(error.message, error.code);
        throw error;
      }
      const body: SetNetworkPasswordResponse = { status: statusFor(c), generated };
      return c.json(body);
    })
    .delete("/devices/:id", (c) => {
      if (!network.revoke(c.req.param("id"))) throw notFound("No such device");
      return c.json(statusFor(c));
    })
    .delete("/devices", (c) => {
      network.revokeAll();
      return c.json(statusFor(c));
    });
}

export { authRoutes } from "./auth";
