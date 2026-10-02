-- Durable backend jobs. Queue records are server-only; user access is through
-- owner-scoped Fastify endpoints, never through the Supabase Data API.
create table research.max_jobs (
  id uuid primary key,
  kind text not null check (kind in ('research', 'post_agent')),
  owner_id uuid references auth.users (id) on delete cascade,
  owner_scope text not null check (char_length(owner_scope) between 1 and 80),
  idempotency_key text check (
    idempotency_key is null or char_length(idempotency_key) between 1 and 128
  ),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144
  ),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'retrying', 'cancel_requested', 'completed', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  available_at timestamptz not null default clock_timestamp(),
  lease_owner text,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  progress jsonb not null default '{}'::jsonb check (
    jsonb_typeof(progress) = 'object' and octet_length(progress::text) <= 65536
  ),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 262144)),
  error_summary text check (error_summary is null or char_length(error_summary) <= 512),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  check (
    (owner_id is null and owner_scope = 'system')
    or (owner_id is not null and owner_scope = 'user:' || owner_id::text)
  ),
  check (
    (status in ('running', 'cancel_requested') and lease_owner is not null and lease_expires_at is not null)
    or (status not in ('running', 'cancel_requested') and lease_owner is null and lease_expires_at is null)
  )
);

create unique index max_jobs_idempotency_idx
  on research.max_jobs (owner_scope, idempotency_key)
  where idempotency_key is not null;
create index max_jobs_claim_idx
  on research.max_jobs (status, available_at, created_at);
create index max_jobs_owner_created_idx
  on research.max_jobs (owner_id, created_at desc);

alter table research.max_jobs enable row level security;
revoke all on research.max_jobs from public, anon, authenticated;
grant select, insert, update, delete on research.max_jobs to service_role;

-- Idempotent enqueue and quota charging happen in the same transaction. A
-- replayed key returns the original job and never consumes quota twice.
create function research.max_enqueue_job(
  p_id uuid,
  p_kind text,
  p_owner_id uuid,
  p_owner_scope text,
  p_idempotency_key text,
  p_payload jsonb,
  p_max_attempts integer,
  p_quota_key text,
  p_quota_window_seconds integer,
  p_quota_limit integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_job research.max_jobs;
  inserted_job research.max_jobs;
  quota_result record;
begin
  if p_id is null
    or p_kind not in ('research', 'post_agent')
    or p_owner_scope is null
    or char_length(p_owner_scope) not between 1 and 80
    or p_max_attempts not between 1 and 5
    or p_payload is null
    or jsonb_typeof(p_payload) is distinct from 'object'
    or octet_length(p_payload::text) > 262144 then
    raise exception using errcode = '22023', message = 'Invalid job request';
  end if;

  if (p_owner_id is null and p_owner_scope <> 'system')
    or (p_owner_id is not null and p_owner_scope <> 'user:' || p_owner_id::text) then
    raise exception using errcode = '22023', message = 'Invalid job ownership scope';
  end if;

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 1 and 128 then
      raise exception using errcode = '22023', message = 'Invalid idempotency key';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_owner_scope || ':' || p_idempotency_key, 0)
    );
    select * into existing_job
      from research.max_jobs as job
      where job.owner_scope = p_owner_scope
        and job.idempotency_key = p_idempotency_key
      for update;
    if found then
      if existing_job.kind is distinct from p_kind
        or existing_job.owner_id is distinct from p_owner_id
        or existing_job.payload is distinct from p_payload then
        raise exception using errcode = '23505', message = 'Idempotency key was already used for a different job request';
      end if;
      return pg_catalog.jsonb_build_object(
        'job', pg_catalog.to_jsonb(existing_job),
        'created', false,
        'quota', null
      );
    end if;
  end if;

  if p_quota_key is not null then
    if p_owner_id is null
      or p_quota_window_seconds is null
      or p_quota_limit is null then
      raise exception using errcode = '22023', message = 'Invalid job quota request';
    end if;
    select * into quota_result
      from research.max_consume_user_quota(
        p_owner_id,
        p_quota_key,
        p_quota_window_seconds,
        p_quota_limit
      );
    if not quota_result.allowed then
      return pg_catalog.jsonb_build_object(
        'job', null,
        'created', false,
        'quota', pg_catalog.jsonb_build_object(
          'allowed', false,
          'used', quota_result.used,
          'resets_at', quota_result.resets_at
        )
      );
    end if;
  elsif p_quota_window_seconds is not null or p_quota_limit is not null then
    raise exception using errcode = '22023', message = 'Incomplete job quota request';
  end if;

  insert into research.max_jobs (
    id, kind, owner_id, owner_scope, idempotency_key, payload, max_attempts
  ) values (
    p_id, p_kind, p_owner_id, p_owner_scope, p_idempotency_key, p_payload, p_max_attempts
  ) returning * into inserted_job;

  return pg_catalog.jsonb_build_object(
    'job', pg_catalog.to_jsonb(inserted_job),
    'created', true,
    'quota', case when p_quota_key is null then null else pg_catalog.jsonb_build_object(
      'allowed', true,
      'used', quota_result.used,
      'resets_at', quota_result.resets_at
    ) end
  );
end;
$$;

create function research.max_claim_job(p_worker_id text, p_lease_seconds integer)
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
        and job.available_at <= now_at
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

