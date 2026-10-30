import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AuthShell } from "@/components/auth-shell";
import { acceptInviteFn } from "@/lib/api";

export const Route = createFileRoute("/invite")({
  head: () => ({ meta: [{ title: "Join a workspace — Bahi" }] }),
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    ...(typeof search["token"] === "string" ? { token: search["token"] } : {}),
  }),
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const next = `/invite?token=${encodeURIComponent(token ?? "")}`;

  async function join() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInviteFn({ data: { token } });
      window.location.assign(`/app?joined=${encodeURIComponent(result.tenantName)}`);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "That invite could not be accepted.";
      setError(
        message === "UNAUTHENTICATED"
          ? "Sign in or create an account first, then open this link again."
          : message,
      );
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Team invite"
      title="Join a Bahi workspace"
      subtitle="You will get access to the same conversations, review queue and postings as the rest of the team."
      footer={
        <p>
          Wrong account?{" "}
          <a
            href={`/login?next=${encodeURIComponent(next)}`}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Sign in with another address
          </a>
        </p>
      }
    >
      {!token ? (
        <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          This link is missing its invite token. Ask the workspace owner to send it again.
        </p>
      ) : (
        <div className="space-y-4">
          {error ? (
            <p className="rounded-xl border border-destructive/25 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={join}
            disabled={busy}
            className="btn-primary h-11 w-full px-4 text-sm"
          >
            {busy ? "Joining…" : "Accept invite"}
          </button>
          <p className="text-xs text-muted-foreground">
            Not signed in yet?{" "}
            <a
              href={`/login?next=${encodeURIComponent(next)}`}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Log in
            </a>{" "}
            or{" "}
            <a
              href={`/signup?next=${encodeURIComponent(next)}`}
              className="font-medium text-foreground underline underline-offset-4"
            >
              create an account
            </a>{" "}
            with the address the invite was sent to.
          </p>
        </div>
      )}
    </AuthShell>
  );
}
