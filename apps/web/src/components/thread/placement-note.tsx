import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Why the session runs where it does, when automatic placement had to fall back
 * (`Session.placementNote`): an info icon next to the session's state, with the note on hover.
 */
export function PlacementNote({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 self-center text-muted-foreground hover:text-foreground"
          aria-label={note}
          data-testid="placement-note"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{note}</TooltipContent>
    </Tooltip>
  );
}
