-- A PL/pgSQL RECORD is undefined when enqueue omits quota; use typed nullable
-- values so system jobs can be enqueued without dereferencing an unassigned row.
create or replace function research.max_enqueue_job(
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
  quota_allowed boolean;
  quota_used integer;
  quota_resets_at timestamptz;
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
    select quota.allowed, quota.used, quota.resets_at
      into quota_allowed, quota_used, quota_resets_at
      from research.max_consume_user_quota(
        p_owner_id,
        p_quota_key,
        p_quota_window_seconds,
        p_quota_limit
      ) as quota;
    if not quota_allowed then
      return pg_catalog.jsonb_build_object(
        'job', null,
        'created', false,
        'quota', pg_catalog.jsonb_build_object(
          'allowed', false,
          'used', quota_used,
          'resets_at', quota_resets_at
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
      'used', quota_used,
      'resets_at', quota_resets_at
    ) end
  );
end;
$$;

revoke all on function research.max_enqueue_job(uuid, text, uuid, text, text, jsonb, integer, text, integer, integer)
  from public, anon, authenticated;
grant execute on function research.max_enqueue_job(uuid, text, uuid, text, text, jsonb, integer, text, integer, integer)
  to service_role;
