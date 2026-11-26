import { CODEDEN_VERSION } from "@codeden/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Context, Hono } from "hono";
import type { Principal } from "../members/principal";
import type { MemberToolRegistry } from "../members/tools/registry";
import { callerOf } from "./members";

const INSTRUCTIONS =
  "CodeDen member tools: see projects, sessions, diffs and the inbox; message the orchestrator, PMs and sessions; start and stop sessions; answer questions and approvals; run automations; wait for a session. What you may do follows your member role per project.";

function jsonRpcError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
  code = -32000,
) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** One MCP request for a member: stateless Streamable HTTP, like the internal `/mcp`. */
async function memberMcp(
  registry: MemberToolRegistry,
  principal: Principal,
  request: Request,
  log?: (message: string) => void,
): Promise<Response> {
  const server = new Server(
    { name: "codeden", version: CODEDEN_VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list(principal),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const result = await registry.call(
      req.params.name,
      req.params.arguments,
      principal,
      extra.signal,
    );
    const text = result.ok
      ? typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value ?? null)
      : result.message;
    return { content: [{ type: "text", text }], isError: !result.ok };
  });
  // An empty batch is an Invalid Request (JSON-RPC 2.0 §6), not a batch of notifications.
  let parsedBody: unknown;
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      parsedBody = await request.json();
    } catch {
      return jsonRpcError(400, "Parse error", {}, -32700);
    }
    if (Array.isArray(parsedBody) && parsedBody.length === 0) {
      return jsonRpcError(400, "Invalid Request: empty batch", {}, -32600);
    }
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  request.signal.addEventListener("abort", () => void server.close(), { once: true });
  try {
    return await transport.handleRequest(
      request,
      parsedBody === undefined ? undefined : { parsedBody },
    );
  } catch (error) {
    log?.(`member-mcp: ${error instanceof Error ? error.message : String(error)}`);
    return jsonRpcError(500, "Internal error");
  }
}

const notAllowed = (c: Context) =>
  c.newResponse(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed (stateless endpoint)" },
    }),
    405,
    { allow: "POST", "content-type": "application/json" },
  );

/**
 * The connected agents' interfaces (§C.2), mounted under `/api`, so they are reachable wherever
 * the UI is and behind the same sign-in (a member's bearer token, or a device's session):
 * - `/member-mcp`: a remote MCP endpoint (Streamable HTTP) with the member tools. Separate from
 *   the internal loopback `/mcp`, which only takes sessions' own tokens.
 * - `/member-tools`: the same tools on the HTTP API: `GET` lists them, `POST /<name>` with the
 *   tool's input as a JSON body calls one.
 */
export function memberToolRoutes(registry: MemberToolRegistry, log?: (message: string) => void) {
  return new Hono()
    .post("/member-mcp", (c) => memberMcp(registry, callerOf(c), c.req.raw, log))
    .get("/member-mcp", notAllowed)
    .delete("/member-mcp", notAllowed)
    .get("/member-tools", (c) => c.json({ tools: registry.list(callerOf(c)) }))
    .post("/member-tools/:name", async (c) => {
      const args = (await c.req.json().catch(() => ({}))) as unknown;
      const result = await registry.call(c.req.param("name"), args, callerOf(c), c.req.raw.signal);
      if (result.ok) return c.json({ result: result.value ?? null });
      return c.json({ error: { code: result.code, message: result.message } }, result.status);
    });
}
