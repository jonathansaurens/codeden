import type { DesktopServer } from "@codeden/contracts";
import { LOCAL_SERVER_ID, parseDesktopServerUrl } from "@codeden/contracts";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { currentServerId, desktopServersApi, useDesktopServers } from "@/lib/desktop-servers";

/**
 * The server manager (§17.1), in This Mac's desktop window: add another CodeDen server by its
 * https address (or plain http on a private or VPN IP), rename it, remove it. The app checks `/api/health` before saving; removing
 * signs this device out of that server locally.
 */
export function ServersDialog() {
  const api = desktopServersApi();
  const servers = useDesktopServers();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const enabled = api !== null && currentServerId() === LOCAL_SERVER_ID;

  useEffect(() => {
    if (!api || !enabled) return;
    const show = (opts: { add: boolean }) => {
      setOpen(true);
      setAdding(opts.add);
    };
    const onEvent = () => show({ add: false });
    window.addEventListener("codeden:manage-servers", onEvent);
    const off = api.onManage(show);
    return () => {
      window.removeEventListener("codeden:manage-servers", onEvent);
      off();
    };
  }, [api, enabled]);

  if (!api || !enabled) return null;
  const remotes = servers.filter((s) => s.url !== null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Servers</DialogTitle>
          <DialogDescription>
            Other CodeDen servers this app can open, each in its own window. Their projects,
            sessions and agents stay on that server.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-1">
          <li className="rounded-md border px-3 py-2 text-sm">This Mac</li>
          {remotes.map((s) => (
            <ServerRow key={s.id} server={s} />
          ))}
        </ul>
        {adding ? (
          <AddServerForm onDone={() => setAdding(false)} />
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setAdding(true)}
          >
            <Plus /> Add server...
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ServerRow({ server }: { server: DesktopServer }) {
  const api = desktopServersApi();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(server.name);
  if (!api) return null;
  const save = async () => {
    const result = await api.rename(server.id, name);
    if (result.ok) setEditing(false);
    else toast.error(result.error);
  };
  return (
    <li className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
      {editing ? (
        <Input
          autoFocus
          value={name}
          maxLength={40}
          aria-label="Server name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          className="h-7"
        />
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block truncate">{server.name}</span>
          <span className="block truncate text-2xs text-muted-foreground">{server.url}</span>
        </span>
      )}
      {editing ? (
        <Button size="sm" onClick={() => void save()}>
          Save
        </Button>
      ) : (
        <>
          <Button size="sm" variant="ghost" onClick={() => api.open(server.id)}>
            Open
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Rename ${server.name}`}
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${server.name}`}
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${server.name}? This app forgets it and signs this device out of it. Nothing changes on the server.`,
                )
              ) {
                void api.remove(server.id);
              }
            }}
          >
            <Trash2 />
          </Button>
        </>
      )}
    </li>
  );
}

function AddServerForm({ onDone }: { onDone: () => void }) {
  const api = desktopServersApi();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!api) return null;
  const parsed = parseDesktopServerUrl(url);
  const plainHttp = parsed.ok && parsed.origin.startsWith("http:");
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.add({ name, url });
      if (!result.ok) return setError(result.error);
      if (result.warning) toast.warning(result.warning);
      onDone();
      api.open(result.server.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        autoFocus
        placeholder="Name, e.g. Omarchy"
        aria-label="Server name"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        placeholder="https://server.tailnet.ts.net:8446"
        aria-label="Server address"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      {plainHttp && (
        <p className="text-xs text-muted-foreground">
          Not encrypted: use plain http only on a private network or VPN you trust. Notifications
          and dictation in its window work after CodeDen restarts once.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !name.trim() || !url.trim()}>
          {busy ? "Checking..." : "Add server"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
