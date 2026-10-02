-- Bind private research artifacts to Supabase Auth identities.
-- Existing rows remain unowned and are intentionally invisible to end users.
alter table research.max_research_sessions
  add column owner_id uuid references auth.users (id) on delete cascade;

create index max_research_sessions_owner_created_idx
  on research.max_research_sessions (owner_id, created_at desc);

alter table content.max_post_followups
  add column owner_id uuid references auth.users (id) on delete cascade;

create index max_post_followups_owner_updated_idx
  on content.max_post_followups (owner_id, updated_at desc);

alter table research.max_research_sessions enable row level security;
alter table content.max_post_followups enable row level security;

grant usage on schema research, content to authenticated;
grant select, insert, update, delete
  on research.max_research_sessions, content.max_post_followups
  to authenticated;

create policy "users manage their research sessions"
  on research.max_research_sessions
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

create policy "users manage their post followups"
  on content.max_post_followups
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

-- Atomic, server-only usage buckets. Clients cannot call this function or inspect counters.
create table research.max_user_quota_windows (
  user_id uuid not null references auth.users (id) on delete cascade,
  quota_key text not null check (quota_key in ('research', 'deep_research', 'followup')),
  window_start timestamptz not null,
  window_seconds integer not null check (window_seconds between 60 and 604800),
  used integer not null check (used > 0),
  primary key (user_id, quota_key)
);

alter table research.max_user_quota_windows enable row level security;
revoke all on research.max_user_quota_windows from public, anon, authenticated;
grant select, insert, update, delete on research.max_user_quota_windows to service_role;

create function research.max_consume_user_quota(
  p_user_id uuid,
  p_quota_key text,
  p_window_seconds integer,
  p_limit integer
)
returns table (allowed boolean, used integer, resets_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_window timestamptz;
  current_used integer;
begin
  if p_user_id is null
    or p_quota_key is null
    or p_quota_key not in ('research', 'deep_research', 'followup')
    or p_window_seconds is null
    or p_window_seconds not between 60 and 604800
    or p_limit is null
    or p_limit not between 1 and 10000 then
    raise exception 'Invalid quota request';
  end if;

  current_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into research.max_user_quota_windows as quota (
    user_id, quota_key, window_start, window_seconds, used
  ) values (
    p_user_id, p_quota_key, current_window, p_window_seconds, 1
  )
  on conflict (user_id, quota_key) do update
  set window_start = current_window,
      window_seconds = p_window_seconds,
      used = case
        when quota.window_start < current_window
          or quota.window_seconds <> p_window_seconds then 1
        else quota.used + 1
      end
  where quota.window_start < current_window
     or quota.window_seconds <> p_window_seconds
     or quota.used < p_limit
  returning quota.used into current_used;

  if found then
    return query select true, current_used, current_window + make_interval(secs => p_window_seconds);
    return;
  end if;

  select quota.used
    into current_used
    from research.max_user_quota_windows as quota
   where quota.user_id = p_user_id
     and quota.quota_key = p_quota_key;

  return query select false, current_used, current_window + make_interval(secs => p_window_seconds);
end;
$$;

revoke all on function research.max_consume_user_quota(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function research.max_consume_user_quota(uuid, text, integer, integer)
  to service_role;
