-- Bahi — agent layer
--
-- Every tenant schema gets its own agent ledger: runs, extractions, segments,
-- match decisions, mappings, rule proposals and embeddings. The app still never
-- sends a tenant id from the browser; the schema comes from the signed session.

create extension if not exists vector;

create or replace function bahi.ensure_agent_schema(p_schema text) returns void
language plpgsql as $$
begin
  if p_schema !~ '^bahi_t_[a-z0-9_]{6,40}$' then
    raise exception 'invalid tenant schema name: %', p_schema;
  end if;
  execute format('create schema if not exists %1$I', p_schema);

  execute format($ddl$
    create table if not exists %1$I.agent_runs (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references bahi.users(id) on delete set null,
      chat_id uuid references %1$I.chats(id) on delete set null,
      document_id uuid references %1$I.documents(id) on delete set null,
      record_id uuid references %1$I.records(id) on delete set null,
      agent text not null,
      prompt_version text not null,
      model text,
      mode text not null default 'deterministic' check (mode in ('deterministic', 'model')),
      status text not null default 'success' check (status in ('success', 'retried', 'failed')),
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      cost_usd numeric(12, 6) not null default 0,
      latency_ms integer not null default 0,
      trace_id text,
      error text,
      created_at timestamptz not null default now()
    );
    create index if not exists agent_runs_created_idx on %1$I.agent_runs (created_at desc);
    create index if not exists agent_runs_agent_idx on %1$I.agent_runs (agent, created_at desc);

    create table if not exists %1$I.document_segments (
      id uuid primary key default gen_random_uuid(),
      document_id uuid not null references %1$I.documents(id) on delete cascade,
      segment_index integer not null,
      page_start integer,
      page_end integer,
      doc_type text,
      confidence numeric(4, 3) not null default 0,
      quality jsonb not null default '{}'::jsonb,
      status text not null default 'pending'
        check (status in ('pending', 'extracted', 'unknown', 'failed')),
      created_at timestamptz not null default now(),
      unique (document_id, segment_index)
    );

    create table if not exists %1$I.extractions (
      id uuid primary key default gen_random_uuid(),
      document_id uuid not null references %1$I.documents(id) on delete cascade,
      segment_index integer not null default 0,
      doc_type text,
      pack_version text,
      sha256 text,
      page_start integer,
      page_end integer,
      fields jsonb not null default '{}'::jsonb,
      confidences jsonb not null default '{}'::jsonb,
      locations jsonb not null default '{}'::jsonb,
      envelope jsonb not null default '{}'::jsonb,
      agent_run_id uuid,
      created_at timestamptz not null default now(),
      unique (document_id, segment_index, pack_version)
    );

    create table if not exists %1$I.match_decisions (
      id uuid primary key default gen_random_uuid(),
      record_id uuid references %1$I.records(id) on delete cascade,
      kind text not null check (kind in ('vendor', 'ledger', 'item')),
      input jsonb not null default '{}'::jsonb,
      chosen jsonb,
      alternatives jsonb not null default '[]'::jsonb,
      confidence numeric(4, 3),
      reason text,
      human_choice jsonb,
      status text not null default 'suggested'
        check (status in ('suggested', 'accepted', 'rejected', 'new_party')),
      agent_run_id uuid,
      created_at timestamptz not null default now()
    );
    create index if not exists match_decisions_record_idx on %1$I.match_decisions (record_id);

    create table if not exists %1$I.mappings (
      id uuid primary key default gen_random_uuid(),
      kind text not null check (kind in ('sheet_columns', 'vendor_ledger', 'field_default')),
      scope_key text not null,
      mapping jsonb not null default '{}'::jsonb,
      status text not null default 'proposed' check (status in ('proposed', 'confirmed')),
      evidence_count integer not null default 1,
      source text,
      confirmed_by uuid references bahi.users(id) on delete set null,
      confirmed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (kind, scope_key)
    );

    create table if not exists %1$I.rule_proposals (
      id uuid primary key default gen_random_uuid(),
      rule jsonb not null default '{}'::jsonb,
      evidence_count integer not null default 0,
      example text,
      status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'ignored')),
      reviewed_by uuid references bahi.users(id) on delete set null,
      reviewed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists %1$I.masters (
      id uuid primary key default gen_random_uuid(),
      kind text not null check (kind in ('vendor', 'ledger', 'item')),
      name text not null,
      gstin text,
      ledger text,
      data jsonb not null default '{}'::jsonb,
      source text,
      created_at timestamptz not null default now(),
      unique (kind, name)
    );
    create index if not exists masters_gstin_idx on %1$I.masters (gstin);

    create table if not exists %1$I.embeddings (
      id uuid primary key default gen_random_uuid(),
      subject_type text not null,
      subject_id uuid not null,
      content_hash text not null,
      embedding vector(256) not null,
      model text,
      created_at timestamptz not null default now(),
      unique (subject_type, subject_id)
    );

    alter table %1$I.records add column if not exists envelope jsonb not null default '{}'::jsonb;
    alter table %1$I.records add column if not exists agent_mode text;
    alter table %1$I.corrections add column if not exists reason text;

    drop trigger if exists mappings_updated on %1$I.mappings;
    create trigger mappings_updated before update on %1$I.mappings
      for each row execute function bahi.set_updated_at();
    drop trigger if exists rule_proposals_updated on %1$I.rule_proposals;
    create trigger rule_proposals_updated before update on %1$I.rule_proposals
      for each row execute function bahi.set_updated_at();

    insert into %1$I.masters (kind, name, ledger, source)
    values
      ('ledger', 'Bank Charges', 'Bank Charges', 'standard'),
      ('ledger', 'Interest Income', 'Interest Income', 'standard'),
      ('ledger', 'Purchases', 'Purchases', 'standard'),
      ('ledger', 'Sales', 'Sales', 'standard'),
      ('ledger', 'Suspense', 'Suspense', 'standard')
    on conflict (kind, name) do nothing;

    insert into %1$I.masters (kind, name, gstin, ledger, source)
    select 'vendor', fields ->> 'vendor_name', fields ->> 'vendor_gstin',
           fields ->> 'vendor_name', 'history'
      from %1$I.records
     where coalesce(fields ->> 'vendor_name', '') <> ''
       and coalesce(fields ->> 'vendor_gstin', '') <> ''
     group by 2, 3, 4
    on conflict (kind, name) do nothing;

    insert into %1$I.mappings (kind, scope_key, mapping, status, source, confirmed_at)
    select 'sheet_columns', c.id::text, $mapping${"columns":[{"column":"Date","field":"invoice_date"},{"column":"Document type","field":"doc_type"},{"column":"Vendor / narration","field":"party"},{"column":"GSTIN","field":"vendor_gstin"},{"column":"Document no.","field":"invoice_number"},{"column":"Taxable value","field":"taxable_value"},{"column":"CGST","field":"cgst"},{"column":"SGST","field":"sgst"},{"column":"IGST","field":"igst"},{"column":"Total","field":"total"},{"column":"Source","field":"source"}]}$mapping$::jsonb,
           'confirmed', 'standard_template', now()
      from %1$I.sheet_connections c
    on conflict (kind, scope_key) do nothing;

    alter table %1$I.agent_runs enable row level security;
    alter table %1$I.document_segments enable row level security;
    alter table %1$I.extractions enable row level security;
    alter table %1$I.match_decisions enable row level security;
    alter table %1$I.mappings enable row level security;
    alter table %1$I.rule_proposals enable row level security;
    alter table %1$I.masters enable row level security;
    alter table %1$I.embeddings enable row level security;

    revoke all on all tables in schema %1$I from anon, authenticated;
  $ddl$, p_schema);
end $$;

do $$
declare tenant record;
begin
  for tenant in select schema_name from bahi.tenants loop
    perform bahi.ensure_agent_schema(tenant.schema_name);
  end loop;
end $$;
