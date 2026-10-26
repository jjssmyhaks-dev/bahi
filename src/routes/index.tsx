import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import heroImage from "@/assets/hero-diorama.jpg";
import agentsBackdrop from "@/assets/agents-backdrop.jpg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Stackflo — Run your business from one place" },
      {
        name: "description",
        content:
          "Stackflo turns the spreadsheets your team runs on into real apps and AI agents, so the people closest to the work can fix the work.",
      },
      { property: "og:title", content: "Stackflo — Run your business from one place" },
      {
        property: "og:description",
        content: "Turn your team's spreadsheets into real apps and AI agents with Stackflo.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LandingPage,
});

/* ---------------------------------- data ---------------------------------- */

const NAV_LINKS = [
  { label: "Product", href: "#how-it-works" },
  { label: "Enterprise", href: "#govern" },
  { label: "Customers", href: "#stories" },
  { label: "Resources", href: "#templates" },
  { label: "Pricing", href: "#cta" },
];

const PROMPT_EXAMPLES = [
  "I need to keep track of job site progress",
  "I want to manage my warehouse inventory",
  "I'd like to plan delivery routes for tomorrow",
  "I need to log daily production numbers",
];

const WORDMARKS = [
  { name: "NORDVIK", className: "font-bold tracking-[0.25em]" },
  { name: "Ferrata", className: "font-serif italic text-xl" },
  { name: "Bluecrest", className: "font-semibold tracking-tight" },
  { name: "HALDEN&CO", className: "font-medium tracking-widest" },
  { name: "optimo", className: "font-bold lowercase tracking-tight" },
  { name: "Marlowe", className: "font-serif text-xl" },
  { name: "STRATA", className: "font-extrabold tracking-[0.2em]" },
];

const STEPS = [
  {
    n: "01",
    title: "Start",
    text: "Upload the spreadsheet your team already lives in, and describe what you need in a sentence.",
  },
  {
    n: "02",
    title: "Understand",
    text: "Stackflo reads every tab — formulas, notes, hidden columns — and maps how your business actually works.",
  },
  {
    n: "03",
    title: "Build",
    text: "A working app for desktop and phone is generated from your data, in minutes, not months.",
  },
  {
    n: "04",
    title: "Inspect",
    text: "Click any number to see exactly how it was calculated, explained in plain language.",
  },
  {
    n: "05",
    title: "Share",
    text: "Invite the team. Every app stays private to your company by default.",
  },
  {
    n: "06",
    title: "Stay in sync",
    text: "Someone logs it from the field, the office sees it instantly. One dataset, zero version chaos.",
  },
  {
    n: "07",
    title: "Ask",
    text: "Ask the assistant anything about your business and get answers from live data.",
  },
];

const INTEGRATIONS = [
  "Google Sheets",
  "Excel",
  "Salesforce",
  "Shopify",
  "Slack",
  "Notion",
  "Airtable",
  "Stripe",
  "QuickBooks",
  "HubSpot",
  "Zendesk",
  "BigQuery",
];

const GOVERN_POINTS = [
  { title: "Single sign-on", text: "Everyone signs in with Okta, Google, or your own SSO." },
  { title: "Row-level permissions", text: "Each person sees only the rows they should." },
  { title: "AI spend budgets", text: "One org budget, with spend broken down by team and model." },
  { title: "Approved models only", text: "Your data never trains anyone's model." },
  { title: "Audit log", text: "Every build, change, and export stays on the record." },
];

const COMPLIANCE = ["SOC 2", "GDPR", "CCPA", "AES-256"];

const TEMPLATES = [
  { glyph: "◧", tone: "bg-chip text-chip-foreground", name: "Field Operations", text: "Job logs, inspections, and daily reports for crews in the field." },
  { glyph: "▤", tone: "bg-secondary text-secondary-foreground", name: "Inventory", text: "Stock counts, reorder alerts, and supplier tracking in one place." },
  { glyph: "◍", tone: "bg-foreground text-background", name: "Client Portal", text: "A private portal where customers track their own orders." },
  { glyph: "◈", tone: "bg-secondary text-secondary-foreground", name: "Event Planning", text: "Vendors, schedules, and headcounts that stay in sync." },
];

const QUOTES = [
  {
    quote: "I'm not a developer, and I shipped our inventory app in an afternoon. It's become how the whole warehouse runs.",
    name: "Priya N.",
    role: "Operations Manager, regional distributor",
    initials: "PN",
  },
  {
    quote: "We stopped emailing spreadsheets back and forth. The field team and the office finally work from the same app.",
    name: "Marcus T.",
    role: "Owner, construction firm",
    initials: "MT",
  },
  {
    quote: "The audit trail alone paid for it. Every change and every export is on the record, exactly where finance wants it.",
    name: "Elena V.",
    role: "Head of Finance, retail group",
    initials: "EV",
  },
];

