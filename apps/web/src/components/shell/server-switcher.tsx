import { Check, ChevronsUpDown, Server, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { currentServerId, desktopServersApi, useDesktopServers } from "@/lib/desktop-servers";

/**
 * Which CodeDen server this desktop window shows ("This Mac", "Omarchy"), with a menu to open
 * another server's window (§17.1). Nothing in a browser tab.
 */
export function ServerSwitcher() {
  const api = desktopServersApi();
  const servers = useDesktopServers();
  if (!api || servers.length === 0) return null;
  const current = currentServerId();
  const name = servers.find((s) => s.id === current)?.name ?? "This Mac";
  const local = current === "local";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 max-w-32 gap-1 px-1.5 text-2xs text-muted-foreground"
          aria-label={`Server: ${name}`}
          title={`This window shows ${name}`}
        >
          <Server className="size-3 shrink-0" />
          <span className="truncate">{name}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {servers.map((server) => (
          <DropdownMenuItem key={server.id} onSelect={() => api.open(server.id)}>
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            {server.id === current && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
        {local && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => window.dispatchEvent(new Event("codeden:manage-servers"))}
            >
              <Settings2 /> Manage servers...
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
