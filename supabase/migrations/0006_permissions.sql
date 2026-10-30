-- Bahi — three permission levels (build spec 6b)
--
-- Stores the level that was active when a document run started and when a
-- write was approved, so every record and audit entry can say under which
-- level it was handled. Workspaces without an explicit setting inherit one
-- from their autonomy mode. Every statement is idempotent.

create or replace function bahi.ensure_permission_schema(p_schema text) returns void
language plpgsql as $$
begin
  if p_schema !~ '^bahi_t_[a-z0-9_]{6,40}$' then
    raise exception 'invalid tenant schema name: %', p_schema;
  end if;
  execute format('create schema if not exists %1$I', p_schema);

  execute format($ddl$
    alter table %1$I.documents add column if not exists permission_level text;
    alter table %1$I.documents drop constraint if exists documents_permission_level_check;
    alter table %1$I.documents add constraint documents_permission_level_check
      check (permission_level is null or permission_level in ('ask', 'auto', 'full'));

    alter table %1$I.records add column if not exists permission_level text;
    alter table %1$I.records add column if not exists approved_permission_level text;
    alter table %1$I.records drop constraint if exists records_permission_level_check;
    alter table %1$I.records add constraint records_permission_level_check
      check (permission_level is null or permission_level in ('ask', 'auto', 'full'));
    alter table %1$I.records drop constraint if exists records_approved_permission_level_check;
    alter table %1$I.records add constraint records_approved_permission_level_check
      check (approved_permission_level is null or approved_permission_level in ('ask', 'auto', 'full'));
  $ddl$, p_schema);
end $$;

do $$
declare tenant record;
begin
  for tenant in select schema_name from bahi.tenants loop
    perform bahi.ensure_permission_schema(tenant.schema_name);
  end loop;
end $$;

update bahi.tenants
   set settings = settings || jsonb_build_object(
     'permissions',
     jsonb_build_object(
       'level', case when autonomy_mode = 'draft' then 'ask' else 'auto' end,
       'ceilingMinor', 0
     )
   )
 where not (settings ? 'permissions');
