-- Bahi — initial schema (isolated from earlier experiments in this project)
--
-- bahi                          control plane: tenants, users, memberships, sessions
-- bahi_t_<tenant>               one schema per tenant, created by create_tenant_schema()
--
-- The app connects with the Postgres role from DATABASE_URL and always selects
-- the tenant schema from the signed server session, never from browser input.

create schema if not exists bahi;
create extension if not exists pgcrypto;

create table if not exists bahi.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  schema_name text not null unique,
  status text not null default 'active' check (status in ('active', 'suspended')),
  autonomy_mode text not null default 'draft' check (autonomy_mode in ('draft', 'autonomous')),
  kill_switch boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bahi.users (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid not null unique,
  email text not null unique,
  name text,
  created_at timestamptz not null default now()
);

create table if not exists bahi.memberships (
  tenant_id uuid not null references bahi.tenants(id) on delete cascade,
  user_id uuid not null references bahi.users(id) on delete cascade,
  role text not null check (role in ('owner', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table if not exists bahi.sessions (
  token_hash text primary key,
  user_id uuid not null references bahi.users(id) on delete cascade,
  tenant_id uuid not null references bahi.tenants(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_expires_idx on bahi.sessions (expires_at);

create or replace function bahi.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tenants_updated on bahi.tenants;
create trigger tenants_updated before update on bahi.tenants
  for each row execute function bahi.set_updated_at();

-- Creates one isolated schema for a tenant. Called once at onboarding.
create or replace function bahi.create_tenant_schema(p_schema text) returns void
language plpgsql as $$
begin
  if p_schema !~ '^bahi_t_[a-z0-9_]{6,40}$' then
    raise exception 'invalid tenant schema name: %', p_schema;
  end if;
  execute format('create schema if not exists %1$I', p_schema);

  execute format($ddl$
    create table if not exists %1$I.chats (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references bahi.users(id) on delete cascade,
      title text not null default 'New conversation',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists chats_updated_idx on %1$I.chats (updated_at desc);

    create table if not exists %1$I.messages (
      id uuid primary key default gen_random_uuid(),
      chat_id uuid not null references %1$I.chats(id) on delete cascade,
      role text not null check (role in ('user', 'assistant', 'system')),
      content text not null,
      meta jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create index if not exists messages_chat_idx on %1$I.messages (chat_id, created_at);

    create table if not exists %1$I.documents (
      id uuid primary key default gen_random_uuid(),
      chat_id uuid references %1$I.chats(id) on delete set null,
      user_id uuid not null references bahi.users(id),
      filename text not null,
      mime_type text not null,
      size_bytes integer not null default 0,
      storage_path text,
      sha256 text,
      status text not null default 'queued'
        check (status in ('queued', 'processing', 'extracted', 'needs_attention', 'failed')),
      doc_type text,
      page_count integer,
      extracted_text text,
      error text,
      created_at timestamptz not null default now()
    );
    create index if not exists documents_hash_idx on %1$I.documents (sha256);
    create index if not exists documents_status_idx on %1$I.documents (status, created_at desc);

    create table if not exists %1$I.records (
      id uuid primary key default gen_random_uuid(),
      chat_id uuid references %1$I.chats(id) on delete set null,
      message_id uuid references %1$I.messages(id) on delete set null,
      document_id uuid references %1$I.documents(id) on delete cascade,
      doc_type text not null,
      title text not null,
      fields jsonb not null default '{}'::jsonb,
      confidences jsonb not null default '{}'::jsonb,
      validation jsonb not null default '[]'::jsonb,
      overall_confidence numeric(4, 3) not null default 0,
      status text not null default 'pending_review'
        check (status in ('pending_review', 'approved', 'posted', 'written', 'rejected', 'held', 'failed')),
      destination text not null default 'tally'
        check (destination in ('tally', 'excel', 'google_sheets')),
      destination_ref text,
      destination_note text,
      reason text,
      priority integer not null default 100,
      amount_minor bigint not null default 0,
      idempotency_key text not null unique,
      group_key text,
      posted_at timestamptz,
      reviewed_at timestamptz,
      reviewed_by uuid references bahi.users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists records_queue_idx on %1$I.records (status, priority, created_at);
    create index if not exists records_chat_idx on %1$I.records (chat_id, created_at);
    create index if not exists records_vendor_idx on %1$I.records ((fields ->> 'vendor_gstin'));
    create index if not exists records_invoice_idx on %1$I.records ((fields ->> 'invoice_number'));

    create table if not exists %1$I.posts (
      id uuid primary key default gen_random_uuid(),
      record_id uuid not null references %1$I.records(id) on delete cascade,
      destination text not null,
      idempotency_key text not null,
      status text not null default 'pending'
        check (status in ('pending', 'posted', 'failed')),
      payload jsonb,
      result jsonb,
      external_ref text,
      created_at timestamptz not null default now(),
      completed_at timestamptz,
      unique (destination, idempotency_key)
    );
    create index if not exists posts_record_idx on %1$I.posts (record_id);

    create table if not exists %1$I.activity (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references bahi.users(id),
      record_id uuid references %1$I.records(id) on delete set null,
      action text not null,
      detail jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create index if not exists activity_created_idx on %1$I.activity (created_at desc);

    create table if not exists %1$I.corrections (
      id uuid primary key default gen_random_uuid(),
      record_id uuid references %1$I.records(id) on delete set null,
      document_id uuid references %1$I.documents(id) on delete set null,
      doc_type text,
      vendor_key text,
      field text not null,
      old_value text,
      new_value text,
      one_off boolean not null default false,
      user_id uuid references bahi.users(id),
      created_at timestamptz not null default now()
    );
    create index if not exists corrections_vendor_idx on %1$I.corrections (vendor_key, field);

    create table if not exists %1$I.sheet_connections (
      id uuid primary key default gen_random_uuid(),
      provider text not null check (provider in ('google_sheets')),
      label text not null,
      spreadsheet_name text not null,
      sheet_name text not null default 'Entries',
      status text not null default 'connected' check (status in ('connected', 'revoked')),
      settings jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists %1$I.sheet_rows (
      id uuid primary key default gen_random_uuid(),
      connection_id uuid not null references %1$I.sheet_connections(id) on delete cascade,
      record_id uuid not null references %1$I.records(id) on delete cascade,
      row_number integer not null,
      values jsonb not null,
      created_at timestamptz not null default now(),
      unique (connection_id, record_id)
    );

    drop trigger if exists records_updated on %1$I.records;
    create trigger records_updated before update on %1$I.records
      for each row execute function bahi.set_updated_at();
    drop trigger if exists chats_updated on %1$I.chats;
    create trigger chats_updated before update on %1$I.chats
      for each row execute function bahi.set_updated_at();

    alter table %1$I.chats enable row level security;
    alter table %1$I.messages enable row level security;
    alter table %1$I.documents enable row level security;
    alter table %1$I.records enable row level security;
    alter table %1$I.posts enable row level security;
    alter table %1$I.activity enable row level security;
    alter table %1$I.corrections enable row level security;
    alter table %1$I.sheet_connections enable row level security;
    alter table %1$I.sheet_rows enable row level security;

    revoke all on all tables in schema %1$I from anon, authenticated;
  $ddl$, p_schema);
end $$;

alter table bahi.tenants enable row level security;
alter table bahi.users enable row level security;
alter table bahi.memberships enable row level security;
alter table bahi.sessions enable row level security;
revoke all on table bahi.tenants from anon, authenticated;
revoke all on table bahi.users from anon, authenticated;
revoke all on table bahi.memberships from anon, authenticated;
revoke all on table bahi.sessions from anon, authenticated;

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;
