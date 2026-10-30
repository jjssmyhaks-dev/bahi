-- Bahi — Excel template destination and supporting metadata
--
-- A workspace can keep one or more uploaded .xlsx templates. The newest one is
-- used when a record or queue is exported, so the workbook keeps the client's
-- own headings, widths and formatting. Every statement is idempotent.

create or replace function bahi.ensure_excel_schema(p_schema text) returns void
language plpgsql as $$
begin
  if p_schema !~ '^bahi_t_[a-z0-9_]{6,40}$' then
    raise exception 'invalid tenant schema name: %', p_schema;
  end if;
  execute format('create schema if not exists %1$I', p_schema);

  execute format($ddl$
    create table if not exists %1$I.excel_templates (
      id uuid primary key default gen_random_uuid(),
      filename text not null,
      storage_path text not null,
      sheet_name text not null,
      header_row integer not null default 1,
      mapping jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create index if not exists excel_templates_created_idx on %1$I.excel_templates (created_at desc);

    alter table %1$I.excel_templates enable row level security;
    drop policy if exists tenant_boundary on %1$I.excel_templates;
    create policy tenant_boundary on %1$I.excel_templates
      using (current_setting('bahi.tenant_schema', true) = '%1$s');

    revoke all on %1$I.excel_templates from anon, authenticated;
  $ddl$, p_schema);
end $$;

do $$
declare tenant record;
begin
  for tenant in select schema_name from bahi.tenants loop
    perform bahi.ensure_excel_schema(tenant.schema_name);
  end loop;
end $$;
