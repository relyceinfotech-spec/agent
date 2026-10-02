-- All worker-owned writes lock and validate the current queue lease in the same
-- transaction as the mutation. Public roles cannot invoke these functions.
create function research.max_assert_worker_lease(p_job_id uuid, p_worker_id text, p_generation bigint,p_allow_cancellation boolean default false)
returns void language plpgsql security invoker set search_path = '' as $$
declare j research.max_jobs;
begin
  select * into j from research.max_jobs where id = p_job_id for update;
  if not found or (j.status <> 'running' and not (p_allow_cancellation and j.status='cancel_requested')) or j.lease_owner is distinct from p_worker_id
    or j.lease_generation is distinct from p_generation or j.lease_expires_at is null
    or j.lease_expires_at <= clock_timestamp() then
    raise exception 'Job lease was lost';
  end if;
end $$;
revoke all on function research.max_assert_worker_lease(uuid,text,bigint,boolean) from public, anon, authenticated;
grant execute on function research.max_assert_worker_lease(uuid,text,bigint,boolean) to service_role;

create table research.max_deleted_research_sessions (
  id text primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default clock_timestamp()
);
alter table research.max_deleted_research_sessions enable row level security;
revoke all on research.max_deleted_research_sessions from public, anon, authenticated;
grant select, insert on research.max_deleted_research_sessions to service_role;

create function research.max_reject_deleted_session() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('research-session:' || new.id, 0));
  if exists (select 1 from research.max_deleted_research_sessions where id = new.id) then
    raise exception 'Research session was deleted';
  end if;
  return new;
end $$;
revoke all on function research.max_reject_deleted_session() from public, anon, authenticated;
grant execute on function research.max_reject_deleted_session() to service_role;
create trigger max_reject_deleted_session before insert or update on research.max_research_sessions
for each row execute function research.max_reject_deleted_session();

create function research.max_delete_research_session(p_id text, p_owner_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('research-session:' || p_id, 0));
  insert into research.max_deleted_research_sessions(id,owner_id)
    select id,owner_id from research.max_research_sessions
    where id = p_id and owner_id is not distinct from p_owner_id on conflict(id) do nothing;
  insert into research.max_deleted_research_sessions(id,owner_id)
    select p_id,p_owner_id where p_owner_id is not null
    and not exists(select 1 from research.max_research_sessions where id=p_id)
    and exists(select 1 from research.max_jobs where owner_id=p_owner_id and payload->>'sessionId'=p_id
      and coalesce(payload->>'task','')<>'followup') on conflict(id) do nothing;
  delete from research.max_research_sessions where id = p_id and owner_id is not distinct from p_owner_id;
end $$;
revoke all on function research.max_delete_research_session(text,uuid) from public, anon, authenticated;
grant execute on function research.max_delete_research_session(text,uuid) to service_role;

create function research.max_write_worker_session(p_session jsonb, p_owner_id uuid, p_create boolean,
  p_job_id uuid, p_worker_id text, p_generation bigint) returns void
language plpgsql security invoker set search_path = '' as $$
declare j research.max_jobs;
begin
  perform research.max_assert_worker_lease(p_job_id,p_worker_id,p_generation,not p_create and p_session->>'status'='CANCELLED');
  select * into j from research.max_jobs where id = p_job_id;
  if j.owner_id is distinct from p_owner_id then raise exception 'Research owner mismatch'; end if;
  if j.kind = 'research' and coalesce(j.payload->>'task','') <> 'followup'
    and j.payload->>'sessionId' is distinct from p_session->>'id' then
    raise exception 'Research session mismatch';
  end if;
  if p_create then
    insert into research.max_research_sessions(id,owner_id,created_at,updated_at,status,data)
    values (p_session->>'id',p_owner_id,(p_session->>'createdAt')::timestamptz,
      (p_session->>'updatedAt')::timestamptz,p_session->>'status',p_session);
  else
    update research.max_research_sessions set updated_at=(p_session->>'updatedAt')::timestamptz,
      status=p_session->>'status',data=p_session
    where id=p_session->>'id' and owner_id is not distinct from p_owner_id;
    if not found then raise exception 'Research session could not be updated'; end if;
  end if;
