-- Bound total retained semantic-memory storage per owner, including inactive
-- rows. Hard deletion frees a slot; changing an existing row's active state
-- does not consume an additional slot.
drop trigger if exists max_user_memories_enforce_active_limit
  on research.max_user_memories;

drop function if exists research.enforce_user_memory_active_limit();

create function research.enforce_user_memory_retained_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  retained_count integer;
begin
  if new.owner_id is distinct from (select auth.uid())
    or (select auth.jwt() ->> 'is_anonymous') is not distinct from 'true' then
    raise exception using errcode = '42501', message = 'memory owner must be the authenticated user';
  end if;

  if tg_op = 'INSERT' and exists (
    select 1
    from research.max_user_memories as memory
    where memory.owner_id = new.owner_id
      and memory.content_hash = new.content_hash
  ) then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.owner_id::text, 0)
  );

  select count(*)
    into retained_count
    from research.max_user_memories as memory
    where memory.owner_id = new.owner_id
      and memory.id is distinct from new.id;

  if retained_count >= 500 then
    raise exception using errcode = '54000', message = 'retained user memory limit reached';
  end if;

  return new;
end;
$$;

revoke all on function research.enforce_user_memory_retained_limit()
  from public, anon, authenticated;

create trigger max_user_memories_enforce_retained_limit
  before insert or update of owner_id, is_active
  on research.max_user_memories
  for each row
  execute function research.enforce_user_memory_retained_limit();
