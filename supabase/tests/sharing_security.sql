-- Read-only catalog assertions for Sharing v1 grants and RLS boundaries.
-- Run with a migration-capable database role after the sharing migration.
do $$
declare
  select_policy text;
  insert_policy text;
  update_policy text;
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'content'
      and c.relname = 'max_shares'
      and c.relrowsecurity
  ) then
    raise exception 'Sharing rows must have row-level security enabled';
  end if;

  select qual into select_policy
  from pg_policies
  where schemaname = 'content'
    and tablename = 'max_shares'
    and policyname = 'users read their own shares'
    and cmd = 'SELECT';
  if select_policy is null
     or position('auth.uid' in select_policy) = 0
     or position('owner_id' in select_policy) = 0 then
    raise exception 'Share reads must be restricted to the authenticated owner';
  end if;

  select with_check into insert_policy
  from pg_policies
  where schemaname = 'content'
    and tablename = 'max_shares'
    and policyname = 'users create their own shares'
    and cmd = 'INSERT';
  if insert_policy is null
     or position('auth.uid' in insert_policy) = 0
     or position('owner_id' in insert_policy) = 0 then
    raise exception 'Share inserts must be restricted to the authenticated owner';
  end if;

  select qual || ' ' || with_check into update_policy
  from pg_policies
  where schemaname = 'content'
    and tablename = 'max_shares'
    and policyname = 'users revoke their own shares'
    and cmd = 'UPDATE';
  if update_policy is null
     or position('auth.uid' in update_policy) = 0
     or position('owner_id' in update_policy) = 0
     or position('revoked_at' in update_policy) = 0 then
    raise exception 'Share revocation must be owner-only and non-reversible';
  end if;

  if has_table_privilege('anon', 'content.max_shares', 'SELECT')
     or has_table_privilege('anon', 'content.max_shares', 'INSERT')
     or has_table_privilege('anon', 'content.max_shares', 'UPDATE')
     or has_table_privilege('anon', 'content.max_shares', 'DELETE') then
    raise exception 'Anonymous clients must not access the share table directly';
  end if;

  if has_column_privilege('authenticated', 'content.max_shares', 'token_hash', 'SELECT')
     or has_table_privilege('authenticated', 'content.max_shares', 'DELETE')
     or has_column_privilege('authenticated', 'content.max_shares', 'owner_id', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_shares', 'resource_id', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_shares', 'token_hash', 'UPDATE')
     or has_column_privilege('authenticated', 'content.max_shares', 'expires_at', 'UPDATE') then
    raise exception 'Authenticated clients must not read token hashes or alter share identity';
  end if;

  if not has_table_privilege('service_role', 'content.max_shares', 'UPDATE')
     or not has_column_privilege('authenticated', 'content.max_shares', 'revoked_at', 'UPDATE') then
    raise exception 'Share resolution/revocation grants are incomplete';
  end if;
end;
$$;
