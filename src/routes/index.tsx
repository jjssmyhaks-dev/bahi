import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import heroImage from "@/assets/hero-diorama.jpg";
import agentsBackdrop from "@/assets/agents-backdrop.jpg";
import { LogoMark } from "@/components/brand";
import { DemoButton } from "@/components/demo-button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Bahi — Invoices in. Tally updated. Nobody typed a thing." },
      {
        name: "description",
        content:
          "Bahi reads supplier invoices, statements and bills, checks them against GST rules, and enters the clean ones into TallyPrime, Excel or Google Sheets. Only the exceptions wait for you.",
      },
      { property: "og:title", content: "Bahi — Invoices in. Tally updated. Nobody typed a thing." },
      {
        property: "og:description",
        content:
          "Chat-first data entry for manufacturing teams. Upload a bill, get a checked Tally voucher.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LandingPage,
});

/* ---------------------------------- data ---------------------------------- */

const NAV_LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Autonomy", href: "#autonomy" },
  { label: "Industry packs", href: "#packs" },
  { label: "Security", href: "#govern" },
  { label: "Customers", href: "#stories" },
];

const PROMPT_EXAMPLES = [
  "Enter this Deccan Steel invoice in Tally",
  "Read this HDFC statement into a Google Sheet",
  "Check the GSTIN on this Apex Polymers bill",
  "Log this October purchase bill in Excel",
];

const WORDMARKS = [
  { name: "SHREE METALS", className: "font-bold tracking-[0.25em]" },
  { name: "Deccan Steel", className: "font-serif italic text-xl" },
  { name: "Apex Polymers", className: "font-semibold tracking-tight" },
  { name: "KIRTI ENG", className: "font-medium tracking-widest" },
  { name: "optimo", className: "font-bold lowercase tracking-tight" },
  { name: "Marlowe", className: "font-serif text-xl" },
  { name: "HALDEN&CO", className: "font-extrabold tracking-[0.2em]" },
];

const STEPS = [
  {
    n: "01",
    title: "Send",
    text: "Forward a bill photo, a PDF, a bank statement — or just type one line: “Enter this in Tally.”",
  },
  {
    n: "02",
    title: "Read",
    text: "Bahi reads the document end to end: vendor, GSTIN, invoice date, line items, tax and totals.",
  },
  {
    n: "03",
    title: "Extract",
    text: "Every field becomes a structured record, scored field by field so you can see what it is sure about.",
  },
  {
    n: "04",
    title: "Check",
    text: "GSTIN checksum, place of supply, tax arithmetic, duplicate bills, HSN rates, e-invoice and e-way thresholds.",
  },
  {
    n: "05",
    title: "Decide",
    text: "Clear records post themselves. Anything uncertain goes to review with the reason written in plain English.",
  },
  {
    n: "06",
    title: "Enter",
    text: "TallyPrime vouchers, Excel workbooks or Google Sheet rows — written once, with the source document attached.",
  },
  {
    n: "07",
    title: "Learn",
    text: "Every correction teaches the workspace. Thresholds, rules and limits stay under your control.",
  },
];

const DESTINATIONS = [
  "TallyPrime",
  "Excel",
  "Google Sheets",
  "Purchase orders",
  "Goods receipts",
  "E-way bills",
  "E-invoices",
  "Bank statements",
  "Supplier invoices",
];

const GOVERN_POINTS = [
  {
    title: "Autonomy you choose",
    text: "Ask every time, Auto approve, or Full access — with a typed confirmation and hard stops at every level.",
  },
  {
    title: "Owner kill switch",
    text: "One setting stops every automatic write and sends the queue to a person.",
  },
  {
    title: "Isolated tenant data",
    text: "Each workspace gets its own schema, with no shared rows between companies.",
  },
  {
    title: "Complete audit trail",
    text: "Every read, decision, correction and posting stays on the record.",
  },
  {
    title: "Nothing trains a model",
    text: "Your invoices, vendors and prices are never used to train anyone's model.",
  },
];

const COMPLIANCE = ["GST-ready", "AES-256", "Audit trail", "Role-based access"];

