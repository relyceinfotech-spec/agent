create table research.max_conversations (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  next_turn_index bigint not null default 0 check (next_turn_index >= 0),
  unique (id, owner_id)
);

create index max_conversations_owner_updated_idx
  on research.max_conversations(owner_id, updated_at desc, id desc);

create table research.max_conversation_messages (
  id uuid primary key,
  conversation_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  turn_index bigint not null check (turn_index >= 0),
  position bigint not null check (position >= 0),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) between 1 and 12000),
  created_at timestamptz not null,
  research_id text,
  job_id uuid,
  request_key_hash text check (request_key_hash is null or request_key_hash ~ '^[a-f0-9]{64}$'),
  constraint max_conversation_messages_owner_fk
    foreign key (conversation_id, owner_id)
    references research.max_conversations(id, owner_id) on delete cascade,
  constraint max_conversation_messages_turn_unique
    unique (conversation_id, turn_index, role),
  constraint max_conversation_messages_position_unique
    unique (conversation_id, position)
);

create unique index max_conversation_messages_request_key_idx
  on research.max_conversation_messages(owner_id, request_key_hash)
  where role = 'user' and request_key_hash is not null;
create unique index max_conversation_messages_assistant_job_idx
  on research.max_conversation_messages(job_id)
  where role = 'assistant' and job_id is not null;
create index max_conversation_messages_history_idx
  on research.max_conversation_messages(owner_id, conversation_id, position desc);

alter table research.max_conversations enable row level security;
alter table research.max_conversation_messages enable row level security;
revoke all on research.max_conversations, research.max_conversation_messages
  from public, anon, authenticated;
grant select, insert, update, delete
  on research.max_conversations, research.max_conversation_messages to service_role;

create function research.max_append_conversation_user_message(
  p_owner_id uuid,
  p_conversation_id uuid,
  p_new_conversation_id uuid,
  p_message_id uuid,
  p_title text,
  p_content text,
  p_created_at timestamptz,
  p_request_key_hash text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_conversation research.max_conversations;
  v_message research.max_conversation_messages;
  v_turn_index bigint;
begin
  if p_content is null or length(p_content) not between 1 and 12000 then
    raise exception using errcode = '22023', message = 'invalid_conversation_message';
  end if;
  if p_title is null or length(p_title) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'invalid_conversation_title';
  end if;
  if p_request_key_hash is not null then
    if p_request_key_hash !~ '^[a-f0-9]{64}$' then
      raise exception using errcode = '22023', message = 'invalid_conversation_request_key';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(p_owner_id::text || ':conversation:' || p_request_key_hash, 0)
    );
    select * into v_message
      from research.max_conversation_messages
      where owner_id = p_owner_id and role = 'user' and request_key_hash = p_request_key_hash
      for update;
    if found then
      if v_message.content is distinct from p_content
        or (p_conversation_id is not null and v_message.conversation_id <> p_conversation_id) then
        raise exception using errcode = 'P0001', message = 'conversation_idempotency_conflict';
      end if;
      select * into v_conversation from research.max_conversations
        where id = v_message.conversation_id and owner_id = p_owner_id;
      if not found then
        raise exception using errcode = 'P0002', message = 'conversation_not_found';
      end if;
      return pg_catalog.jsonb_build_object(
        'conversation', pg_catalog.to_jsonb(v_conversation),
        'message', pg_catalog.to_jsonb(v_message),
        'inserted', false
      );
    end if;
  end if;

  if p_conversation_id is null then
    insert into research.max_conversations (id, owner_id, title, created_at, updated_at)
      values (p_new_conversation_id, p_owner_id, p_title, p_created_at, p_created_at)
      returning * into v_conversation;
  else
    select * into v_conversation from research.max_conversations
      where id = p_conversation_id and owner_id = p_owner_id for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'conversation_not_found';
    end if;
  end if;

  v_turn_index := v_conversation.next_turn_index;
  update research.max_conversations set
    title = case when next_turn_index = 0 then p_title else title end,
    updated_at = p_created_at,
    next_turn_index = next_turn_index + 1
    where id = v_conversation.id and owner_id = p_owner_id
    returning * into v_conversation;

  insert into research.max_conversation_messages (
    id, conversation_id, owner_id, turn_index, position, role, content, created_at, request_key_hash
  ) values (
    p_message_id, v_conversation.id, p_owner_id, v_turn_index, v_turn_index * 2,
    'user', p_content, p_created_at, p_request_key_hash
  ) returning * into v_message;

  return pg_catalog.jsonb_build_object(
    'conversation', pg_catalog.to_jsonb(v_conversation),
    'message', pg_catalog.to_jsonb(v_message),
    'inserted', true
  );
end;
$$;
revoke all on function research.max_append_conversation_user_message(uuid, uuid, uuid, uuid, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function research.max_append_conversation_user_message(uuid, uuid, uuid, uuid, text, text, timestamptz, text)
  to service_role;

create function research.max_complete_conversation_assistant_message(
  p_owner_id uuid,
  p_conversation_id uuid,
  p_turn_index bigint,
  p_message_id uuid,
  p_content text,
  p_created_at timestamptz,
  p_job_id uuid,
  p_research_id text
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_message research.max_conversation_messages;
begin
  if p_content is null or length(p_content) not between 1 and 12000 then
    raise exception using errcode = '22023', message = 'invalid_conversation_message';
  end if;
  perform 1 from research.max_conversations
    where id = p_conversation_id and owner_id = p_owner_id for update;
  if not found then return false; end if;

  select * into v_message from research.max_conversation_messages
    where conversation_id = p_conversation_id and owner_id = p_owner_id
      and turn_index = p_turn_index and role = 'assistant' for update;
  if found then
    if v_message.job_id is distinct from p_job_id then
      raise exception using errcode = 'P0001', message = 'conversation_answer_idempotency_conflict';
    end if;
    return true;
  end if;

  insert into research.max_conversation_messages (
    id, conversation_id, owner_id, turn_index, position, role, content, created_at, research_id, job_id
  ) values (
    p_message_id, p_conversation_id, p_owner_id, p_turn_index, p_turn_index * 2 + 1,
    'assistant', p_content, p_created_at, p_research_id, p_job_id
  ) on conflict (conversation_id, turn_index, role) do nothing;

  select * into v_message from research.max_conversation_messages
    where conversation_id = p_conversation_id and owner_id = p_owner_id
      and turn_index = p_turn_index and role = 'assistant';
  if not found or v_message.job_id is distinct from p_job_id then
    raise exception using errcode = 'P0001', message = 'conversation_answer_idempotency_conflict';
  end if;

  update research.max_conversations set updated_at = case
    when updated_at < p_created_at then p_created_at else updated_at end
    where id = p_conversation_id and owner_id = p_owner_id;
  return true;
end;
$$;
revoke all on function research.max_complete_conversation_assistant_message(uuid, uuid, bigint, uuid, text, timestamptz, uuid, text)
  from public, anon, authenticated;
grant execute on function research.max_complete_conversation_assistant_message(uuid, uuid, bigint, uuid, text, timestamptz, uuid, text)
  to service_role;
