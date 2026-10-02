create table content.max_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  resource_type text not null check (resource_type in ('research_session', 'published_post')),
  resource_id text not null check (char_length(resource_id) between 1 and 200),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '90 days'),
  check (revoked_at is null or revoked_at >= created_at),
  check (last_accessed_at is null or last_accessed_at >= created_at)
);

create index max_shares_owner_created_idx
  on content.max_shares (owner_id, created_at desc);
create index max_shares_resource_idx
  on content.max_shares (owner_id, resource_type, resource_id);

alter table content.max_shares enable row level security;

revoke all on content.max_shares from public, anon, authenticated, service_role;
grant usage on schema content to authenticated, service_role;
grant select (
  id, owner_id, resource_type, resource_id, created_at, expires_at, revoked_at, last_accessed_at
) on content.max_shares to authenticated;
grant insert (
  id, owner_id, resource_type, resource_id, token_hash, expires_at
) on content.max_shares to authenticated;
grant update (revoked_at) on content.max_shares to authenticated;
grant select, insert, update, delete on content.max_shares to service_role;

create policy "users read their own shares"
  on content.max_shares
  for select
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  );

create policy "users create their own shares"
  on content.max_shares
  for insert
  to authenticated
  with check (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  );

create policy "users revoke their own shares"
  on content.max_shares
  for update
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
    and revoked_at is null
  )
  with check (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
    and revoked_at is not null
  );
