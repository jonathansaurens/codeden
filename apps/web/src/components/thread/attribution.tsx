import type { Actor } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useClient } from "@/lib/api";
import { memberName, useMe, useMemberNames } from "@/lib/members";
import { cn } from "@/lib/utils";
import { usePresenceStore } from "@/stores/presence";

/** Initials for an avatar: "Ana Lima" -> "AL". */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

/** Who wrote a message or did something (§B.4), shown only when the server has a team. */
export function ActorLabel({ actor, prefix = "" }: { actor: Actor | undefined; prefix?: string }) {
  const { data: me } = useMe();
  const names = useMemberNames();
  if (!actor || !me?.team) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-3xs text-muted-foreground"
      data-testid="actor"
    >
      {actor.kind === "agent" && <Bot className="size-3" />}
      {prefix}
      {actor.memberId === me.member.id ? "You" : memberName(names, actor.memberId)}
    </span>
  );
}

/**
 * Who answered a question or approval (§B.4): the inbox item's resolution says. Fetched only on
 * a team server, once per answered card.
 */
export function AnsweredBy({ sessionId, itemId }: { sessionId: string; itemId: string }) {
  const client = useClient();
  const { data: me } = useMe();
  const id = `inbox:${sessionId}:${itemId}`;
  const { data } = useQuery({
    queryKey: ["inbox-item", id],
    queryFn: () => client.getInboxItem(id),
    enabled: me?.team === true,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const actor = (data?.resolution as { answeredBy?: Actor } | null | undefined)?.answeredBy;
  return <ActorLabel actor={actor} prefix="Answered by " />;
}

/** Avatars of the other members looking at this session now (§B.4). */
export function PresenceAvatars({ sessionId }: { sessionId: string }) {
  const { data: me } = useMe();
  const names = useMemberNames();
  const ids = usePresenceStore((s) => s.bySession[sessionId]);
  const others = (ids ?? []).filter((id) => id !== me?.member.id);
  if (!me?.team || others.length === 0) return null;
  const shown = others.slice(0, 4);
  const label = others.map((id) => memberName(names, id)).join(", ");
  return (
    <div
      className="flex shrink-0 -space-x-1.5"
      role="img"
      title={`Also here: ${label}`}
      aria-label={`Also here: ${label}`}
      data-testid="presence"
    >
      {shown.map((id) => (
        <span
          key={id}
          className={cn(
            "flex size-6 items-center justify-center rounded-full border-2 border-background bg-accent text-3xs font-semibold",
            names.get(id)?.kind === "agent" && "bg-primary/20 text-primary",
          )}
        >
          {initials(memberName(names, id))}
        </span>
      ))}
      {others.length > shown.length && (
        <span className="flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted text-3xs">
          +{others.length - shown.length}
        </span>
      )}
    </div>
  );
}
