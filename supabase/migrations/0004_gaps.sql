-- Bahi — gap closure
--
-- Adds the control-plane tables and tenant columns the PRD calls for:
-- Tally bridge agents and commands, Google OAuth tokens, durable jobs, pack
-- registry, invites, intake sources, review assignment, GSTR-2B lines,
-- evaluation records and autonomy events. Every statement is idempotent.

create table if not exists bahi.packs (
  key text not null,
  version text not null,
  name text not null,
  industry text not null,
  status text not null default 'published' check (status in ('draft', 'published', 'retired')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (key, version)
);

insert into bahi.packs (key, version, name, industry, status, config)
values (
  'manufacturing',
  '1.0.0',
  'Manufacturing (India)',
  'manufacturing',
  'published',
  '{"catalogue":["supplier_invoice","purchase_order","goods_receipt","e_way_bill","e_invoice","bank_statement"],"rulesVersion":"2026-04"}'::jsonb
)
on conflict (key, version) do nothing;

create table if not exists bahi.bridge_agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references bahi.tenants(id) on delete cascade,
  label text not null,
  company_name text not null,
  token_hash text not null unique,
  tally_url text,
  version text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists bridge_agents_tenant_idx on bahi.bridge_agents (tenant_id, status);

create table if not exists bahi.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references bahi.tenants(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jobs_due_idx on bahi.jobs (status, run_after);
create index if not exists jobs_tenant_idx on bahi.jobs (tenant_id, created_at desc);

drop trigger if exists jobs_updated on bahi.jobs;
create trigger jobs_updated before update on bahi.jobs
  for each row execute function bahi.set_updated_at();

create table if not exists bahi.invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references bahi.tenants(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'reviewer', 'viewer')),
  token_hash text not null unique,
  invited_by uuid references bahi.users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invites_tenant_idx on bahi.invites (tenant_id, created_at desc);

create table if not exists bahi.intake_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references bahi.tenants(id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp')),
  address text not null,
  secret_hash text,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  unique (channel, address)
);

create table if not exists bahi.oauth_states (
  state_hash text primary key,
  tenant_id uuid not null references bahi.tenants(id) on delete cascade,
  user_id uuid not null references bahi.users(id) on delete cascade,
  provider text not null,
  redirect_to text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists oauth_states_expiry_idx on bahi.oauth_states (expires_at);

alter table bahi.tenants add column if not exists autonomy_stage integer not null default 1;
alter table bahi.tenants add column if not exists retention_days integer not null default 365;
alter table bahi.tenants add column if not exists error_budget_pct numeric(5, 2) not null default 0.50;
alter table bahi.tenants add column if not exists shadow_mode boolean not null default true;
alter table bahi.tenants add column if not exists pack_config jsonb not null default '{}'::jsonb;

-- Control-plane RLS. The app role bypasses RLS; these policies protect any
-- request made with the anon/authenticated roles.
alter table bahi.packs enable row level security;
alter table bahi.bridge_agents enable row level security;
alter table bahi.jobs enable row level security;
alter table bahi.invites enable row level security;
alter table bahi.intake_sources enable row level security;
alter table bahi.oauth_states enable row level security;

drop policy if exists packs_read on bahi.packs;
create policy packs_read on bahi.packs for select using (status = 'published');

drop policy if exists bridge_agents_tenant on bahi.bridge_agents;
create policy bridge_agents_tenant on bahi.bridge_agents using (
  tenant_id = nullif(current_setting('bahi.tenant_id', true), '')::uuid
);

drop policy if exists jobs_tenant on bahi.jobs;
create policy jobs_tenant on bahi.jobs using (
  tenant_id is null or tenant_id = nullif(current_setting('bahi.tenant_id', true), '')::uuid
);

drop policy if exists invites_tenant on bahi.invites;
create policy invites_tenant on bahi.invites using (
  tenant_id = nullif(current_setting('bahi.tenant_id', true), '')::uuid
);

drop policy if exists intake_sources_tenant on bahi.intake_sources;
create policy intake_sources_tenant on bahi.intake_sources using (
  tenant_id = nullif(current_setting('bahi.tenant_id', true), '')::uuid
);

drop policy if exists oauth_states_tenant on bahi.oauth_states;
create policy oauth_states_tenant on bahi.oauth_states using (
  tenant_id = nullif(current_setting('bahi.tenant_id', true), '')::uuid
);

create or replace function bahi.ensure_gap_schema(p_schema text) returns void
language plpgsql as $$
begin
  if p_schema !~ '^bahi_t_[a-z0-9_]{6,40}$' then
    raise exception 'invalid tenant schema name: %', p_schema;
  end if;
  execute format('create schema if not exists %1$I', p_schema);

  execute format($ddl$
    alter table %1$I.documents add column if not exists source_channel text not null default 'chat';
    alter table %1$I.documents add column if not exists retention_until timestamptz;
    alter table %1$I.documents add column if not exists render_mode text;
    create index if not exists documents_retention_idx on %1$I.documents (retention_until);

    alter table %1$I.records add column if not exists assigned_to uuid references bahi.users(id) on delete set null;
    alter table %1$I.records add column if not exists due_at timestamptz;
    alter table %1$I.records add column if not exists review_reason text;
    alter table %1$I.records add column if not exists locations jsonb not null default '{}'::jsonb;
    alter table %1$I.records add column if not exists evidence jsonb not null default '{}'::jsonb;
    alter table %1$I.records add column if not exists shadow boolean not null default false;
    alter table %1$I.records add column if not exists source_channel text not null default 'chat';
    alter table %1$I.records add column if not exists review_requested_at timestamptz;
    create index if not exists records_assigned_idx on %1$I.records (assigned_to, status);
    create index if not exists records_due_idx on %1$I.records (due_at) where due_at is not null;

    alter table %1$I.posts drop constraint if exists posts_status_check;
    alter table %1$I.posts add constraint posts_status_check
      check (status in ('pending', 'queued', 'posted', 'failed'));
    alter table %1$I.posts add column if not exists bridge_command_id uuid;
    alter table %1$I.posts add column if not exists reversed_at timestamptz;
    alter table %1$I.posts add column if not exists reversal_ref text;

    alter table %1$I.sheet_connections add column if not exists spreadsheet_id text;
    alter table %1$I.sheet_connections add column if not exists spreadsheet_url text;
    alter table %1$I.sheet_connections add column if not exists refresh_token_enc text;
    alter table %1$I.sheet_connections add column if not exists access_token_enc text;
    alter table %1$I.sheet_connections add column if not exists token_expires_at timestamptz;
    alter table %1$I.sheet_connections add column if not exists scope text;
    alter table %1$I.sheet_connections add column if not exists last_synced_at timestamptz;

    create table if not exists %1$I.bridge_commands (
      id uuid primary key default gen_random_uuid(),
      agent_id uuid not null references bahi.bridge_agents(id) on delete cascade,
      type text not null,
      idempotency_key text not null,
      payload jsonb not null default '{}'::jsonb,
      status text not null default 'queued'
        check (status in ('queued', 'delivered', 'acked', 'failed', 'expired')),
      attempts integer not null default 0,
      result jsonb,
      error text,
      record_id uuid references %1$I.records(id) on delete set null,
      created_at timestamptz not null default now(),
      delivered_at timestamptz,
      completed_at timestamptz,
      unique (agent_id, idempotency_key)
    );
    create index if not exists bridge_commands_agent_idx on %1$I.bridge_commands (agent_id, status, created_at);
    create index if not exists bridge_commands_record_idx on %1$I.bridge_commands (record_id);

    create table if not exists %1$I.gstr2b_lines (
      id uuid primary key default gen_random_uuid(),
      period text not null,
      supplier_gstin text not null,
      supplier_name text,
      invoice_number text not null,
      invoice_date date,
      taxable_value numeric(14, 2) not null default 0,
      cgst numeric(14, 2) not null default 0,
      sgst numeric(14, 2) not null default 0,
      igst numeric(14, 2) not null default 0,
      total numeric(14, 2) not null default 0,
      itc_status text,
      record_id uuid references %1$I.records(id) on delete set null,
      match_status text not null default 'unmatched'
        check (match_status in ('matched', 'unmatched', 'mismatch', 'missing_in_books')),
      created_at timestamptz not null default now()
    );
    create unique index if not exists gstr2b_line_key on %1$I.gstr2b_lines
      (period, supplier_gstin, invoice_number);
    create index if not exists gstr2b_invoice_idx on %1$I.gstr2b_lines (supplier_gstin, invoice_number);

    create table if not exists %1$I.evaluations (
      id uuid primary key default gen_random_uuid(),
      doc_type text not null,
      source_document_id uuid references %1$I.documents(id) on delete set null,
      expected jsonb not null default '{}'::jsonb,
      predicted jsonb not null default '{}'::jsonb,
      pack_version text,
      field_scores jsonb not null default '{}'::jsonb,
      score numeric(5, 4) not null default 0,
      created_by uuid references bahi.users(id) on delete set null,
      created_at timestamptz not null default now()
    );

    create table if not exists %1$I.autonomy_events (
      id uuid primary key default gen_random_uuid(),
      stage_from integer,
      stage_to integer not null,
      reason text not null,
      metrics jsonb not null default '{}'::jsonb,
      created_by uuid references bahi.users(id) on delete set null,
      created_at timestamptz not null default now()
    );

    create table if not exists %1$I.pack_overrides (
      id uuid primary key default gen_random_uuid(),
      pack_key text not null,
      patch jsonb not null default '{}'::jsonb,
      status text not null default 'confirmed' check (status in ('proposed', 'confirmed', 'retired')),
      created_by uuid references bahi.users(id) on delete set null,
      created_at timestamptz not null default now(),
      unique (pack_key)
    );

    create table if not exists %1$I.review_requests (
      id uuid primary key default gen_random_uuid(),
      record_id uuid not null references %1$I.records(id) on delete cascade,
      kind text not null check (kind in ('document', 'clarification')),
      message text not null,
      status text not null default 'open' check (status in ('open', 'answered', 'cancelled')),
      requested_by uuid references bahi.users(id) on delete set null,
      answered_by uuid references bahi.users(id) on delete set null,
      answer text,
      created_at timestamptz not null default now(),
      answered_at timestamptz
    );
    create index if not exists review_requests_record_idx on %1$I.review_requests (record_id, status);

    create table if not exists %1$I.intake_events (
      id uuid primary key default gen_random_uuid(),
      channel text not null,
      external_id text,
      status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
      detail jsonb not null default '{}'::jsonb,
      document_id uuid references %1$I.documents(id) on delete set null,
      created_at timestamptz not null default now()
    );

    -- Second-layer tenant isolation for requests made with anon/authenticated.
    alter table %1$I.records enable row level security;
    alter table %1$I.documents enable row level security;
    alter table %1$I.posts enable row level security;
    alter table %1$I.activity enable row level security;
    alter table %1$I.corrections enable row level security;
    alter table %1$I.sheet_connections enable row level security;
    alter table %1$I.sheet_rows enable row level security;
    alter table %1$I.bridge_commands enable row level security;
    alter table %1$I.gstr2b_lines enable row level security;
    alter table %1$I.evaluations enable row level security;
    alter table %1$I.autonomy_events enable row level security;
    alter table %1$I.pack_overrides enable row level security;
    alter table %1$I.review_requests enable row level security;
    alter table %1$I.intake_events enable row level security;

    drop policy if exists tenant_boundary on %1$I.records;
    create policy tenant_boundary on %1$I.records
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.documents;
    create policy tenant_boundary on %1$I.documents
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.posts;
    create policy tenant_boundary on %1$I.posts
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.activity;
    create policy tenant_boundary on %1$I.activity
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.corrections;
    create policy tenant_boundary on %1$I.corrections
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.sheet_connections;
    create policy tenant_boundary on %1$I.sheet_connections
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.sheet_rows;
    create policy tenant_boundary on %1$I.sheet_rows
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.bridge_commands;
    create policy tenant_boundary on %1$I.bridge_commands
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.gstr2b_lines;
    create policy tenant_boundary on %1$I.gstr2b_lines
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.evaluations;
    create policy tenant_boundary on %1$I.evaluations
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.autonomy_events;
    create policy tenant_boundary on %1$I.autonomy_events
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.pack_overrides;
    create policy tenant_boundary on %1$I.pack_overrides
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.review_requests;
    create policy tenant_boundary on %1$I.review_requests
      using (current_setting('bahi.tenant_schema', true) = '%1$s');
    drop policy if exists tenant_boundary on %1$I.intake_events;
    create policy tenant_boundary on %1$I.intake_events
      using (current_setting('bahi.tenant_schema', true) = '%1$s');

    revoke all on all tables in schema %1$I from anon, authenticated;
  $ddl$, p_schema);
end $$;

do $$
declare tenant record;
begin
  for tenant in select schema_name from bahi.tenants loop
    perform bahi.ensure_gap_schema(tenant.schema_name);
  end loop;
end $$;