create function research.max_heartbeat_job(
  p_id uuid,
  p_worker_id text,
  p_generation bigint,
  p_lease_seconds integer,
  p_progress jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_status text;
begin
  if p_lease_seconds not between 5 and 300
    or p_progress is null
    or jsonb_typeof(p_progress) is distinct from 'object'
    or octet_length(p_progress::text) > 65536 then
    raise exception using errcode = '22023', message = 'Invalid job heartbeat';
  end if;
  update research.max_jobs as job
    set lease_expires_at = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
        progress = p_progress,
        updated_at = clock_timestamp()
    where job.id = p_id
      and job.lease_owner = p_worker_id
      and job.lease_generation = p_generation
      and job.lease_expires_at > clock_timestamp()
      and job.status in ('running', 'cancel_requested')
    returning job.status into current_status;
  return pg_catalog.jsonb_build_object(
    'lease_valid', current_status is not null,
    'cancel_requested', current_status = 'cancel_requested'
  );
end;
$$;

create function research.max_complete_job(
  p_id uuid,
  p_worker_id text,
  p_generation bigint,
  p_result jsonb
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  final_status text;
begin
  if p_result is null or jsonb_typeof(p_result) is distinct from 'object'
    or octet_length(p_result::text) > 262144 then
    raise exception using errcode = '22023', message = 'Invalid job result';
  end if;
  update research.max_jobs as job
    set status = case when job.status = 'cancel_requested' then 'cancelled' else 'completed' end,
        result = case when job.status = 'cancel_requested' then null else p_result end,
        finished_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        lease_owner = null,
        lease_expires_at = null
    where job.id = p_id
      and job.lease_owner = p_worker_id
      and job.lease_generation = p_generation
      and job.lease_expires_at > clock_timestamp()
      and job.status in ('running', 'cancel_requested')
    returning job.status into final_status;
  return final_status;
end;
$$;

create function research.max_fail_job(
  p_id uuid,
  p_worker_id text,
  p_generation bigint,
  p_error_summary text,
  p_retryable boolean,
  p_retry_delay_seconds integer
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  failed_job research.max_jobs;
  now_at timestamptz := clock_timestamp();
begin
  if p_retry_delay_seconds not between 0 and 300 then
    raise exception using errcode = '22023', message = 'Invalid retry delay';
  end if;
  update research.max_jobs as job
    set status = case
          when job.status = 'cancel_requested' then 'cancelled'
          when p_retryable and job.attempts < job.max_attempts then 'retrying'
          else 'failed'
        end,
        available_at = case
          when job.status <> 'cancel_requested'
            and p_retryable and job.attempts < job.max_attempts
            then now_at + pg_catalog.make_interval(secs => p_retry_delay_seconds)
          else job.available_at
        end,
        error_summary = left(coalesce(nullif(btrim(p_error_summary), ''), 'Job execution failed'), 512),
        finished_at = case
          when job.status = 'cancel_requested'
            or not p_retryable or job.attempts >= job.max_attempts then now_at
          else null
        end,
        updated_at = now_at,
        lease_owner = null,
        lease_expires_at = null
    where job.id = p_id
      and job.lease_owner = p_worker_id
      and job.lease_generation = p_generation
      and job.lease_expires_at > now_at
      and job.status in ('running', 'cancel_requested')
    returning job.* into failed_job;
  if not found then return null; end if;
  return failed_job.status;
end;
$$;

create function research.max_cancel_job(p_id uuid, p_owner_id uuid, p_include_system boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cancelled_job research.max_jobs;
begin
  update research.max_jobs as job
    set status = case
          when job.status in ('queued', 'retrying') then 'cancelled'
          when job.status = 'running' then 'cancel_requested'
          else job.status
        end,
        cancel_requested_at = case
          when job.status = 'running' then clock_timestamp()
          else job.cancel_requested_at
        end,
        finished_at = case
          when job.status in ('queued', 'retrying') then clock_timestamp()
          else job.finished_at
        end,
        updated_at = clock_timestamp()
    where job.id = p_id
      and (
        (p_owner_id is not null and job.owner_id = p_owner_id)
        or (p_owner_id is null and coalesce(p_include_system, false) and job.owner_id is null)
      )
    returning job.* into cancelled_job;
  if not found then return null; end if;
  return pg_catalog.to_jsonb(cancelled_job);
end;
$$;

revoke all on function research.max_enqueue_job(uuid, text, uuid, text, text, jsonb, integer, text, integer, integer)
  from public, anon, authenticated;
revoke all on function research.max_claim_job(text, integer) from public, anon, authenticated;
revoke all on function research.max_heartbeat_job(uuid, text, bigint, integer, jsonb)
  from public, anon, authenticated;
revoke all on function research.max_complete_job(uuid, text, bigint, jsonb)
  from public, anon, authenticated;
revoke all on function research.max_fail_job(uuid, text, bigint, text, boolean, integer)
  from public, anon, authenticated;
revoke all on function research.max_cancel_job(uuid, uuid, boolean) from public, anon, authenticated;

grant execute on function research.max_enqueue_job(uuid, text, uuid, text, text, jsonb, integer, text, integer, integer)
  to service_role;
grant execute on function research.max_claim_job(text, integer) to service_role;
grant execute on function research.max_heartbeat_job(uuid, text, bigint, integer, jsonb)
  to service_role;
grant execute on function research.max_complete_job(uuid, text, bigint, jsonb)
  to service_role;
grant execute on function research.max_fail_job(uuid, text, bigint, text, boolean, integer)
  to service_role;
grant execute on function research.max_cancel_job(uuid, uuid, boolean) to service_role;
