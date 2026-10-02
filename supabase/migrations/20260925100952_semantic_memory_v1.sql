-- Private, owner-scoped semantic memories for MAX; version matches Signova's applied migration.
-- Keep the vector extension in Supabase's managed extensions schema.
create extension if not exists vector with schema extensions;

create table research.max_user_memories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  category text not null check (category in ('preference', 'fact', 'project', 'goal', 'workflow')),
  content text not null check (char_length(btrim(content)) between 8 and 2000),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  source_type text not null check (source_type in ('explicit_chat', 'explicit_api')),
  source_ref text check (source_ref is null or char_length(source_ref) <= 128),
  provenance jsonb not null default '[]'::jsonb
    check (jsonb_typeof(provenance) = 'array' and jsonb_array_length(provenance) between 1 and 8),
  confidence real not null default 1.0 check (confidence between 0.0 and 1.0),
  importance real not null default 0.5 check (importance between 0.0 and 1.0),
  embedding extensions.vector(1536) not null,
  embedding_model text not null check (char_length(embedding_model) between 1 and 120),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, content_hash)
);

-- Exact vector scans remain appropriate for the small, owner-scoped v1 corpus.
-- Add an approximate vector index only after measured scale warrants it.
create index max_user_memories_owner_active_updated_idx
  on research.max_user_memories (owner_id, is_active, updated_at desc);

alter table research.max_user_memories enable row level security;

revoke all on research.max_user_memories from public, anon, service_role;
grant select, insert, update, delete on research.max_user_memories to authenticated;

create policy "users manage their own semantic memories"
  on research.max_user_memories
  for all
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  )
  with check (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  );

-- Keep the per-user ceiling true even when a client writes directly through
-- the Data API or concurrent requests race the application-level pre-count.
create or replace function research.enforce_user_memory_active_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  active_count integer;
begin
  if new.owner_id is distinct from (select auth.uid())
    or (select auth.jwt() ->> 'is_anonymous') is not distinct from 'true' then
    raise exception using errcode = '42501', message = 'memory owner must be the authenticated user';
  end if;

  if new.is_active then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.owner_id::text, 0)
    );
    select count(*)
      into active_count
      from research.max_user_memories as memory
      where memory.owner_id = new.owner_id
        and memory.is_active
        and memory.id is distinct from new.id;
    if active_count >= 500 then
      raise exception using errcode = '54000', message = 'active user memory limit reached';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function research.enforce_user_memory_active_limit() from public, anon, authenticated;

create trigger max_user_memories_enforce_active_limit
  before insert or update of owner_id, is_active
  on research.max_user_memories
  for each row
  execute function research.enforce_user_memory_active_limit();

create or replace function research.max_match_user_memories(
  p_query_embedding extensions.vector(1536),
  p_embedding_model text,
  p_min_similarity real,
  p_candidate_limit integer,
  p_match_count integer
)
returns table (
  id uuid,
  category text,
  content text,
  source_type text,
  source_ref text,
  provenance jsonb,
  confidence real,
  importance real,
  created_at timestamptz,
  updated_at timestamptz,
  similarity real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with candidates as (
    select
      memory.id,
      memory.category,
      memory.content,
      memory.source_type,
      memory.source_ref,
      memory.provenance,
      memory.confidence,
      memory.importance,
      memory.created_at,
      memory.updated_at,
      memory.embedding OPERATOR(extensions.<=>) p_query_embedding as distance
    from research.max_user_memories as memory
    where memory.owner_id = (select auth.uid())
      and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
      and memory.is_active
      and memory.embedding_model = p_embedding_model
      and memory.confidence >= 0.5
    order by
      memory.embedding OPERATOR(extensions.<=>) p_query_embedding,
      memory.importance desc,
      memory.updated_at desc
    limit least(greatest(coalesce(p_candidate_limit, 50), 1), 100)
  )
  select
    candidates.id,
    candidates.category,
    candidates.content,
    candidates.source_type,
    candidates.source_ref,
    candidates.provenance,
    candidates.confidence,
    candidates.importance,
    candidates.created_at,
    candidates.updated_at,
    (1.0 - candidates.distance)::real as similarity
  from candidates
  where (1.0 - candidates.distance) >= greatest(0.0, least(coalesce(p_min_similarity, 0.45), 1.0))
  order by candidates.distance, candidates.importance desc, candidates.updated_at desc
  limit least(greatest(coalesce(p_match_count, 5), 1), 8)
$$;

revoke all on function research.max_match_user_memories(
  extensions.vector, text, real, integer, integer
) from public, anon;
grant execute on function research.max_match_user_memories(
  extensions.vector, text, real, integer, integer
) to authenticated;
