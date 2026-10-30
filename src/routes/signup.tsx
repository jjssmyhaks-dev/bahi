import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AuthShell, Field, fieldInputClass } from "@/components/auth-shell";
import { DemoButton } from "@/components/demo-button";
import { getViewerFn, signupFn } from "@/lib/api";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Create your workspace — Bahi" }] }),
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    ...(typeof search["next"] === "string" && search["next"].startsWith("/")
      ? { next: search["next"] }
      : {}),
  }),
  beforeLoad: async () => {
    const viewer = await getViewerFn();
    if (viewer) throw redirect({ to: "/app" });
  },
  component: SignupPage,
});

function SignupPage() {
  const { next } = Route.useSearch();
  const [form, setForm] = useState({ name: "", company: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update(key: keyof typeof form) {
    return (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signupFn({ data: form });
      if (!result.ok) {
        setError(result.error);
        setBusy(false);
        return;
      }
      window.location.assign(next ?? result.redirect);
    } catch {
      setError("Something went wrong creating the workspace. Try again.");
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Create a workspace"
      title="Start with one invoice"
      subtitle="Your workspace starts in shadow mode, so Bahi reads and checks every entry and writes nothing until you release it."
      footer={
        <p>
          Already have an account?{" "}
          <a
            href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Log in
          </a>
        </p>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <input
              required
              autoComplete="name"
              value={form.name}
              onChange={update("name")}
              placeholder="Rohit Mehta"
              className={fieldInputClass}
            />
          </Field>
          <Field label="Company">
            <input
              required
              autoComplete="organization"
              value={form.company}
              onChange={update("company")}
              placeholder="Shree Metals Works"
              className={fieldInputClass}
            />
          </Field>
        </div>
        <Field label="Work email">
          <input
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={update("email")}
            placeholder="you@company.com"
            className={fieldInputClass}
          />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.password}
            onChange={update("password")}
            placeholder="Create a password"
            className={fieldInputClass}
          />
        </Field>

        {error ? (
          <p className="rounded-xl border border-destructive/25 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={busy} className="btn-primary h-11 w-full">
          {busy ? "Creating workspace…" : "Create workspace"}
        </button>
      </form>

      <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or explore a seeded workspace
        <span className="h-px flex-1 bg-border" />
      </div>

      <DemoButton className="btn-outline h-11 w-full" onError={setError}>
        Open the demo workspace
      </DemoButton>
    </AuthShell>
  );
}
