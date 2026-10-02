-- Separate MAX research storage from content-agent storage without dropping data.
create schema if not exists research;
create schema if not exists content;

alter table public.max_research_sessions set schema research;
alter table public.max_knowledge_documents set schema research;

alter table public.max_topics set schema content;
alter table public.max_autonomous_runs set schema content;
alter table public.max_posts set schema content;
alter table public.max_post_sources set schema content;
alter table public.max_post_claims set schema content;
alter table public.max_post_followups set schema content;

alter function public.max_search_knowledge_documents(text, timestamptz, integer)
  set schema research;
alter function public.max_save_knowledge_document(jsonb, text, timestamptz)
  set schema research;
alter function public.max_recover_interrupted_sessions()
  set schema research;
alter function public.max_recover_interrupted_content()
  set schema content;
alter function public.max_save_post(jsonb)
  set schema content;
alter function public.max_publish_post(jsonb, jsonb, jsonb)
  set schema content;

create or replace function research.max_search_knowledge_documents(
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
  from research.max_knowledge_documents as d
  where d.last_verified_at >= p_verified_after
    and d.search_vector @@ websearch_to_tsquery('simple', p_query)
  order by ts_rank_cd(d.search_vector, websearch_to_tsquery('simple', p_query)) desc,
           d.last_verified_at desc
  limit least(greatest(coalesce(p_limit, 10), 1), 30)
$$;

create or replace function research.max_save_knowledge_document(
  p_document jsonb,
  p_content_hash text,
  p_verified_at timestamptz
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into research.max_knowledge_documents (
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
      when research.max_knowledge_documents.content_hash is distinct from excluded.content_hash
      then research.max_knowledge_documents.version + 1
      else research.max_knowledge_documents.version
    end,
    content_hash = excluded.content_hash;
end
$$;

create or replace function research.max_recover_interrupted_sessions()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  changed integer;
  recovery_time timestamptz := clock_timestamp();
begin
  update research.max_research_sessions
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

create or replace function content.max_recover_interrupted_content()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  changed_runs integer;
  changed_followups integer;
  recovery_time timestamptz := clock_timestamp();
begin
  update content.max_autonomous_runs
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

  update content.max_post_followups
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

create or replace function content.max_save_post(p_post jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  post_id text := p_post->>'id';
begin
  insert into content.max_posts (id, topic_id, research_id, published_at, data)
  values (post_id, p_post->>'topicId', p_post->>'researchId',
          (p_post->>'publishedAt')::timestamptz, p_post);

  insert into content.max_post_sources (post_id, source_id, url)
  select post_id, source->>'id', source->>'url'
  from jsonb_array_elements(coalesce(p_post->'sources', '[]'::jsonb)) as source;

  insert into content.max_post_claims (post_id, claim_id)
  select post_id, claim->>'id'
  from jsonb_array_elements(coalesce(p_post->'claims', '[]'::jsonb)) as claim;
end
$$;

create or replace function content.max_publish_post(p_post jsonb, p_topic jsonb, p_run jsonb)
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

  perform content.max_save_post(p_post);

  update content.max_topics
  set status = p_topic->>'status', score = (p_topic->>'score')::double precision, data = p_topic
  where id = p_topic->>'id';
  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then raise exception 'Publication topic was not found'; end if;

  update content.max_autonomous_runs
  set status = p_run->>'status', updated_at = (p_run->>'updatedAt')::timestamptz, data = p_run
  where id = p_run->>'id';
  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then raise exception 'Autonomous run was not found'; end if;
end
$$;

-- Keep both schemas API-addressable while leaving MAX tables/functions private to service_role.
grant usage on schema research, content to service_role;
revoke all on schema research, content from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema research, content to service_role;
revoke all on all tables in schema research, content from public, anon, authenticated;
grant execute on all routines in schema research, content to service_role;
revoke all on all routines in schema research, content from public, anon, authenticated;

alter default privileges for role postgres in schema research
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema content
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema research
  revoke execute on routines from public, anon, authenticated;
alter default privileges for role postgres in schema content
  revoke execute on routines from public, anon, authenticated;

alter role authenticator set pgrst.db_schemas = 'public,graphql_public,research,content';
notify pgrst, 'reload config';
