create or replace function research.max_complete_conversation_assistant_message(
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