end $$;
revoke all on function research.max_write_worker_session(jsonb,uuid,boolean,uuid,text,bigint) from public, anon, authenticated;
grant execute on function research.max_write_worker_session(jsonb,uuid,boolean,uuid,text,bigint) to service_role;

create function content.max_write_worker_content(p_kind text,p_data jsonb,
  p_job_id uuid,p_worker_id text,p_generation bigint) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform research.max_assert_worker_lease(p_job_id,p_worker_id,p_generation,p_kind='run' and p_data->>'status'='CANCELLED');
  if p_kind='followup' then
    if not exists(select 1 from research.max_jobs where id=p_job_id and owner_id is not null
      and payload->>'task'='followup' and payload->>'postId'=p_data->>'postId'
      and id::text=p_data->>'id') then raise exception 'Follow-up job mismatch'; end if;
    insert into content.max_post_followups(id,owner_id,post_id,status,updated_at,data)
    select p_data->>'id',owner_id,p_data->>'postId',p_data->>'status',(p_data->>'updatedAt')::timestamptz,p_data
    from research.max_jobs where id=p_job_id
    on conflict(id) do update set status=excluded.status,updated_at=excluded.updated_at,data=excluded.data
      where content.max_post_followups.owner_id=excluded.owner_id;
    if not found then raise exception 'Follow-up owner mismatch'; end if;
    return;
  end if;
  if not exists (select 1 from research.max_jobs where id=p_job_id and kind='post_agent' and owner_id is null) then
    raise exception 'Post Agent job required';
  end if;
  if p_kind = 'topic' then
    insert into content.max_topics(id,url,status,score,discovered_at,data)
    values(p_data->>'id',p_data->>'url',p_data->>'status',(p_data->>'score')::double precision,
      (p_data->>'discoveredAt')::timestamptz,p_data)
    on conflict(id) do update set status=excluded.status,score=excluded.score,data=excluded.data;
  elsif p_kind = 'run' then
    if p_data->>'id' <> p_job_id::text then raise exception 'Post Agent run mismatch'; end if;
    insert into content.max_autonomous_runs(id,status,created_at,updated_at,data)
    values(p_data->>'id',p_data->>'status',(p_data->>'createdAt')::timestamptz,(p_data->>'updatedAt')::timestamptz,p_data)
    on conflict(id) do update set status=excluded.status,updated_at=excluded.updated_at,data=excluded.data;
  elsif p_kind = 'publish' then
    if p_data->'run'->>'id' <> p_job_id::text then raise exception 'Post Agent run mismatch'; end if;
    perform content.max_publish_post(p_data->'post',p_data->'topic',p_data->'run');
  else raise exception 'Unsupported worker mutation'; end if;
end $$;
revoke all on function content.max_write_worker_content(text,jsonb,uuid,text,bigint) from public, anon, authenticated;
grant execute on function content.max_write_worker_content(text,jsonb,uuid,text,bigint) to service_role;

-- Retire competing historical attempts before enforcing one active session job.
with ranked as (
  select id,row_number() over(partition by owner_scope,payload->>'sessionId'
    order by (status='running') desc,created_at,id) as position
  from research.max_jobs where kind='research' and payload ? 'sessionId'
    and status in ('queued','retrying','running','cancel_requested')
)
update research.max_jobs set status='failed',lease_owner=null,lease_expires_at=null,
  error_summary='Superseded competing research job',updated_at=clock_timestamp(),finished_at=clock_timestamp()
where id in (select id from ranked where position>1);
create unique index max_jobs_active_research_session_idx on research.max_jobs(owner_scope,(payload->>'sessionId'))
where kind='research' and status in ('queued','retrying','running','cancel_requested');

-- Export creation and payload changes must pass the server's resource projection.
revoke insert, update, delete on content.max_exports from authenticated;
-- PostgreSQL column grants survive a table-level REVOKE. Remove those too.
revoke insert (
  id,owner_id,resource_type,resource_id,format,status,snapshot_hash,file_name,
  content_type,attempts,payload_base64,output_bytes,created_at,updated_at,completed_at,failure_reason
), update (
  id,owner_id,resource_type,resource_id,format,status,snapshot_hash,file_name,
  content_type,attempts,payload_base64,output_bytes,created_at,updated_at,completed_at,failure_reason
) on content.max_exports from authenticated;

