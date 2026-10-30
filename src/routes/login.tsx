import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AuthShell, Field, fieldInputClass } from "@/components/auth-shell";
import { DemoButton } from "@/components/demo-button";
import { getViewerFn, loginFn } from "@/lib/api";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Log in — Bahi" }] }),
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    ...(typeof search["next"] === "string" && search["next"].startsWith("/")
      ? { next: search["next"] }
      : {}),
  }),
  beforeLoad: async () => {
    const viewer = await getViewerFn();
    if (viewer) throw redirect({ to: "/app" });
  },
  component: LoginPage,
});

function LoginPage() {
  const { next } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await loginFn({ data: { email, password } });
      if (!result.ok) {
        setError(result.error);
        setBusy(false);
        return;
      }
      window.location.assign(next ?? result.redirect);
    } catch {
      setError("Something went wrong signing you in. Try again.");
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Log in to your workspace"
      subtitle="Open your conversation, review queue and today's postings."
      footer={
        <p>
          New to Bahi?{" "}
          <a
            href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Create an account
          </a>
        </p>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Work email">
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className={fieldInputClass}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            className={fieldInputClass}
          />
        </Field>

        {error ? (
          <p className="rounded-xl border border-destructive/25 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={busy} className="btn-primary h-11 w-full">
          {busy ? "Signing in…" : "Log in"}
        </button>
      </form>

      <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or look around first
        <span className="h-px flex-1 bg-border" />
      </div>

      <DemoButton className="btn-outline h-11 w-full" onError={setError}>
        Open the demo workspace
      </DemoButton>
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Seeded invoices, a bank statement and a review queue. No card needed.
      </p>
    </AuthShell>
  );
}
