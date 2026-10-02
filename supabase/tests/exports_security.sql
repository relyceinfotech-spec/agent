-- Read-only catalog assertions for Exports v1 grants and RLS boundaries.
-- Run with a migration-capable database role after the exports migration.
do $$
declare
  select_policy text;
  insert_policy text;
  update_policy text;
  delete_policy text;
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'content'
      and c.relname = 'max_exports'
      and c.relrowsecurity
  ) then
    raise exception 'Export rows must have row-level security enabled';
  end if;

  select qual into select_policy
  from pg_policies
  where schemaname = 'content'
    and tablename = 'max_exports'
    and policyname = 'users read their own exports'
    and cmd = 'SELECT';
  if select_policy is null
     or position('auth.uid' in select_policy) = 0
     or position('owner_id' in select_policy) = 0 then
    raise exception 'Export reads must be restricted to the authenticated owner';
  end if;

  select with_check into insert_policy
  from pg_policies
  where schemaname = 'content'
    and tablename = 'max_exports'
    and policyname = 'users create their own pending exports'
    and cmd = 'INSERT';
  if insert_policy is null
     or position('auth.uid' in insert_policy) = 0
     or position('owner_id' in insert_policy) = 0
     or position('pending' in insert_policy) = 0 then
    raise exception 'Export inserts must be owner-only and pending';
  end if;

  select qual || ' ' || with_check into update_policy
  from pg_policies
  where schemaname = 'content'
    and tablename = 'max_exports'
    and policyname = 'users complete or fail their own exports'
    and cmd = 'UPDATE';
  if update_policy is null
     or position('auth.uid' in update_policy) = 0
     or position('owner_id' in update_policy) = 0
     or position('status' in update_policy) = 0 then
    raise exception 'Export state transitions must remain owner-scoped';
  end if;

  select qual into delete_policy
  from pg_policies
  where schemaname = 'content'
    and tablename = 'max_exports'
    and policyname = 'users delete their own exports'
    and cmd = 'DELETE';
  if delete_policy is null
     or position('auth.uid' in delete_policy) = 0
     or position('owner_id' in delete_policy) = 0 then
    raise exception 'Export deletion must be restricted to the authenticated owner';
  end if;

  if has_table_privilege('anon', 'content.max_exports', 'SELECT')
     or has_table_privilege('anon', 'content.max_exports', 'INSERT')
     or has_table_privilege('anon', 'content.max_exports', 'UPDATE')
     or has_table_privilege('anon', 'content.max_exports', 'DELETE') then
    raise exception 'Anonymous clients must not access export rows directly';
  end if;

  if has_column_privilege('authenticated', 'content.max_exports', 'owner_id', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_exports', 'resource_type', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_exports', 'resource_id', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_exports', 'format', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_exports', 'snapshot_hash', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_exports', 'file_name', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_exports', 'content_type', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_exports', 'failure_reason', 'SELECT') then
    raise exception 'Export snapshot identity or internal failure-reason grants are too broad';
  end if;

  if not has_column_privilege('authenticated', 'content.max_exports', 'payload_base64', 'SELECT')
     or not has_column_privilege('authenticated', 'content.max_exports', 'payload_base64', 'UPDATE')
     or not has_table_privilege('authenticated', 'content.max_exports', 'DELETE')
     or not has_table_privilege('service_role', 'content.max_exports', 'UPDATE') then
    raise exception 'Required owner-scoped download, lifecycle, or service grants are missing';
  end if;
end;
$$;
