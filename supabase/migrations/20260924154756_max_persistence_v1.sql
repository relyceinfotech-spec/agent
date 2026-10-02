-- MAX-owned persistence schema for the inspected Signova project.
-- Public Data API roles are denied; the Fastify backend uses service_role.

create table public.max_research_sessions (
  id text primary key,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  status text not null,
  data jsonb not null
);

create index max_research_sessions_created_at_idx
  on public.max_research_sessions (created_at desc);
create index max_research_sessions_status_idx
  on public.max_research_sessions (status);

create table public.max_knowledge_documents (
  url text primary key,
  title text not null,
  content text not null,
  raw_html text not null,
  fetched_at timestamptz not null,
  last_verified_at timestamptz not null,
  published_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  content_hash text not null,
  version integer not null check (version > 0),
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) stored
);

create index max_knowledge_documents_search_idx
  on public.max_knowledge_documents using gin (search_vector);
create index max_knowledge_documents_last_verified_idx
  on public.max_knowledge_documents (last_verified_at desc);

create table public.max_topics (
  id text primary key,
  url text not null unique,
  status text not null,
  score double precision not null,
  discovered_at timestamptz not null,
  data jsonb not null
);

create index max_topics_discovered_at_idx
  on public.max_topics (discovered_at desc);

create table public.max_autonomous_runs (
  id text primary key,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null
);

create index max_autonomous_runs_created_at_idx
  on public.max_autonomous_runs (created_at desc);
create index max_autonomous_runs_status_idx
  on public.max_autonomous_runs (status);

create table public.max_posts (
  id text primary key,
  topic_id text not null unique references public.max_topics(id) on delete restrict,
  research_id text not null,
  published_at timestamptz not null,
  data jsonb not null
);

create index max_posts_published_at_idx
  on public.max_posts (published_at desc);

create table public.max_post_sources (
  post_id text not null references public.max_posts(id) on delete cascade,
  source_id text not null,
  url text not null,
  primary key (post_id, source_id)
);

create table public.max_post_claims (
  post_id text not null references public.max_posts(id) on delete cascade,
  claim_id text not null,
  primary key (post_id, claim_id)
);

create table public.max_post_followups (
  id text primary key,
  post_id text not null references public.max_posts(id) on delete cascade,
  status text not null,
  updated_at timestamptz not null,
  data jsonb not null
);

create index max_post_followups_post_id_updated_at_idx
  on public.max_post_followups (post_id, updated_at desc);

alter table public.max_research_sessions enable row level security;
alter table public.max_knowledge_documents enable row level security;
alter table public.max_topics enable row level security;
alter table public.max_autonomous_runs enable row level security;
alter table public.max_posts enable row level security;
alter table public.max_post_sources enable row level security;
alter table public.max_post_claims enable row level security;
alter table public.max_post_followups enable row level security;

revoke all on table
  public.max_research_sessions,
  public.max_knowledge_documents,
  public.max_topics,
  public.max_autonomous_runs,
  public.max_posts,
  public.max_post_sources,
  public.max_post_claims,
  public.max_post_followups
from public, anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.max_research_sessions,
  public.max_knowledge_documents,
  public.max_topics,
  public.max_autonomous_runs,
  public.max_posts,
  public.max_post_sources,
  public.max_post_claims,
  public.max_post_followups
to service_role;

create function public.max_search_knowledge_documents(
  p_query text,
  p_verified_after timestamptz,
  p_limit integer
)
returns table (
  url text,
  title text,
  content text,
  raw_html text,
  fetched_at timestamptz,
  last_verified_at timestamptz,
  published_at timestamptz,
  metadata jsonb,
  content_hash text,
  version integer
)
language sql
stable
set search_path = ''
as $$
  select d.url, d.title, d.content, d.raw_html, d.fetched_at,
         d.last_verified_at, d.published_at, d.metadata, d.content_hash, d.version
  from public.max_knowledge_documents as d
  where d.last_verified_at >= p_verified_after
    and d.search_vector @@ websearch_to_tsquery('simple', p_query)
  order by ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', p_query)) desc,
           d.last_verified_at desc
  limit least(greatest(coalesce(p_limit, 10), 1), 30)
$$;

