import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serverOrigin, useClient } from "@/lib/api";
import { copyWithFeedback } from "@/lib/copy";

/**
 * The address a connected agent uses: the trusted HTTPS origin (a reverse proxy) when there is
 * one; else, from another device, this page's own address, which that device reaches the server
 * by (the server's own addresses may be private to it, like a container's); else, on the server's
 * machine, a network address, so an agent elsewhere can use it.
 */
function useAgentServerUrl(): string {
  const client = useClient();
  const { data } = useQuery({
    queryKey: ["network-status"],
    queryFn: () => client.network.status(),
    staleTime: 60_000,
  });
  if (data?.trustedOrigins[0]) return data.trustedOrigins[0];
  if (!data || data.remote) return serverOrigin;
  return data.addresses.find((a) => a.kind !== "local")?.url ?? serverOrigin;
}

/** Ready-to-paste setup for a new agent token (§C.2): MCP config, the CLI, and curl. */
export function AgentSnippets({ token }: { token: string }) {
  const url = useAgentServerUrl();
  const mcp = `${url}/api/member-mcp`;
  const snippets: Array<{ label: string; text: string }> = [
    {
      label: "mcp.json",
      text: JSON.stringify(
        {
          mcpServers: {
            codeden: { type: "http", url: mcp, headers: { Authorization: `Bearer ${token}` } },
          },
        },
        null,
        2,
      ),
    },
    {
      label: "claude mcp add",
      text: `claude mcp add --transport http codeden ${mcp} --header "Authorization: Bearer ${token}"`,
    },
    { label: "codeden CLI", text: `npx codeden --server ${url} --token ${token} list-projects` },
    {
      label: "curl",
      text: `curl -s -X POST ${url}/api/member-tools/list_projects -H "Authorization: Bearer ${token}" -H "content-type: application/json" -d '{}'`,
    },
  ];
  return (
    <div className="space-y-3" data-testid="agent-snippets">
      {snippets.map((s) => (
        <div key={s.label}>
          <div className="mb-1 flex items-center justify-between text-2xs font-medium">
            {s.label}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void copyWithFeedback(s.text, `${s.label} copied`)}
            >
              <Copy /> Copy
            </Button>
          </div>
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap break-all">
            {s.text}
          </pre>
        </div>
      ))}
    </div>
  );
}