create function research.max_claim_job_by_id(p_worker_id text, p_lease_seconds integer, p_job_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed_job research.max_jobs;
  now_at timestamptz := clock_timestamp();
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128
    or p_lease_seconds not between 5 and 300 then
    raise exception using errcode = '22023', message = 'Invalid worker lease request';
  end if;

  update research.max_jobs as job
    set status = case
          when job.status = 'cancel_requested' then 'cancelled'
          when job.attempts >= job.max_attempts then 'failed'
          else 'retrying'
        end,
        available_at = case
          when job.status = 'running' and job.attempts < job.max_attempts
            then now_at + pg_catalog.make_interval(secs => least(30, (2 ^ job.attempts)::integer))
          else job.available_at
        end,
        error_summary = case
          when job.status = 'running' and job.attempts >= job.max_attempts
            then 'Worker lease expired after the final attempt.'
          when job.status = 'running' then 'Worker lease expired; the job will be recovered.'
          else job.error_summary
        end,
        finished_at = case
          when job.status = 'cancel_requested' or job.attempts >= job.max_attempts then now_at
          else null
        end,
        updated_at = now_at,
        lease_owner = null,
        lease_expires_at = null
    where job.status in ('running', 'cancel_requested')
      and job.lease_expires_at <= now_at;

  with candidate as (
    select job.id
      from research.max_jobs as job
      where job.status in ('queued', 'retrying')
        and job.available_at <= now_at and job.id = p_job_id
      order by job.created_at, job.id
      for update skip locked
      limit 1
  )
  update research.max_jobs as job
    set status = 'running',
        attempts = job.attempts + 1,
        lease_owner = p_worker_id,
        lease_generation = job.lease_generation + 1,
        lease_expires_at = now_at + pg_catalog.make_interval(secs => p_lease_seconds),
        started_at = coalesce(job.started_at, now_at),
        updated_at = now_at
    from candidate
    where job.id = candidate.id
    returning job.* into claimed_job;

  if not found then return null; end if;
  return pg_catalog.to_jsonb(claimed_job);
end;
$$;


revoke all on function research.max_claim_job_by_id(text,integer,uuid) from public,anon,authenticated;
grant execute on function research.max_claim_job_by_id(text,integer,uuid) to service_role;

create table research.max_request_rate_limits (
  key text primary key check (key ~ '^[a-f0-9]{64}$'),
  window_end timestamptz not null,
  used integer not null check(used > 0)
);
create index max_request_rate_limits_expiry on research.max_request_rate_limits(window_end);
alter table research.max_request_rate_limits enable row level security;
revoke all on research.max_request_rate_limits from public,anon,authenticated;
grant select,insert,update,delete on research.max_request_rate_limits to service_role;
create function research.max_consume_rate_limit(p_key text,p_window_ms integer,p_limit integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare now_at timestamptz:=clock_timestamp(); end_at timestamptz; count_used integer;
begin
  if p_window_ms < 1 or p_limit < 1 or p_limit > 10000000 then raise exception 'Invalid rate limit'; end if;
  end_at:=pg_catalog.to_timestamp((floor(extract(epoch from now_at)*1000/p_window_ms)+1)*p_window_ms/1000);
  delete from research.max_request_rate_limits where key in
    (select key from research.max_request_rate_limits where window_end<=now_at limit 100);
  insert into research.max_request_rate_limits(key,window_end,used) values(p_key,end_at,1)
  on conflict(key) do update set window_end=excluded.window_end,
    used=case when max_request_rate_limits.window_end=excluded.window_end
      then least(max_request_rate_limits.used+1,p_limit+1) else 1 end returning used into count_used;
  return pg_catalog.jsonb_build_object('allowed',count_used<=p_limit,'remaining',greatest(0,p_limit-count_used),
    'reset_ms',ceil(extract(epoch from (end_at-now_at))*1000));
end $$;
revoke all on function research.max_consume_rate_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function research.max_consume_rate_limit(text,integer,integer) to service_role;
