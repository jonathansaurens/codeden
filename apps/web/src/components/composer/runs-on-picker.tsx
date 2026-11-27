import { Check, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TRIGGER_CLASS } from "./model-picker/trigger";

/**
 * "Runs on" for a New session draft in a GitHub project once machines exist: the project's
 * setting (the default, sends nothing), Automatic, Home (the server CodeDen runs on) or a machine by name, for this one
 * session (`StartSessionRequest.machine`).
 */
export function RunsOnPicker({
  value,
  machines,
  projectSetting,
  onChange,
}: {
  /** null: the project setting; else `home` or a machine's label. */
  value: string | null;
  machines: readonly string[];
  /** Where the project's setting runs sessions, named in its option. */
  projectSetting: string;
  onChange: (next: string | null) => void;
}) {
  const options: { value: string | null; label: string; help?: string }[] = [
    { value: null, label: "Project setting", help: projectSetting },
    {
      value: "auto",
      label: "Automatic",
      help: "Home or the machine with the most free capacity",
    },
    { value: "home", label: "Home", help: "The server CodeDen runs on, in a worktree" },
    ...machines.map((label) => ({ value: label, label })),
  ];
  const shown = options.find((o) => o.value === value)?.label ?? value ?? "Project setting";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={TRIGGER_CLASS} aria-label="Runs on">
          <Server className="size-3.5" />
          {shown}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" data-testid="runs-on-menu">
        <DropdownMenuLabel className="text-2xs">Where the new session runs</DropdownMenuLabel>
        {options.map((o, i) => (
          <div key={o.value ?? "project"}>
            {i === 3 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => onChange(o.value)} className="items-start py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{o.label}</span>
                {o.help && <span className="block text-2xs text-muted-foreground">{o.help}</span>}
              </span>
              {o.value === value && <Check className="mt-0.5 size-3.5" />}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
