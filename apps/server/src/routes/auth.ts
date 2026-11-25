import {
  type AuthStatus,
  InviteCheckRequest,
  type InviteCheckResponse,
  JoinRequest,
  type Member,
  OWNER_MEMBER_ID,
  type SignInError,
  SignInRequest,
} from "@codeden/contracts";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { InvalidInviteError } from "../members/invites";
import type { SignInClient } from "../network/access";
import { isRemoteRequest, peerAddress, proxyClientOf, trustedOriginOf } from "../security";
import { ServiceError } from "../services/errors";
import { tokensEqual } from "../token";
import { type NetworkRouteContext, remoteSessionId } from "./network";
import { jsonBody } from "./validate";

type Refusal = (
  status: 400 | 401 | 403 | 409 | 429,
  code: SignInError["error"]["code"],
  message: string,
  retryAfterMs?: number | null,
) => Response;

function refuser(c: Context): Refusal {
  return (status, code, message, retryAfterMs = null) => {
    const retryAfterSec = retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000);
    if (retryAfterSec !== null) c.header("Retry-After", String(retryAfterSec));
    const body: SignInError = { error: { code, message, retryAfterSec } };
    return c.json(body, status);
  };
}

/** The device signing in: the socket's peer, or the address a trusted proxy reported. */
function clientOf(c: Context): SignInClient {
  const proxy = proxyClientOf(c);
  return proxy
    ? { address: proxy.address ?? "", viaProxy: true }
    : { address: peerAddress(c), viaProxy: false };
}

/**
 * Sign-in, invite checks and joining share one throttle per address (§15.1): `attempt` runs
 * while the address's slot is held, and a `false` result counts as a failure.
 */
async function throttled(
  c: Context,
  ctx: NetworkRouteContext,
  reason: string,
  attempt: () => Promise<Response | false>,
): Promise<Response> {
  const refuse = refuser(c);
  if (!ctx.network.enabled) return refuse(403, "network_off", "Network access is off.");
  if (!isRemoteRequest(c)) {
    return refuse(
      403,
      "network_off",
      "Sign-in is for other devices; this computer uses its own link.",
    );
  }
  const client = clientOf(c);
  const { gate, release } = ctx.network.beginSignIn(client);
  if (!gate.allowed) {
    const seconds = Math.ceil(gate.retryAfterMs / 1000);
    return gate.reason === "locked_out"
      ? refuse(
          429,
          "locked_out",
          `Too many wrong passwords. Try again in ${Math.ceil(seconds / 60)} min.`,
          gate.retryAfterMs,
        )
      : refuse(429, "rate_limited", `Wait ${seconds} s before trying again.`, gate.retryAfterMs);
  }
  // The reservation lasts through the (slow) check and the failure it may record.
  try {
    const result = await attempt();
    if (result === false) {
      ctx.network.failSignIn(client);
      ctx.network.recordFailedSignIn(client.address, reason, client.viaProxy);
      return refuse(401, "invalid_password", "That password is not right.");
    }
    ctx.network.succeedSignIn(client);
    return result;
  } catch (error) {
    if (error instanceof InvalidInviteError) {
      // A wrong or used invite counts like a wrong password: secrets can't be guessed quickly.
      ctx.network.failSignIn(client);
      ctx.network.recordFailedSignIn(client.address, "invalid invite", client.viaProxy);
      return refuse(400, "invalid_invite", error.message);
    }
    if (error instanceof ServiceError && (error.status === 400 || error.status === 409)) {
      return refuse(error.status, "invalid_request", error.message);
    }
    throw error;
  } finally {
    release();
  }
}

/** Start a device session for `member` and set its cookie. */
function startSession(c: Context, ctx: NetworkRouteContext, member: Pick<Member, "id">): void {
  const client = clientOf(c);
  const { token, session } = ctx.network.store.createSession({
    label: c.req.header("user-agent") ?? "",
    address: client.address || null,
    addressViaProxy: client.viaProxy && client.address !== "",
    memberId: member.id,
  });
  setCookie(c, ctx.sessionCookie(), token, {
    httpOnly: true,
    sameSite: "Lax",
    // Behind a proxy the request URL is http; the matched trusted origin says what the browser used.
    secure: trustedOriginOf(c)?.startsWith("https://") ?? new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
  });
}

/**
 * `/api/auth` (§15.1, §B.2): sign-in for remote devices, invite checks and joining. Public;
 * Host/Origin checks still apply, and every attempt is throttled per address.
 */
export function authRoutes(ctx: NetworkRouteContext) {
  const { network } = ctx;
  return new Hono()
    .get("/status", (c) => {
      const remote = isRemoteRequest(c);
      const body: AuthStatus = {
        remote,
        signedIn: remote
          ? remoteSessionId(c, ctx) !== null
          : tokensEqual(getCookie(c, ctx.tokenCookie()), ctx.token),
        networkEnabled: network.enabled,
        askName: ctx.members?.auth.members.isTeam() ?? false,
      };
      return c.json(body);
    })
    .post("/sign-in", jsonBody(SignInRequest), (c) =>
      throttled(c, ctx, "wrong password", async () => {
        const { name, password } = c.req.valid("json");
        const member = ctx.members
          ? await ctx.members.auth.signIn(name, password)
          : (await network.store.checkPassword(password))
            ? { id: OWNER_MEMBER_ID }
            : undefined;
        if (!member) return false;
        startSession(c, ctx, member);
        return c.json({ ok: true as const });
      }),
    )
    .post("/invite", jsonBody(InviteCheckRequest), (c) =>
      throttled(c, ctx, "invalid invite", async () => {
        if (!ctx.members) throw new InvalidInviteError();
        const invite = ctx.members.invites.check(c.req.valid("json").secret);
        const body: InviteCheckResponse = {
          role: invite.role,
          expiresAt: invite.expiresAt,
          ownerName: ctx.members.auth.members.owner().name,
        };
        return c.json(body);
      }),
    )
    .post("/join", jsonBody(JoinRequest), (c) =>
      throttled(c, ctx, "invalid invite", async () => {
        if (!ctx.members) throw new InvalidInviteError();
        const member = await ctx.members.invites.join(c.req.valid("json"));
        startSession(c, ctx, member);
        return c.json({ ok: true as const });
      }),
    )
    .post("/sign-out", (c) => {
      const id = remoteSessionId(c, ctx);
      if (id) network.store.revoke(id);
      deleteCookie(c, ctx.sessionCookie(), { path: "/" });
      return c.json({ ok: true as const });
    });
}
