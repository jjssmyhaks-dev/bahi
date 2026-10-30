-- Bahi — agent tool calls
--
-- Every tool call is recorded per tenant with its duration, status, error code
-- and a short summary. Full tool arguments and results that contain document
-- text are never stored; this table is for audit and idempotency only.

create or replace function bahi.ensure_tool_schema(p_schema text) returns void
language plpgsql as $$
begin
  if p_schema !~ '^bahi_t_[a-z0-9_]{6,40}$' then
    raise exception 'invalid tenant schema name: %', p_schema;
  end if;
  execute format('create schema if not exists %1$I', p_schema);

  execute format($ddl$
    create table if not exists %1$I.tool_calls (
      id uuid primary key default gen_random_uuid(),
      run_id uuid,
      user_id uuid references bahi.users(id) on delete set null,
      chat_id uuid references %1$I.chats(id) on delete set null,
      document_id uuid references %1$I.documents(id) on delete set null,
      record_id uuid references %1$I.records(id) on delete set null,
      agent text not null,
      tool text not null,
      kind text not null check (kind in ('read', 'write')),
      status text not null check (status in ('ok', 'error')),
      error_code text,
      summary text,
      idempotency_key text,
      duration_ms integer not null default 0,
      result jsonb,
      created_at timestamptz not null default now()
    );
    create index if not exists tool_calls_created_idx on %1$I.tool_calls (created_at desc);
    create index if not exists tool_calls_run_idx on %1$I.tool_calls (run_id);
    create unique index if not exists tool_calls_idempotency_idx
      on %1$I.tool_calls (tool, idempotency_key)
      where idempotency_key is not null and status = 'ok';

    alter table %1$I.corrections add column if not exists one_off boolean not null default false;

    alter table %1$I.tool_calls enable row level security;
    revoke all on %1$I.tool_calls from anon, authenticated;
  $ddl$, p_schema);
end $$;

do $$
declare tenant record;
begin
  for tenant in select schema_name from bahi.tenants loop
    perform bahi.ensure_tool_schema(tenant.schema_name);
  end loop;
end $$;