const PACKS = [
  {
    glyph: "◧",
    tone: "bg-chip text-chip-foreground",
    name: "Manufacturing",
    status: "Live",
    text: "Supplier invoices, goods receipts, purchase orders and job-work bills for plants and fabricators.",
  },
  {
    glyph: "▤",
    tone: "bg-secondary text-secondary-foreground",
    name: "CA & bookkeeping",
    status: "Next",
    text: "Client-wise inboxes, month-end closings and reviewer sign-off across many sets of books.",
  },
  {
    glyph: "◍",
    tone: "bg-foreground text-background",
    name: "Education admissions",
    status: "Planned",
    text: "Application forms, fee receipts and scholarship documents read into a single roster.",
  },
  {
    glyph: "◈",
    tone: "bg-secondary text-secondary-foreground",
    name: "E-commerce",
    status: "Planned",
    text: "Marketplace statements and courier bills reconciled against orders and returns.",
  },
];

const QUOTES = [
  {
    quote:
      "Four hundred supplier bills a month used to be two people and a lot of typing. Now the clean ones are already in Tally before I sit down.",
    name: "Rohit M.",
    role: "Owner, fabrication unit in Pune",
    initials: "RM",
  },
  {
    quote:
      "The review queue is the part I trust. It tells me exactly why a bill stopped — cancelled GSTIN, wrong state, totals off — instead of hiding it.",
    name: "Sneha K.",
    role: "Accounts lead, auto components supplier",
    initials: "SK",
  },
  {
    quote:
      "Nothing posts without a trail. I can open any voucher in Tally and see the bill photo, the checks and who approved it.",
    name: "Arvind P.",
    role: "Partner, chartered accountancy firm",
    initials: "AP",
  },
];

const CTA_WORDS = ["supplier invoices", "bank statements", "purchase orders", "e-way bills"];

/* --------------------------------- hooks ---------------------------------- */