const CTA_WORDS = ["job site reporting", "inventory management", "client follow-ups", "production tracking"];

/* --------------------------------- hooks ---------------------------------- */

function useTypewriter(phrases: string[]) {
  const [text, setText] = useState("");

  useEffect(() => {
    let phrase = 0;
    let char = 0;
    let deleting = false;
    let timer = 0;

    const tick = () => {
      const current = phrases[phrase];
      if (!deleting) {
        char += 1;
        setText(current.slice(0, char));
        if (char === current.length) {
          deleting = true;
          timer = window.setTimeout(tick, 1900);
          return;
        }
        timer = window.setTimeout(tick, 42);
      } else {
        char -= 1;
        setText(current.slice(0, char));
        if (char === 0) {
          deleting = false;
          phrase = (phrase + 1) % phrases.length;
          timer = window.setTimeout(tick, 420);
          return;
        }
        timer = window.setTimeout(tick, 22);
      }
    };

    timer = window.setTimeout(tick, 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return text;
}

function useRotatingIndex(length: number, intervalMs = 2600) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setI((v) => (v + 1) % length), intervalMs);
    return () => window.clearInterval(t);
  }, [length, intervalMs]);
  return i;
}

/* -------------------------------- icons ----------------------------------- */

function LogoMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect width="26" height="26" rx="8" className="fill-foreground" />
      <path d="M8 17.5 13 8l5 9.5" stroke="var(--color-background)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-muted-foreground">
      <path d="M8 10.5V2.5m0 0L4.8 5.7M8 2.5l3.2 3.2M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="9" className="fill-foreground" />
      <path d="m5.5 9.2 2.3 2.3 4.7-4.8" stroke="var(--color-background)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className={className}>
      <path d="M2.5 7h9m0 0L7.8 3.3M11.5 7l-3.7 3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------- components ------------------------------- */

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/85 backdrop-blur-md">
      <div className="container-page flex h-16 items-center justify-between">
        <a href="#" className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-lg font-semibold tracking-tight">Stackflo</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" className="text-muted-foreground">
            <path d="m2 3.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </a>

        <nav className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((l) => (
            <a key={l.label} href={l.href} className="text-sm text-foreground/80 transition-colors hover:text-foreground">
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2.5">
          <a href="#cta" className="hidden text-sm font-medium text-foreground/80 hover:text-foreground sm:block sm:px-3">
            Log in
          </a>
          <a href="#cta" className="btn-outline hidden h-10 sm:inline-flex">
            Contact sales
          </a>
          <a href="#cta" className="btn-primary h-10 px-4">
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  const typed = useTypewriter(PROMPT_EXAMPLES);

  return (
    <section className="relative overflow-hidden pt-14 sm:pt-20">
      <div className="container-page flex flex-col items-center text-center">
        <a href="#mobile" className="chip fade-up group hover:bg-muted">
          <span className="rounded-full bg-chip px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-chip-foreground">
            Coming soon
          </span>
          <span className="font-medium">Stackflo for iPhone</span>
          <ArrowRight className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </a>

        <h1 className="fade-up mt-8 max-w-4xl text-[2.6rem] font-semibold leading-[1.04] tracking-tight sm:text-6xl md:text-[4.2rem]">
          Your business, out of the spreadsheet.
          <br className="hidden sm:block" /> Run everything in one place.
        </h1>

        <p className="fade-up mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          Stackflo turns the spreadsheets your team runs on into real apps and AI agents — so the people
          closest to the problems can finally solve them.
        </p>

        {/* Prompt box */}
        <div className="fade-up mt-10 w-full max-w-xl rounded-2xl border border-border bg-card p-2 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.18)]">
          <div className="px-3 pt-2 pb-1 text-left">
            <span className="text-base text-muted-foreground sm:text-lg">
              {typed}
              <span className="caret-blink ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-foreground/70" />
            </span>
          </div>
          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
            <button type="button" className="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <UploadIcon />
              Upload spreadsheet
            </button>
            <button type="button" className="btn-primary h-10 px-5">
              Build it
            </button>
          </div>
        </div>
      </div>

      {/* Hero diorama */}
      <div className="relative mx-auto mt-12 max-w-5xl px-6 sm:mt-16">
        <img
          src={heroImage}
          alt="A miniature industrial warehouse under construction, with tiny workers, scaffolding and a crane"
          width={1600}
          height={1067}
          className="mx-auto w-full rounded-[2rem] sm:rounded-[2.5rem]"
        />
        <a
          href="#how-it-works"
          className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background shadow-lg transition-colors hover:bg-foreground/85"
        >
          Discover how
        </a>
      </div>
    </section>
  );
}

function LogoStrip() {
  const row = [...WORDMARKS, ...WORDMARKS];
  return (
    <section className="border-y border-border/70 py-10">
      <p className="mb-7 text-center text-sm text-muted-foreground">
        Trusted by teams at thousands of growing businesses
      </p>
      <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="animate-marquee flex w-max items-center gap-16 pr-16">
          {row.map((w, i) => (
            <span key={`${w.name}-${i}`} className={`whitespace-nowrap text-lg text-foreground/45 ${w.className}`}>
              {w.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 sm:py-32">
      <div className="container-page grid gap-14 md:grid-cols-[1fr_1.3fr]">
        <div className="md:sticky md:top-28 md:self-start">
          <p className="eyebrow">How it works</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            From a spreadsheet to apps your whole team runs on.
          </h2>
          <p className="mt-5 max-w-md text-muted-foreground">
            Seven steps, no developers. You bring the spreadsheet and the problem — Stackflo brings the app.
          </p>
          <a href="#cta" className="btn-primary mt-8">
            Discover how
          </a>
        </div>

        <ol>
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-6 border-t border-border py-7 first:border-t-0 first:pt-0 md:py-8">
              <span className="text-sm font-semibold text-muted-foreground">{s.n}</span>
              <div>
                <h3 className="text-lg font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-1.5 max-w-md text-[15px] leading-relaxed text-muted-foreground">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function AgentRow({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <span className="text-sm font-medium">{name}</span>
      <span className="text-xs text-background/60">{detail}</span>
    </div>
  );
}

function Agents() {
  return (
    <section className="py-6 sm:py-10">
      <div className="container-page">
        <div className="relative overflow-hidden rounded-[2rem] bg-foreground px-6 py-16 text-background sm:rounded-[2.5rem] sm:px-14 sm:py-24">
          <img
            src={agentsBackdrop}
            alt=""
            aria-hidden="true"
            loading="lazy"
            width={1600}
            height={912}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40"
          />
          <div className="relative">
            <div className="grid items-center gap-12 lg:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-background/60">Work apps</p>
                <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
                  Automate the busywork — with our agent, or yours.
                </h2>
                <p className="mt-5 max-w-lg text-background/70">
                  Anyone on the team can build with AI. Apps run on your company's data, inside the permissions
                  you set — nothing leaves your control.
                </p>
                <div className="mt-8 flex flex-wrap gap-2.5">
                  {["Claude", "Gemini", "ChatGPT"].map((n) => (
                    <span key={n} className="rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-medium">
                      {n}
                    </span>
                  ))}
                  <span className="rounded-full bg-background px-4 py-1.5 text-sm font-medium text-foreground">
                    + your own, over MCP
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                <AgentRow name="Claude" detail="Builds inside your permissions" />
                <AgentRow name="Gemini" detail="Answers from live data" />
                <AgentRow name="ChatGPT" detail="Runs your workflows" />

                <div className="mt-6 rounded-2xl bg-card p-5 text-foreground shadow-xl">
                  <p className="text-sm font-medium">Which orders ship this week?</p>
                  <p className="mt-1 text-xs text-muted-foreground">Stackflo · checked shipments</p>
                  <div className="mt-4 overflow-hidden rounded-xl border border-border">
                    <div className="grid grid-cols-3 gap-2 border-b border-border bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
                      <span>Day</span>
                      <span>Customer</span>
                      <span>Volume</span>
                    </div>
                    {[
                      ["Thu", "Acme Supply", "14 pallets"],
                      ["Fri", "Northline Ltd", "9 pallets"],
                      ["Fri", "Orbit Foods", "22 crates"],
                    ].map((r) => (
                      <div key={r[1]} className="grid grid-cols-3 gap-2 px-3 py-2 text-xs">
                        <span>{r[0]}</span>
                        <span className="font-medium">{r[1]}</span>
                        <span className="text-muted-foreground">{r[2]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const APP_TILES = ["Operations", "Inventory", "Orders", "Suppliers", "Budget", "Reports"];

function HomeMockups() {
  return (
    <section id="mobile" className="py-24 sm:py-32">
      <div className="container-page">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Operate</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            One home for your whole business. On the desktop, and in the field.
          </h2>
          <p className="mt-5 text-muted-foreground">
            Every app, project, and conversation in one shared home — on the same live data, wherever the day
            takes you.
          </p>
        </div>

        <div className="mt-14 grid items-center gap-8 lg:grid-cols-[1.6fr_1fr]">
          {/* Desktop mock */}
          <div className="rounded-[1.75rem] border border-border bg-card p-4 shadow-[0_30px_80px_-30px_rgb(0_0_0/0.2)] sm:p-6">
            <div className="flex items-center gap-3 border-b border-border pb-4">
              <LogoMark />
              <div>
                <p className="text-sm font-semibold">Good morning, Sam</p>
                <p className="text-xs text-muted-foreground">What's next for Harbor & Field?</p>
              </div>
              <span className="ml-auto hidden rounded-full border border-border px-3 py-1 text-xs text-muted-foreground sm:block">
                Ask or build something
              </span>
            </div>
            <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Projects</p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {APP_TILES.map((t, i) => (
                <div key={t} className="rounded-xl border border-border bg-background p-4 transition-colors hover:bg-muted">
                  <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold ${i % 3 === 0 ? "bg-foreground text-background" : "bg-secondary text-secondary-foreground"}`}>
                    {t[0]}
                  </span>
                  <p className="mt-2.5 text-sm font-medium">{t}</p>
                  <p className="text-xs text-muted-foreground">{i % 2 === 0 ? "3 apps · edited 2h ago" : "2 apps · edited today"}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Phone mock */}
          <div className="mx-auto w-full max-w-[290px] rounded-[2.5rem] border border-border bg-card p-3 shadow-[0_30px_80px_-30px_rgb(0_0_0/0.25)]">
            <div className="rounded-[2rem] bg-background p-5">
              <p className="text-xs text-muted-foreground">9:41</p>
              <p className="mt-3 text-sm font-semibold">Good morning, Diego</p>
              <p className="text-xs text-muted-foreground">What's next?</p>
              <div className="mt-4 rounded-xl border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
                Ask or build something
              </div>
              <p className="mt-5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Apps</p>
              <div className="mt-2 space-y-2">
                {APP_TILES.slice(0, 4).map((t) => (
                  <div key={t} className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-xs font-bold text-secondary-foreground">
                      {t[0]}
                    </span>
                    <span className="text-xs font-medium">{t}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Integrations() {
  return (
    <section className="py-24 sm:py-32" id="integrations">
      <div className="container-page grid items-center gap-14 lg:grid-cols-2">
        <div>
          <p className="eyebrow">Integrations</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            Plugs into the tools you already use
          </h2>
          <p className="mt-5 max-w-lg text-muted-foreground">
            Bring in your spreadsheets, databases, and everyday business tools. Stackflo connects them into one
            operating system for your business — without replacing everything.
          </p>
          <div className="mt-8 flex flex-wrap gap-2.5">
            {INTEGRATIONS.map((n) => (
              <span key={n} className="chip">
                {n}
              </span>
            ))}
          </div>
          <a href="#cta" className="btn-outline mt-8">
            Explore integrations
            <ArrowRight />
          </a>
        </div>

        <div className="rounded-[1.75rem] border border-border bg-card p-6 shadow-[0_24px_60px_-28px_rgb(0_0_0/0.18)] sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Try a prompt</p>
          <p className="mt-4 text-lg font-medium leading-snug">
            Schedule site visits from the addresses in my CRM, and plan the routes on a map.
          </p>
          <div className="mt-6 flex items-center justify-between rounded-xl bg-muted px-4 py-3">
            <span className="text-sm text-muted-foreground">CRM + Maps connected</span>
            <a href="#cta" className="btn-primary h-9 px-4 text-xs">
              Build it
            </a>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 text-xs text-muted-foreground">
            {["Mon · 4 visits", "Tue · 6 visits", "Wed · 3 visits"].map((d) => (
              <div key={d} className="rounded-lg border border-border bg-background px-3 py-2.5 font-medium text-foreground/80">
                {d}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Govern() {
  return (
    <section id="govern" className="py-24 sm:py-32">
      <div className="container-page grid items-start gap-14 lg:grid-cols-2">
        <div>
          <p className="eyebrow">Govern</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            Your data stays yours, under enterprise control.
          </h2>
          <p className="mt-5 max-w-lg text-muted-foreground">
            Stackflo keeps your apps private by default, protects your data with encryption, and gives you
            control over who can see and change what.
          </p>
          <div className="mt-8 flex flex-wrap gap-2.5">
            {COMPLIANCE.map((c) => (
              <span key={c} className="chip font-semibold">
                {c}
              </span>
            ))}
          </div>
          <a href="#cta" className="btn-outline mt-8">
            Explore Stackflo Enterprise
            <ArrowRight />
          </a>
        </div>

        <ul className="space-y-4">
          {GOVERN_POINTS.map((p) => (
            <li key={p.title} className="flex gap-4 rounded-2xl border border-border bg-card p-5">
              <CheckIcon />
              <div>
                <p className="text-sm font-semibold">{p.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{p.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Templates() {
  return (
    <section id="templates" className="py-24 sm:py-32">
      <div className="container-page">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Templates</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            Start from a template, shape it to your business
          </h2>
          <p className="mt-5 text-muted-foreground">
            Install a pre-built app, then adapt it around how your company actually works.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TEMPLATES.map((t) => (
            <div
              key={t.name}
              className="group rounded-2xl border border-border bg-card p-6 transition-shadow hover:shadow-[0_20px_50px_-24px_rgb(0_0_0/0.25)]"
            >
              <span className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-lg font-bold ${t.tone}`}>
                {t.glyph}
              </span>
              <h3 className="mt-4 font-semibold tracking-tight">{t.name}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t.text}</p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium opacity-0 transition-opacity group-hover:opacity-100">
                Install <ArrowRight />
              </span>
            </div>
          ))}
        </div>

        <div className="mt-10 text-center">
          <a href="#cta" className="btn-primary">
            Explore the app store
          </a>
        </div>
      </div>
    </section>
  );
}

function Stories() {
  return (
    <section id="stories" className="py-24 sm:py-32">
      <div className="container-page">
        <h2 className="mx-auto max-w-2xl text-center text-3xl font-semibold tracking-tight sm:text-5xl">
          Built for the people who actually run the show
        </h2>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {QUOTES.map((q) => (
            <figure key={q.name} className="flex flex-col rounded-2xl border border-border bg-card p-7">
              <blockquote className="text-[15px] leading-relaxed text-foreground/90">“{q.quote}”</blockquote>
              <figcaption className="mt-6 flex items-center gap-3 pt-2">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground">
                  {q.initials}
                </span>
                <div>
                  <p className="text-sm font-semibold">{q.name}</p>
                  <p className="text-xs text-muted-foreground">{q.role}</p>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  const i = useRotatingIndex(CTA_WORDS.length);
  return (
    <section id="cta" className="pb-24 pt-8 sm:pb-32">
      <div className="container-page">
        <div className="rounded-[2rem] bg-foreground px-6 py-20 text-center text-background sm:rounded-[2.5rem] sm:py-28">
          <h2 className="mx-auto max-w-3xl text-3xl font-semibold tracking-tight sm:text-6xl">
            Get your{" "}
            <span key={CTA_WORDS[i]} className="word-in inline-block text-background/70 underline decoration-background/30 decoration-[3px] underline-offset-8">
              {CTA_WORDS[i]}
            </span>
            <br />
            out of the spreadsheet.
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-background/70">
            Start free with the spreadsheet you already have. Upgrade when your whole team moves in.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <a href="#" className="btn-light">
              Get started free
            </a>
            <a href="#" className="btn-ghost-light">
              Contact sales
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const cols: { title: string; links: string[] }[] = [
    { title: "Product", links: ["How it works", "Enterprise", "Templates", "Integrations", "Pricing"] },
    { title: "Company", links: ["About", "Customers", "Careers", "Contact"] },
    { title: "Resources", links: ["Docs", "Blog", "Community", "Help center"] },
    { title: "Legal", links: ["Privacy", "Terms", "Security"] },
  ];
  return (
    <footer className="border-t border-border py-14">
      <div className="container-page">
        <div className="grid gap-10 sm:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <a href="#" className="flex items-center gap-2.5">
              <LogoMark />
              <span className="text-lg font-semibold tracking-tight">Stackflo</span>
            </a>
            <p className="mt-4 max-w-xs text-sm text-muted-foreground">
              The business operating system that starts with the spreadsheet you already have.
            </p>
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <p className="text-sm font-semibold">{c.title}</p>
              <ul className="mt-4 space-y-2.5">
                {c.links.map((l) => (
                  <li key={l}>
                    <a href="#" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-12 text-xs text-muted-foreground">© 2026 Stackflo, Inc. All rights reserved.</p>
      </div>
    </footer>
  );
}

function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <main>
        <Hero />
        <LogoStrip />
        <HowItWorks />
        <Agents />
        <HomeMockups />
        <Integrations />
        <Govern />
        <Templates />
        <Stories />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
