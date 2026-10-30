# Bahi — autonomous data entry for Indian manufacturing

Bahi is a chat-first data entry workspace. Send a supplier invoice, purchase order, goods
receipt, e-way bill, e-invoice or bank statement — as a PDF, spreadsheet, CSV, XML or plain
text. Bahi reads it, checks it against GST rules, and either enters it in TallyPrime, Excel or
Google Sheets, or puts it in a review queue with a plain-language reason.

The product is multi-tenant: every workspace gets its own Postgres schema, its own settings
and autonomy gates, and a full audit trail.

## Marketing site + product in one app

The original repository was a [Lovable](https://lovable.dev) landing page. The design system
(warm near-white palette, Archivo type, pill buttons, card language, dark feature panels,
`agents-backdrop` artwork) is unchanged — only the content was rebranded to Bahi. The landing
page, auth screens and product screens all share the same tokens and components.

| Route               | What it is                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| `/`                 | Landing page                                                                  |
| `/login`, `/signup` | Supabase-backed auth, with a one-click demo workspace                         |
| `/app`              | Chat: upload, paste or ask; watch extraction → checks → posting               |
| `/app/queue`        | Review queue with status, type, destination and reason filters                |
| `/app/exceptions`   | Documents Bahi could not read, with the reason and source chat                |
| `/app/activity`     | Audit trail of every extraction, posting, edit and setting change             |
| `/app/insights`     | Automation rate, waiting work, review reasons, confidence bands, agent health |
| `/app/agents`       | Agent run ledger, learning proposals and the confirmed Sheet layout           |
| `/app/settings`     | Autonomy, limits, destinations, industry pack, team, intake, retention, jobs  |
| `/invite`           | Accept a workspace invite and join with the invited email address             |

## The flow

1. **Ingest.** Files and chat text are stored in the tenant schema and parsed in-process
   (`unpdf`, ExcelJS, XML/CSV readers, plain text).
2. **Classify and extract.** The Document Classifier splits a file into typed segments, then
   the Extraction agent pulls vendor, GSTIN, invoice number/date, taxable value,
   CGST/SGST/IGST, round-off, totals, PO/GRN and bank narration for each segment. Both report
   per-field confidence. Without an AI key they fall back to the deterministic text engine in
   `src/server/extraction.ts`.
3. **Match and route.** The Master Data Matcher resolves suppliers against the tenant's
   vendor masters, the Bank Statement Categoriser proposes ledger categories, and
   `src/server/router.ts` auto-posts only when all of the following hold: autonomous mode,
   kill switch off, confidence at/above the destination threshold, no blocking warnings, no
   unresolved new-party match, amount under the value cap, and room left under the daily cap.
   Everything else lands in `pending_review` with reasons.
4. **Check and explain.** `src/server/rules.ts` runs the GST rule book: arithmetic, tax split
   vs intra/inter-state, GSTIN format and state code, invoice date sanity, duplicate business
   key, PO/GRN match, bank line balance, and per-industry pack rules. When records are
   available, `matching.server.ts` links a purchase invoice to its purchase order and goods
   receipt (₹100 or 1% tolerance) and to imported GSTR-2B lines by supplier GSTIN and invoice
   number; mismatches become warnings and block auto-posting. With `GSTIN_API_URL` set, the
   supplier's GSTIN is checked against the provider and its status is stored with the record.
   The Validation Explainer turns every warning or failure into a plain-language reason and a
   next step.
5. **Enter.** The Destination Mapper proposes a destination shape and sheet columns;
   `src/server/posting.server.ts` writes with an idempotency key
   (`destination + business key`), so re-sending a bill cannot double-post.
   - **TallyPrime** — Tally XML voucher with balanced ledger entries and a `[BAHI:<key>]`
     narration marker. Purchase invoices carry GSTIN, reference, expense ledger, TDS and line
     inventory; credit notes become purchase returns, purchase orders become Purchase Order
     vouchers and goods receipts become Receipt Notes. Downloadable from the record sheet.
   - **Excel** — ExcelJS workbook by default, or the accountant's own `.xlsx` template once it
     is uploaded in Settings: header labels are mapped, values are placed under the right
     columns, and the file's formats and formulas are kept.
   - **Google Sheets** — real Sheets API writes after OAuth, following the owner-confirmed
     column layout; each appended row is stored so it can be undone.
6. **Learn.** Edits in the record sheet and every approval or reject are written to the audit
   trail with a reason. Approvals also teach the vendor masters. The Learning Curator groups
   repeated corrections per supplier and field; the owner confirms a proposal on `/app/agents`
   before it changes matching or defaults.

## The eight agents

All agents live in `src/server/agents/` and share one runner:

| Agent                      | What it does                                                               | Deterministic fallback                  |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| Chat Orchestrator          | Turns a chat message into one of a fixed set of intents and tool arguments | `parseChatAction` / regex intent parser |
| Document Classifier        | Splits a file into segments and labels each `doc_type`                     | Filename + keyword scoring              |
| Extraction                 | Reads fields and per-field confidence from a segment                       | `src/server/extraction.ts`              |
| Master Data Matcher        | Matches vendor name/GSTIN to masters; flags new or ambiguous parties       | Normalised exact/fuzzy match            |
| Validation Explainer       | Explains flagged rules and suggests the next step                          | Rule message plus a next-step map       |
| Destination Mapper         | Proposes the destination and, for sheets, the column layout                | Standard Tally/Excel/Sheet shape        |
| Bank Statement Categoriser | Assigns a ledger category to each statement line                           | Keyword rules per narration             |
| Learning Curator           | Groups repeated corrections into rule proposals                            | Same grouping, no model                 |

Each agent has a versioned prompt (`src/server/agents/prompts.ts`), a Zod output schema, and a
fallback that always produces a valid result. `src/server/agents/runner.server.ts` adds the
shared behaviour: one schema retry, model errors degrade to the deterministic result with an
escalation flag so the record cannot auto-post, token/cost accounting in the per-tenant
`agent_runs` table, and metadata-only Langfuse tracing (never document or chat text).

Agents are untrusted-input readers: documents and chat are wrapped in delimiters, the
Orchestrator can only return known intents, the Explainer's rule ids are reconciled against
the deterministic results, and the Matcher/Curator can propose but never write to a
destination or hold credentials. Routing and posting remain the only writers.

The deterministic path is not a stub: with no `AI_API_KEY`, every agent still runs, the
product behaves identically, and `/app/agents` says "rules only". Add a key to let agents
handle ambiguous classification, extraction and matching; failures still fall back safely.

## Tools and function calling

Section 6a of the specification is implemented as typed, in-process tools in
`src/server/agents/tools/`, with one definition per function and an exact per-agent allowlist:

| Agent                      | Tools | Examples                                                                                                                                |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Chat Orchestrator          | 16    | `start_processing`, `get_batch_status`, `get_record_card`, `apply_correction`, `approve_records`, `explain_flag`, `connect_destination` |
| Document Classifier        | 2     | `get_pack_document_types`, `get_page_images`                                                                                            |
| Extraction                 | 4     | `get_extraction_schema`, `get_similar_examples`, `get_field_crop`, `get_ocr_text`                                                       |
| Master Data Matcher        | 6     | `find_party_by_gstin`, `search_parties`, `get_remembered_mapping`, `search_ledgers`, `search_stock_items`, `get_party_history`          |
| Validation Explainer       | 0     | It works from stored rule results only                                                                                                  |
| Destination Mapper         | 3     | `inspect_sheet_headers`, `get_record_field_list`, `get_confirmed_mapping`                                                               |
| Bank Statement Categoriser | 4     | `get_known_payee_mappings`, `search_ledgers`, `get_party_history`, `search_open_bills`                                                  |
| Learning Curator           | 2     | `get_correction_groups`, `get_existing_rules`                                                                                           |

`src/server/agents/tools/index.ts` builds the catalogue and validates it at test time: no
missing or unlisted tool, no tool registered for an agent outside its list, and no JSON
schema that accepts `tenant_id`, `user_id` or `schema`. Tenant and user identity comes from
the run context and session, never from model arguments; tools reject injected identity
before parsing arguments.

Every call goes through `executeTool`, which enforces permission checks inside the tool,
records a row in the tenant `tool_calls` ledger (agent, tool, kind, status, error code,
duration, short summary, no document text), and traces metadata only. Writes require an
idempotency key; a replay with the same key returns the stored result instead of repeating
the action. Each run is capped at 8 tool calls. Agents still cannot write a destination or
hold credentials: approval tools call the same approval service as the buttons, and routing
and posting remain the only writers.

The non-agent workflow in `src/server/workflow.server.ts` exposes the 6a.10 server functions
under their specification names (intake, pipeline, destination, approval, learning, audit),
while `bridge.server.ts` shapes and validates bridge commands for the polling agent.
`connectors.server.ts` defines the validate/write/confirm/rollback/health interface used by
Tally, Excel and Google Sheets.

## Platform controls

Settings is the owner's control panel. Members can read it; only the owner can change it.

- **Permission levels (spec 6b).** The owner picks one of three levels from the chat input or
  Settings: **Ask every time** (every record waits), **Auto approve** (default; posts clean
  records and asks when a risk condition appears) or **Full access** (never asks, switched on
  only after typing `FULL ACCESS`). Auto approve holds a record when confidence is below the
  threshold, a warning is not allowed, the value is above the document cap, the spreadsheet
  mapping is unconfirmed, the destination is unreachable, the scan is blurred or unsure, or
  the kill switch, ceiling or daily cap applies. Full access skips the confidence, warning,
  stage and shadow checks but keeps the hard stops: failed validation, duplicates, the kill
  switch, the daily cap and the owner-set ceiling amount. The level is captured when a run
  starts (`documents.permission_level`), copied to the record, and the level that approved a
  write is stored in `records.approved_permission_level` and the activity trail. The Chat
  Orchestrator receives the run's level in its context so it can explain decisions, and its
  prompt states that it cannot change it. Auto approve still honours the workspace's autonomy
  stage, so a tenant in shadow mode records the decision without writing. No agent tool can
  change the level.

- **Industry packs.** `bahi.packs` holds a versioned config per industry. The workspace
  activates a published version, can roll back to an earlier one, and can save a JSON
  override on top. Overrides are merged (objects recursively, arrays replaced) and the
  effective config is re-read into the session on the next request. Prototype keys are
  rejected, overrides are capped at 20 KB, and every activation, rollback and override is
  written to the activity trail.
- **Team.** The owner invites a person by email from Settings; the invite token is shown as
  a link to `/invite?token=…`, is stored hashed, and expires after seven days. Accepting it
  requires signing in with the invited email address. Owners can change roles and remove
  people, but the last owner cannot be demoted or removed.
- **Intake addresses.** Each email or WhatsApp address has its own secret, shown once when
  the source is created. Forwarded mail or messages POST to `/api/intake/email` or
  `/api/intake/whatsapp` with `{ address, secret, files?, text?, externalId?, from? }`.
  Repeated `externalId`s are ignored, every delivery is recorded in `intake_events`, and the
  work is queued as an `intake.process` job that runs through the same pipeline as an
  upload. Without a provider sender, forwarding is wired by the customer's own mailbox or
  relay.
- **Durable jobs.** `bahi.jobs` is a small Postgres queue: atomic `for update skip locked`
  claims, exponential backoff (`attempts²` minutes, capped at an hour), and stuck-run
  recovery after 30 minutes. Three kinds exist: `retention.purge`, `intake.process` and
  `notifications.digest`. `GET /api/jobs/run` drains the queue and, with `?schedule=1`,
  queues the daily retention and digest work; it requires `CRON_SECRET` in
  `x-cron-secret` or a Bearer header. Settings lists recent jobs with status and last error.
- **Retention.** The owner sets `retentionDays`. The purge job deletes documents (and their
  storage objects) older than that or past their own `retention_until`, then prunes expired
  sessions, invites and OAuth states. A manual "Purge now" button queues the same job.

## Stack

- TanStack Start + TanStack Router, React 19, Vite 8, TypeScript strict
- Tailwind v4 + shadcn/ui components, sonner toasts, lucide icons
- Supabase Auth for identity; a custom opaque `bahi_session` cookie for the app session
- Postgres (`pg`) with a `bahi` control schema and one schema per tenant
- Zod validation on every server function, CSRF protection in `src/start.ts`
- Vitest for tests, ESLint + Prettier

Server functions live in [`src/lib/api.ts`](src/lib/api.ts). They are a client-safe facade
over `src/server/**`; Vite import-protection forbids client code from importing the server
modules directly.

## Local setup

Requirements: Node.js 22+ (uses `process.loadEnvFile`) and a Postgres database Supabase can
reach.

```sh
npm install
cp .env.example .env   # if you keep one; otherwise create .env with the keys below
npm run db:migrate
npm run db:seed
npm run dev
```

`.env` keys:

```dotenv
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=        # or SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=                    # Postgres connection string
SESSION_SECRET=                  # random 32+ byte string
DEMO_EMAIL=                      # demo account created by db:seed
DEMO_PASSWORD=
DEMO_TENANT_NAME=Shree Metals Works

# Optional. Leave AI_API_KEY empty to run every agent deterministically.
AI_API_KEY=
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL_SMALL=gpt-4o-mini
AI_MODEL_LARGE=gpt-4o
AI_VISION_MODEL=                # defaults to AI_MODEL_LARGE
AI_TIMEOUT_MS=45000

# Optional. Without a URL only the local GSTIN format and checksum are checked.
GSTIN_API_URL=                  # include {gstin}, or the GSTIN is appended as ?gstin=
GSTIN_API_KEY=

# Optional. Google Sheets OAuth; without it the connection reports not configured.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=            # e.g. http://localhost:8080/api/google/callback

# Optional. Signs bridge poll responses for the Tally agent.
BRIDGE_SIGNING_SECRET=
BRIDGE_POLL_LIMIT=10

# Authenticates GET /api/jobs/run (x-cron-secret or Bearer). Without it the endpoint is 503.
CRON_SECRET=

# Optional. Base URL for OAuth callbacks and link building.
APP_BASE_URL=
# Required in production when Google Sheets is connected: 64 hex characters.
TOKEN_ENCRYPTION_KEY=

# Optional. JSON webhook that receives the daily digest ({to, subject, text}).
EMAIL_API_URL=
EMAIL_API_KEY=

# Optional metadata-only tracing.
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=https://cloud.langfuse.com
```

`npm run db:seed` creates the demo owner in Supabase Auth (if needed), the local user and
tenant, seeds the vendor masters, then seeds four conversations: supplier invoices (one
auto-posted, two waiting), a bank statement, and a photo that needs attention. It is
idempotent: an existing demo workspace is reused and missing vendor masters are backfilled.

The easiest way in is the **Open the demo workspace** button on `/login` or `/signup`; it
signs in the demo owner and creates the same workspace on first use. The account can also be
used with the email/password form.

## Checks

```sh
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm test` runs routing and unit tests. The demo-workspace test touches the live database and
is opt-in:

```sh
BAHI_SEED=1 npm test
```

`npm run build` produces a Nitro `node-server` bundle in `.output/` (the app needs `pg` and
`node:crypto`, so it is not an edge build). Run it with:

```sh
PORT=8080 node .output/server/index.mjs
```

Deploy the `.output` directory to any Node host and provide the same environment variables.

## Deliberate deviations from the PRD

- **Agents run in-process in TypeScript.** The specification proposes a Python/FastAPI worker
  with Inngest orchestration and a Next.js front end. Bahi keeps the working TanStack Start
  app and implements the same eight agents as typed server modules with a shared runner,
  retries, envelopes, a per-tenant run ledger and optional tracing. Durable background work
  uses a Postgres job table (`bahi.jobs`) drained by `/api/jobs/run` instead of Inngest; the
  Learning Curator remains an owner-triggered server function.
- **Deterministic by default, vision when a key exists.** Every agent has a real
  deterministic fallback rather than a demo stub. With `AI_API_KEY` set, the
  OpenAI-compatible adapter takes over for ambiguous cases; a schema failure gets one retry,
  then degrades to the deterministic result with an escalation flag that blocks auto-posting.
  With a key, phone photos and scanned PDFs are transcribed by the vision model
  (`AI_VISION_MODEL`, default `AI_MODEL_LARGE`), rendered locally with `unpdf` +
  `@napi-rs/canvas`, then fed through the same deterministic classifier and extractor. The
  document records `render_mode = 'vision'`. Without a key, scans route to `/app/exceptions`
  with an honest explanation instead of guessed values.
- **Supabase Auth instead of WorkOS.** Supabase was the supplied backend. WorkOS variables
  were provided but are not required at runtime.
- **Tally is a bridge, not a plugin.** Bahi validates Tally XML vouchers, queues them in
  `bridge_commands`, and a signed polling agent (`bridge/bahi-bridge.mjs`) running beside
  TallyPrime imports them idempotently, acknowledges the result, and can cancel vouchers and
  export masters. Without a registered agent, writes fail with setup guidance — the voucher
  XML is still downloadable.
- **Google Sheets is a real OAuth adapter.** Connecting uses Google's authorization-code
  flow with single-use state, tokens are encrypted at rest (AES-256-GCM), and writes call the
  Sheets API (`values:append`) after the header row is seeded. Column mappings decide
  placement, the appended range is stored as the external reference, and reversing an entry
  deletes the appended row. Without Google credentials or a chosen spreadsheet, writes fail
  with guidance.
- **Tool calling is in-process.** The specification's Python/Pydantic tool runtime is
  implemented as typed TypeScript tools with Zod schemas, the same allowlists, typed errors,
  idempotency and a `tool_calls` ledger. The OpenAI-compatible adapter runs a bounded
  function-calling loop; with no key, agents keep their deterministic paths and never call
  tools.
- **Compliance adapters need credentials, and say when they are missing.** The GSTR-2B
  import (portal JSON or CSV), Excel template filling and pgvector content dedupe work
  without third-party credentials. GSTN verification and Google Sheets require
  `GSTIN_API_URL` / Google OAuth; without them those steps report unconfigured rather than
  pretending to verify. There is no virus scanner and no outbound email/WhatsApp sender in
  this build, so those tools and workflow functions return typed `unavailable` results. The
  digest job only posts to `EMAIL_API_URL` when it is configured. Inbound intake is real:
  per-source webhooks at `/api/intake/$channel` feed uploaded mail and messages into the
  same pipeline.
- **Duplicate scans are caught locally.** Document text over 200 characters is embedded with
  the deterministic `bahi-hash-256` embedding into the tenant's pgvector column; a new upload
  within 0.99 cosine similarity of an earlier document is flagged as a likely duplicate and
  held for review instead of creating a second entry.
- **Permission levels are workspace-wide.** Build spec 6b marks per-destination overrides as
  optional and later work, so this build applies the selected Ask/Auto/Full level to every
  destination and the hard ceiling is a single owner-set amount.
- **One live industry pack.** Manufacturing is live end to end. CA/bookkeeping, education and
  e-commerce are shown as planned on the landing page.

## Layout

```
src/routes/               landing, auth, app shell and product pages
src/components/app/       sidebar, record card, record sheet, status badges
src/components/           brand, auth shell, demo button, shared UI
src/lib/api.ts            server-function facade used by the client
src/server/               auth, db, extraction, rules, router, pipeline, posting, repo
src/server/agents/        runner, config, provider, prompts, tracing and the eight agents
src/server/packs.server.ts    pack registry, activation, rollback and overrides
src/server/jobs.server.ts     Postgres job queue, retention purge and digest
src/server/intake.server.ts   intake sources, webhook auth and job processing
src/server/team.server.ts     invites, roles and invite acceptance
src/routes/api.*.ts       Google OAuth, bridge, intake and cron endpoints
scripts/migrate.mjs       control schema + tenant schema DDL
scripts/seed.mjs          demo user, tenant, vendor masters and conversations
```