function useTypewriter(phrases: string[]) {
  const [text, setText] = useState("");

  useEffect(() => {
    let phrase = 0;
    let char = 0;
    let deleting = false;
    let timer = 0;

    const tick = () => {
      const current = phrases[phrase] ?? "";
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

function UploadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="text-muted-foreground"
    >
      <path
        d="M8 10.5V2.5m0 0L4.8 5.7M8 2.5l3.2 3.2M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="9" className="fill-foreground" />
      <path
        d="m5.5 9.2 2.3 2.3 4.7-4.8"
        stroke="var(--color-background)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M2.5 7h9m0 0L7.8 3.3M11.5 7l-3.7 3.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
          <span className="text-lg font-semibold tracking-tight">Bahi</span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
            className="text-muted-foreground"
          >
            <path
              d="m2 3.5 3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </a>

        <nav className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-sm text-foreground/80 transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2.5">
          <a
            href="/login"
            className="hidden text-sm font-medium text-foreground/80 hover:text-foreground sm:block sm:px-3"
          >
            Log in
          </a>
          <a href="/signup" className="btn-outline hidden h-10 sm:inline-flex">
            Create account
          </a>
          <a href="/signup" className="btn-primary h-10 px-4">
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
        <a href="#autonomy" className="chip fade-up group hover:bg-muted">
          <span className="rounded-full bg-chip px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-chip-foreground">
            Live
          </span>
          <span className="font-medium">Manufacturing pack, shipping now</span>
          <ArrowRight className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </a>

        <h1 className="fade-up mt-8 max-w-4xl text-[2.6rem] font-semibold leading-[1.04] tracking-tight sm:text-6xl md:text-[4.2rem]">
          Invoices in. Tally updated.
          <br className="hidden sm:block" /> Nobody typed a thing.
        </h1>

        <p className="fade-up mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          Bahi reads your bills, statements and photos, checks them against GST rules, and enters
          the clean ones into TallyPrime, Excel or Google Sheets. Only the exceptions wait for you.
        </p>

        {/* Prompt box */}
        <div className="fade-up mt-10 w-full max-w-xl rounded-2xl border border-border bg-card p-2 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.18)]">
          <div className="px-3 pt-2 pb-1 text-left">
            <span className="text-base text-muted-foreground sm:text-lg">
              {typed}
              <span className="caret-blink ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-foreground/70" />
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5 pt-1">
            <a
              href="/login"
              className="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <UploadIcon />
              Upload documents
            </a>
            <DemoButton className="btn-primary h-10 px-5">Try the live demo</DemoButton>
          </div>
        </div>
      </div>

      {/* Hero diorama */}
      <div className="relative mx-auto mt-12 max-w-5xl px-6 sm:mt-16">
        <img
          src={heroImage}
          alt="A miniature industrial workshop with tiny workers moving steel, invoices and crates"
          width={1600}
          height={1067}
          className="mx-auto w-full rounded-[2rem] sm:rounded-[2.5rem]"
        />
        <a
          href="#how-it-works"
          className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background shadow-lg transition-colors hover:bg-foreground/85"
        >
          See how it works
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
        Running supplier invoices for manufacturers, distributors and CA teams
      </p>
      <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="animate-marquee flex w-max items-center gap-16 pr-16">
          {row.map((w, i) => (
            <span
              key={`${w.name}-${i}`}
              className={`whitespace-nowrap text-lg text-foreground/45 ${w.className}`}
            >
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
            From a pile of bills to a clean set of books.
          </h2>
          <p className="mt-5 max-w-md text-muted-foreground">
            Seven steps, no templates to fill. You send the paperwork and say where it goes — Bahi
            does the reading, checking and keying.
          </p>
          <a href="/signup" className="btn-primary mt-8">
            Start with one invoice
          </a>
        </div>

        <ol>
          {STEPS.map((s) => (
            <li
              key={s.n}
              className="flex gap-6 border-t border-border py-7 first:border-t-0 first:pt-0 md:py-8"
            >
              <span className="text-sm font-semibold text-muted-foreground">{s.n}</span>
              <div>
                <h3 className="text-lg font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-1.5 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                  {s.text}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function GateRow({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <span className="text-sm font-medium">{name}</span>
      <span className="text-right text-xs text-background/60">{detail}</span>
    </div>
  );
}

function Autonomy() {
  return (
    <section id="autonomy" className="py-6 sm:py-10">
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
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-background/60">
                  Autonomy
                </p>
                <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
                  Clean bills post themselves. The rest wait for you.
                </h2>
                <p className="mt-5 max-w-lg text-background/70">
                  Bahi scores every field and runs your compliance rules. High-confidence, low-risk
                  records go straight through. Anything else stops with a reason you can read.
                </p>
                <div className="mt-8 flex flex-wrap gap-2.5">
                  {["Ask every time", "Auto approve", "Full access"].map((n) => (
                    <span
                      key={n}
                      className="rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-medium"
                    >
                      {n}
                    </span>
                  ))}
                  <span className="rounded-full bg-background px-4 py-1.5 text-sm font-medium text-foreground">
                    + your thresholds
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                <GateRow name="Confidence ≥ 95%" detail="Auto-post to TallyPrime" />
                <GateRow name="Any rule failure" detail="Held for review" />
                <GateRow name="Above ₹5,00,000" detail="Held for review" />
                <GateRow name="Kill switch on" detail="Everything waits" />

                <div className="mt-6 rounded-2xl bg-card p-5 text-foreground shadow-xl">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Apex Polymers · INV-8832</p>
                    <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-semibold text-destructive">
                      Needs review
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    ₹1,35,948 · 17 Oct 2026 · 2 checks failed
                  </p>
                  <div className="mt-4 space-y-2 rounded-xl border border-border bg-background px-3 py-3 text-xs">
                    <p className="flex gap-2">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                      GSTIN 29AAGCA5678K1Z1 is cancelled on the portal.
                    </p>
                    <p className="flex gap-2">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                      Place of supply differs from the buyer's state.
                    </p>
                    <p className="flex gap-2">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/40" />
                      Tax total is ₹12 above the line-item sum.
                    </p>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <span className="rounded-full bg-foreground px-3 py-1.5 text-[11px] font-medium text-background">
                      Approve anyway
                    </span>
                    <span className="rounded-full border border-border px-3 py-1.5 text-[11px] font-medium">
                      Send back to supplier
                    </span>
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

const APP_TILES = ["Inbox", "Review queue", "Posted", "Exceptions", "Activity", "Settings"];

function HomeMockups() {
  return (
    <section id="mobile" className="py-24 sm:py-32">
      <div className="container-page">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Operate</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            One chat for the paperwork. One queue for the exceptions.
          </h2>
          <p className="mt-5 text-muted-foreground">
            Send documents from the office or the shop floor. Everything you've read, checked and
            posted stays in one auditable place.
          </p>
        </div>

        <div className="mt-14 grid items-center gap-8 lg:grid-cols-[1.6fr_1fr]">
          {/* Desktop mock */}
          <div className="rounded-[1.75rem] border border-border bg-card p-4 shadow-[0_30px_80px_-30px_rgb(0_0_0/0.2)] sm:p-6">
            <div className="flex items-center gap-3 border-b border-border pb-4">
              <LogoMark />
              <div>
                <p className="text-sm font-semibold">Shree Metals Works</p>
                <p className="text-xs text-muted-foreground">Autonomous · TallyPrime connected</p>
              </div>
              <span className="ml-auto hidden rounded-full border border-border px-3 py-1 text-xs text-muted-foreground sm:block">
                Attach a bill or type a command
              </span>
            </div>

            <div className="mt-5 space-y-3 text-xs">
              <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-foreground px-4 py-3 text-background">
                <p>Enter this Deccan Steel invoice in Tally.</p>
                <p className="mt-1.5 text-background/60">deccan-steel-INV-2418.pdf · 1 page</p>
              </div>
              <div className="max-w-[88%] rounded-2xl rounded-bl-md border border-border bg-background px-4 py-3">
                <p className="font-medium">
                  Read it. Everything checks out — posted to TallyPrime.
                </p>
                <div className="mt-3 overflow-hidden rounded-xl border border-border">
                  <div className="grid grid-cols-3 gap-2 border-b border-border bg-muted px-3 py-2 font-semibold text-muted-foreground">
                    <span>Field</span>
                    <span>Value</span>
                    <span>Confidence</span>
                  </div>
                  {[
                    ["Vendor", "Deccan Steel", "98%"],
                    ["Taxable value", "₹1,18,000.00", "97%"],
                    ["GST (18%)", "₹21,240.00", "99%"],
                  ].map((r) => (
                    <div key={r[0]} className="grid grid-cols-3 gap-2 px-3 py-2">
                      <span className="text-muted-foreground">{r[0]}</span>
                      <span className="font-medium">{r[1]}</span>
                      <span className="text-muted-foreground">{r[2]}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-muted-foreground">
                  Voucher BAHI/202610/CF9C98 · idempotent, no duplicates.
                </p>
              </div>
            </div>

            <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Workspace
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {APP_TILES.map((t, i) => (
                <div
                  key={t}
                  className="rounded-xl border border-border bg-background p-4 transition-colors hover:bg-muted"
                >
                  <span
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold ${i % 3 === 0 ? "bg-foreground text-background" : "bg-secondary text-secondary-foreground"}`}
                  >
                    {t[0]}
                  </span>
                  <p className="mt-2.5 text-sm font-medium">{t}</p>
                  <p className="text-xs text-muted-foreground">
                    {i === 1
                      ? "2 waiting · 1 cancelled GSTIN"
                      : i === 2
                        ? "18 this month · ₹4.2L"
                        : i === 3
                          ? "1 photo needs OCR"
                          : i % 2 === 0
                            ? "Updated 2h ago"
                            : "Updated today"}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Phone mock */}
          <div className="mx-auto w-full max-w-[290px] rounded-[2.5rem] border border-border bg-card p-3 shadow-[0_30px_80px_-30px_rgb(0_0_0/0.25)]">
            <div className="rounded-[2rem] bg-background p-5">
              <p className="text-xs text-muted-foreground">9:41</p>
              <p className="mt-3 text-sm font-semibold">Good morning, Rohit</p>
              <p className="text-xs text-muted-foreground">3 records need you</p>
              <div className="mt-4 rounded-xl border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
                Attach a bill or type a command
              </div>
              <p className="mt-5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Queue
              </p>
              <div className="mt-2 space-y-2">
                {[
                  ["Apex Polymers", "GSTIN cancelled"],
                  ["Kirti Engineering", "86% confidence"],
                  ["Site photo 0421", "No readable text"],
                  ["HDFC statement", "Written to Sheets"],
                ].map((t) => (
                  <div
                    key={t[0]}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
                  >
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-secondary text-xs font-bold text-secondary-foreground">
                      {t[0]?.[0]}
                    </span>
                    <div>
                      <p className="text-xs font-medium">{t[0]}</p>
                      <p className="text-[10px] text-muted-foreground">{t[1]}</p>
                    </div>
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
          <p className="eyebrow">Destinations</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            Writes into the books you already keep
          </h2>
          <p className="mt-5 max-w-lg text-muted-foreground">
            Bahi doesn't ask you to replace Tally or your spreadsheets. It prepares and writes the
            entry, attaches the source, and records the trail — in the format your team already
            opens every morning.
          </p>
          <div className="mt-8 flex flex-wrap gap-2.5">
            {DESTINATIONS.map((n) => (
              <span key={n} className="chip">
                {n}
              </span>
            ))}
          </div>
          <a href="#cta" className="btn-outline mt-8">
            See the connectors
            <ArrowRight />
          </a>
        </div>

        <div className="rounded-[1.75rem] border border-border bg-card p-6 shadow-[0_24px_60px_-28px_rgb(0_0_0/0.18)] sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Try a command
          </p>
          <p className="mt-4 text-lg font-medium leading-snug">
            Enter the October HDFC statement into my Google Sheet, one row per transaction.
          </p>
          <div className="mt-6 flex items-center justify-between rounded-xl bg-muted px-4 py-3">
            <span className="text-sm text-muted-foreground">
              TallyPrime + Google Sheets connected
            </span>
            <span className="btn-primary h-9 px-4 text-xs">Run it</span>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 text-xs text-muted-foreground">
            {["23 Oct · -₹23,600", "24 Oct · -₹45,000", "25 Oct · -₹118"].map((d) => (
              <div
                key={d}
                className="rounded-lg border border-border bg-background px-3 py-2.5 font-medium text-foreground/80"
              >
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
            Your data stays yours. Your ledger stays clean.
          </h2>
          <p className="mt-5 max-w-lg text-muted-foreground">
            Bahi writes to your books under rules you set. Every automatic entry can be traced back
            to the source document, the checks it passed, and the person who approved it.
          </p>
          <div className="mt-8 flex flex-wrap gap-2.5">
            {COMPLIANCE.map((c) => (
              <span key={c} className="chip font-semibold">
                {c}
              </span>
            ))}
          </div>
          <a href="#cta" className="btn-outline mt-8">
            Read the security notes
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

function Packs() {
  return (
    <section id="packs" className="py-24 sm:py-32">
      <div className="container-page">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Industry packs</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">
            Rules that match how your business actually works
          </h2>
          <p className="mt-5 text-muted-foreground">
            A pack bundles document types, validation rules and destination mappings. Start with
            manufacturing — the rest are on the way.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PACKS.map((t) => (
            <div
              key={t.name}
              className="group rounded-2xl border border-border bg-card p-6 transition-shadow hover:shadow-[0_20px_50px_-24px_rgb(0_0_0/0.25)]"
            >
              <span
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl text-lg font-bold ${t.tone}`}
              >
                {t.glyph}
              </span>
              <div className="mt-4 flex items-center gap-2">
                <h3 className="font-semibold tracking-tight">{t.name}</h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${t.status === "Live" ? "bg-chip text-chip-foreground" : "bg-muted text-muted-foreground"}`}
                >
                  {t.status}
                </span>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t.text}</p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium opacity-0 transition-opacity group-hover:opacity-100">
                {t.status === "Live" ? "Use this pack" : "Join the waitlist"} <ArrowRight />
              </span>
            </div>
          ))}
        </div>

        <div className="mt-10 text-center">
          <a href="/signup" className="btn-primary">
            Start with the manufacturing pack
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
          Built for the people who close the books
        </h2>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {QUOTES.map((q) => (
            <figure
              key={q.name}
              className="flex flex-col rounded-2xl border border-border bg-card p-7"
            >
              <blockquote className="text-[15px] leading-relaxed text-foreground/90">
                “{q.quote}”
              </blockquote>
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
            <span
              key={CTA_WORDS[i]}
              className="word-in inline-block text-background/70 underline decoration-background/30 decoration-[3px] underline-offset-8"
            >
              {CTA_WORDS[i]}
            </span>
            <br />
            out of the typing pile.
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-background/70">
            Open the demo workspace with seeded invoices, a bank statement and a review queue — no
            setup, no card.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <DemoButton className="btn-light">Open the demo workspace</DemoButton>
            <a href="/signup" className="btn-ghost-light">
              Create an account
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const cols: { title: string; links: string[] }[] = [
    {
      title: "Product",
      links: ["How it works", "Autonomy", "Industry packs", "Destinations", "Security"],
    },
    { title: "Company", links: ["About", "Customers", "Careers", "Contact"] },
    { title: "Resources", links: ["Docs", "Changelog", "Community", "Help center"] },
    { title: "Legal", links: ["Privacy", "Terms", "Security"] },
  ];
  return (
    <footer className="border-t border-border py-14">
      <div className="container-page">
        <div className="grid gap-10 sm:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <a href="#" className="flex items-center gap-2.5">
              <LogoMark />
              <span className="text-lg font-semibold tracking-tight">Bahi</span>
            </a>
            <p className="mt-4 max-w-xs text-sm text-muted-foreground">
              Chat-first data entry for the invoices, statements and bills that keep your books
              behind.
            </p>
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <p className="text-sm font-semibold">{c.title}</p>
              <ul className="mt-4 space-y-2.5">
                {c.links.map((l) => (
                  <li key={l}>
                    <a
                      href="#"
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-12 text-xs text-muted-foreground">© 2026 Bahi. All rights reserved.</p>
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
        <Autonomy />
        <HomeMockups />
        <Integrations />
        <Govern />
        <Packs />
        <Stories />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
