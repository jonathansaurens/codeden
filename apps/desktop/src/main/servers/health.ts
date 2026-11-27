import { HealthResponse } from "@codeden/contracts";

export type HealthResult = { ok: true; version: string } | { ok: false; error: string };

/** Checks `GET /api/health` on an origin. */
export type HealthCheck = (origin: string) => Promise<HealthResult>;

/**
 * `GET <origin>/api/health` with no credentials and no redirects (a redirect could send the
 * check somewhere else), a bad certificate failing like any other error. Pass Electron's
 * `net.fetch` so the system's certificate store and proxy settings apply.
 */
export function healthCheck(fetchImpl: typeof fetch, timeoutMs = 8000): HealthCheck {
  return async (origin) => {
    try {
      const res = await fetchImpl(`${origin}/api/health`, {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok)
        return {
          ok: false,
          error: `The server answered ${res.status}. Is that a CodeDen address?`,
        };
      const body = HealthResponse.safeParse(await res.json());
      if (!body.success) return { ok: false, error: "That address is not a CodeDen server." };
      return { ok: true, version: body.data.version };
    } catch (error) {
      return { ok: false, error: `Could not reach ${origin}: ${reason(error)}` };
    }
  };
}

function reason(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/\s+/g, " ").slice(0, 200);
}