create function public.max_save_knowledge_document(
  p_document jsonb,
  p_content_hash text,
  p_verified_at timestamptz
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.max_knowledge_documents (
    url, title, content, raw_html, fetched_at, last_verified_at,
    published_at, metadata, content_hash, version
  ) values (
    p_document->>'url', p_document->>'title', p_document->>'content',
    coalesce(p_document->>'rawHtml', ''), (p_document->>'fetchedAt')::timestamptz,
    p_verified_at, nullif(p_document->>'publishedAt', '')::timestamptz,
    coalesce(p_document->'metadata', '{}'::jsonb), p_content_hash, 1
  )
  on conflict (url) do update set
    title = excluded.title,
    content = excluded.content,
    raw_html = excluded.raw_html,
    fetched_at = excluded.fetched_at,
    last_verified_at = excluded.last_verified_at,
    published_at = excluded.published_at,
    metadata = excluded.metadata,
    version = case
      when public.max_knowledge_documents.content_hash is distinct from excluded.content_hash
      then public.max_knowledge_documents.version + 1
      else public.max_knowledge_documents.version
    end,
    content_hash = excluded.content_hash;
end
$$;

create function public.max_recover_interrupted_sessions()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  changed integer;
  recovery_time timestamptz := clock_timestamp();
begin
  update public.max_research_sessions
  set status = 'FAILED',
      updated_at = recovery_time,
      data = data || jsonb_build_object(
        'status', 'FAILED',
        'updatedAt', recovery_time,
        'error', 'Research was interrupted by a server restart; retry the request.'
      )
  where status in ('QUEUED', 'PLANNING', 'SEARCHING', 'FETCHING', 'ANALYZING', 'SYNTHESIZING');
  get diagnostics changed = row_count;
  return changed;
end
$$;

create function public.max_recover_interrupted_content()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  changed_runs integer;
  changed_followups integer;
  recovery_time timestamptz := clock_timestamp();
begin
  update public.max_autonomous_runs
  set status = 'FAILED',
      updated_at = recovery_time,
      data = data || jsonb_build_object(
        'status', 'FAILED',
        'updatedAt', recovery_time,
        'error', 'Autonomous run was interrupted by a server restart; retry it manually.',
        'events', coalesce(data->'events', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
          'at', recovery_time, 'stage', 'recovery', 'status', 'failed',
          'detail', 'Autonomous run was interrupted by a server restart; retry it manually.'
        ))
      )
  where status in ('DISCOVERING', 'RESEARCHING', 'QUALITY_GATE');
  get diagnostics changed_runs = row_count;

  update public.max_post_followups
  set status = 'FAILED',
      updated_at = recovery_time,
      data = data || jsonb_build_object(
        'status', 'FAILED',
        'updatedAt', recovery_time,
        'error', 'Follow-up research was interrupted by a server restart; ask again.'
      )
  where status in ('QUEUED', 'RESEARCHING', 'SYNTHESIZING');
  get diagnostics changed_followups = row_count;
  return changed_runs + changed_followups;
end
$$;

create function public.max_save_post(p_post jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  post_id text := p_post->>'id';
begin
  insert into public.max_posts (id, topic_id, research_id, published_at, data)
  values (post_id, p_post->>'topicId', p_post->>'researchId',
          (p_post->>'publishedAt')::timestamptz, p_post);

  insert into public.max_post_sources (post_id, source_id, url)
  select post_id, source->>'id', source->>'url'
  from jsonb_array_elements(coalesce(p_post->'sources', '[]'::jsonb)) as source;

  insert into public.max_post_claims (post_id, claim_id)
  select post_id, claim->>'id'
  from jsonb_array_elements(coalesce(p_post->'claims', '[]'::jsonb)) as claim;
end
$$;

create function public.max_publish_post(p_post jsonb, p_topic jsonb, p_run jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  updated_rows integer;
begin
  if p_post->>'topicId' is distinct from p_topic->>'id'
     or p_run->>'topicId' is distinct from p_topic->>'id'
     or p_run->>'postId' is distinct from p_post->>'id'
     or p_run->>'status' is distinct from 'PUBLISHED' then
    raise exception 'Published post, topic, and run state do not match';
  end if;

  perform public.max_save_post(p_post);

  update public.max_topics
  set status = p_topic->>'status', score = (p_topic->>'score')::double precision, data = p_topic
  where id = p_topic->>'id';
  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then raise exception 'Publication topic was not found'; end if;

  update public.max_autonomous_runs
  set status = p_run->>'status', updated_at = (p_run->>'updatedAt')::timestamptz, data = p_run
  where id = p_run->>'id';
  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then raise exception 'Autonomous run was not found'; end if;
end
$$;

revoke all on function public.max_search_knowledge_documents(text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.max_save_knowledge_document(jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.max_recover_interrupted_sessions() from public, anon, authenticated;
revoke all on function public.max_recover_interrupted_content() from public, anon, authenticated;
revoke all on function public.max_save_post(jsonb) from public, anon, authenticated;
revoke all on function public.max_publish_post(jsonb, jsonb, jsonb) from public, anon, authenticated;

grant execute on function public.max_search_knowledge_documents(text, timestamptz, integer) to service_role;
grant execute on function public.max_save_knowledge_document(jsonb, text, timestamptz) to service_role;
grant execute on function public.max_recover_interrupted_sessions() to service_role;
grant execute on function public.max_recover_interrupted_content() to service_role;
grant execute on function public.max_save_post(jsonb) to service_role;
grant execute on function public.max_publish_post(jsonb, jsonb, jsonb) to service_role;
