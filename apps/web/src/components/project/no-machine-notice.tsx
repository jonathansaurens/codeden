import { House, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Automatic placement found no free machine for the New session draft (`no_machine`): the
 * server's message, and "Run on Home" to start the same draft on this computer instead.
 */
export function NoMachineNotice({
  message,
  sending,
  onRunOnHome,
}: {
  message: string;
  sending: boolean;
  onRunOnHome: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border border-status-waiting/40 bg-card px-4 py-3"
      role="alert"
      data-testid="no-machine"
    >
      <p className="min-w-0 flex-1 text-[13px]">{message}</p>
      <Button size="sm" variant="outline" disabled={sending} onClick={onRunOnHome}>
        {sending ? <Loader2 className="animate-spin" /> : <House />} Run on Home
      </Button>
    </div>
  );
}
