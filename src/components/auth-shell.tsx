import type { ReactNode } from "react";
import backdrop from "@/assets/agents-backdrop.jpg";
import { LogoMark } from "@/components/brand";

export function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[1.02fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-foreground p-12 text-background lg:flex lg:flex-col lg:justify-between">
        <img
          src={backdrop}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-35"
        />
        <div className="relative">
          <a href="/" className="inline-flex items-center gap-2.5 text-background">
            <span className="inline-flex items-center gap-0 rounded-lg bg-background p-1.5">
              <LogoMark size={20} />
            </span>
            <span className="text-lg font-semibold tracking-tight">Bahi</span>
          </a>
        </div>

        <div className="relative max-w-md">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-background/60">
            Chat-first data entry
          </p>
          <h2 className="mt-4 text-4xl font-semibold leading-tight tracking-tight">
            Invoices in. Tally updated. Nobody typed a thing.
          </h2>
          <ul className="mt-8 space-y-3 text-sm text-background/70">
            {[
              "Reads bills, statements and PDFs into structured records.",
              "Checks GSTIN, place of supply, tax totals and duplicates.",
              "Posts clean entries to TallyPrime, Excel or Google Sheets.",
              "Sends everything uncertain to a review queue with reasons.",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-background/70" />
                {line}
              </li>
            ))}
          </ul>
          <div className="mt-10 rounded-2xl border border-white/15 bg-white/5 p-5 text-sm leading-relaxed text-background/80">
            “The review queue is the part I trust. It tells me exactly why a bill stopped instead of
            hiding it.”
            <p className="mt-3 text-xs text-background/50">
              Sneha K. · Accounts lead, auto components supplier
            </p>
          </div>
        </div>

        <p className="relative text-xs text-background/40">© 2026 Bahi. All rights reserved.</p>
      </aside>

      <main className="flex min-h-screen flex-col px-6 py-10 sm:px-12">
        <div className="flex items-center justify-between lg:justify-end">
          <a href="/" className="flex items-center gap-2.5 lg:hidden">
            <LogoMark />
            <span className="text-lg font-semibold tracking-tight">Bahi</span>
          </a>
          <a href="/" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            ← Back to site
          </a>
        </div>

        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-md">
            <p className="eyebrow">{eyebrow}</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
            <div className="mt-8">{children}</div>
            <div className="mt-8 text-sm text-muted-foreground">{footer}</div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint ? <span className="mt-1.5 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export const fieldInputClass =
  "h-11 w-full rounded-xl border border-border bg-card px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/30 focus:ring-2 focus:ring-foreground/10";
