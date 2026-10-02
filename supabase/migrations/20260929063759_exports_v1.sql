create table content.max_exports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  resource_type text not null check (resource_type in ('research_session', 'published_post')),
  resource_id text not null check (char_length(resource_id) between 1 and 200),
  format text not null check (format in ('markdown', 'json', 'pdf')),
  status text not null check (status in ('pending', 'completed', 'failed')),
  snapshot_hash text not null check (snapshot_hash ~ '^[a-f0-9]{64}$'),
  file_name text not null check (file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,91}\.(md|json|pdf)$'),
  content_type text not null check (content_type in (
    'text/markdown; charset=utf-8',
    'application/json; charset=utf-8',
    'application/pdf'
  )),
  attempts integer not null default 1 check (attempts between 1 and 3),
  payload_base64 text,
  output_bytes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_reason text,
  unique (owner_id, resource_type, resource_id, format, snapshot_hash),
  check (
    (status = 'completed'
      and payload_base64 is not null
      and char_length(payload_base64) <= 2666668
      and output_bytes between 1 and 2000000
      and completed_at is not null
      and failure_reason is null)
    or (status = 'pending'
      and payload_base64 is null
      and output_bytes is null
      and completed_at is null
      and failure_reason is null)
    or (status = 'failed'
      and payload_base64 is null
      and output_bytes is null
      and completed_at is null
      and failure_reason ~ '^[a-z0-9_:-]{1,80}$')
  ),
  check (completed_at is null or completed_at >= created_at),
  check (updated_at >= created_at)
);

create index max_exports_owner_created_idx
  on content.max_exports (owner_id, created_at desc);
create index max_exports_resource_snapshot_idx
  on content.max_exports (owner_id, resource_type, resource_id, format, snapshot_hash);

alter table content.max_exports enable row level security;

revoke all on content.max_exports from public, anon, authenticated, service_role;
grant usage on schema content to authenticated, service_role;
grant select (
  id, owner_id, resource_type, resource_id, format, status, snapshot_hash, file_name,
  content_type, attempts, payload_base64, output_bytes, created_at, updated_at,
  completed_at
) on content.max_exports to authenticated;
grant insert (
  id, owner_id, resource_type, resource_id, format, status, snapshot_hash, file_name,
  content_type, attempts, created_at, updated_at
) on content.max_exports to authenticated;
grant update (
  status, attempts, payload_base64, output_bytes, updated_at, completed_at, failure_reason
) on content.max_exports to authenticated;
grant delete on content.max_exports to authenticated;
grant select, insert, update, delete on content.max_exports to service_role;

create policy "users read their own exports"
  on content.max_exports
  for select
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  );

create policy "users create their own pending exports"
  on content.max_exports
  for insert
  to authenticated
  with check (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
    and status = 'pending'
    and payload_base64 is null
    and output_bytes is null
    and completed_at is null
    and failure_reason is null
    and attempts = 1
  );

create policy "users complete or fail their own exports"
  on content.max_exports
  for update
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
    and status in ('pending', 'failed')
  )
  with check (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
    and status in ('pending', 'completed', 'failed')
  );

create policy "users delete their own exports"
  on content.max_exports
  for delete
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  );
