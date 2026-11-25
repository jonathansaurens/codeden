import { type InviteCheckResponse, PASSWORD_RULE_TEXT, passwordProblem } from "@codeden/contracts";
import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClient } from "@/lib/api";
import { SignInFailure } from "@/lib/api/network-api";
import { Logo } from "./logo";

const ROLE_TEXT: Record<InviteCheckResponse["role"], string> = {
  none: "You'll see only the projects you were given a role on.",
  viewer: "You'll be able to watch everything live.",
  operator: "You'll be able to watch and work: message agents, start and stop sessions.",
  owner: "You'll be an owner: everything, including settings and members.",
};

/** The invite secret from the link (`/join#cdi_…`): the fragment never reaches a server log. */
function secretFromLink(): string {
  return decodeURIComponent(window.location.hash.replace(/^#/, ""));
}

/**
 * Joining a CodeDen server with an invite link (§B.2): pick a display name and a passphrase
 * (the network password rules), and this device is signed in.
 */
export function JoinScreen() {
  const client = useClient();
  const [secret] = useState(secretFromLink);
  const [invite, setInvite] = useState<InviteCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = password ? passwordProblem(password) : null;

  useEffect(() => {
    if (!secret) {
      setError("This link has no invite in it. Ask for a new one.");
      return;
    }
    client.auth
      .checkInvite(secret)
      .then(setInvite)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "This invite doesn't work."),
      );
  }, [client, secret]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!invite || busy || problem || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.auth.join({ secret, name: name.trim(), password });
      window.location.replace("/");
    } catch (err) {
      setError(
        err instanceof SignInFailure || err instanceof Error ? err.message : "Joining failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh items-start justify-center bg-background px-5 pt-[12vh] text-foreground sm:items-center sm:pt-0">
      <form onSubmit={submit} className="relative w-full max-w-sm" data-testid="join">
        <Logo className="mx-auto mb-5 size-14" />
        <h1 className="text-center text-xl font-semibold tracking-tight">Join CodeDen</h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          {invite
            ? `${invite.ownerName} invited you. ${ROLE_TEXT[invite.role]}`
            : error
              ? "This invite can't be used."
              : "Checking the invite…"}
        </p>
        {invite && (
          <>
            <label htmlFor="join-name" className="mt-7 mb-1.5 block text-[13px] font-medium">
              Your name
            </label>
            <Input
              id="join-name"
              autoComplete="username"
              autoFocus
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              className="h-12 text-base"
            />
            <label htmlFor="join-password" className="mt-4 mb-1.5 block text-[13px] font-medium">
              Passphrase
            </label>
            <Input
              id="join-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-12 text-base"
              aria-invalid={problem ? true : undefined}
            />
            <p className="mt-2 text-xs text-muted-foreground">{problem ?? PASSWORD_RULE_TEXT}</p>
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {invite && (
          <Button
            type="submit"
            className="mt-5 h-12 w-full text-base"
            disabled={busy || !name.trim() || !password || problem !== null}
          >
            {busy && <Loader2 className="animate-spin" />}
            Join
          </Button>
        )}
      </form>
    </div>
  );
}
