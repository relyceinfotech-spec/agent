import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260929095621_restrict_direct_session_followup_writes.sql",
    import.meta.url,
  ),
  "utf8",
);
const conversationMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20261003155721_conversation_history_v1.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("production security migrations", () => {
  it("removes direct authenticated DML from quota-governed session and follow-up tables", () => {
    expect(migration).toMatch(
      /revoke all privileges\s+on table research\.max_research_sessions, content\.max_post_followups\s+from public, anon, authenticated;/i,
    );
    expect(migration).toMatch(
      /grant select\s+on table research\.max_research_sessions, content\.max_post_followups\s+to authenticated;/i,
    );
    expect(migration).toMatch(
      /create index if not exists max_research_sessions_owner_created_id_idx\s+on research\.max_research_sessions \(owner_id, created_at desc, id desc\);/i,
    );
    expect(migration).not.toMatch(/disable row level security|drop policy/i);
  });

  it("keeps conversation tables owner-bound and backend-only", () => {
    expect(conversationMigration).toMatch(
      /owner_id uuid not null references auth\.users\(id\) on delete cascade/i,
    );
    expect(conversationMigration).toMatch(
      /foreign key \(conversation_id, owner_id\)[\s\S]*on delete cascade/i,
    );
    expect(conversationMigration).toMatch(
      /alter table research\.max_conversations enable row level security/i,
    );
    expect(conversationMigration).toMatch(
      /alter table research\.max_conversation_messages enable row level security/i,
    );
    expect(conversationMigration).toMatch(
      /revoke all on research\.max_conversations, research\.max_conversation_messages\s+from public, anon, authenticated/i,
    );
    expect(conversationMigration).toMatch(
      /grant select, insert, update, delete\s+on research\.max_conversations, research\.max_conversation_messages to service_role/i,
    );
    expect(conversationMigration).toMatch(
      /unique index max_conversation_messages_request_key_idx/i,
    );
    expect(conversationMigration).toMatch(
      /unique index max_conversation_messages_assistant_job_idx/i,
    );
    expect(conversationMigration).not.toMatch(/grant .* to authenticated/i);
  });

  it("serializes chat input atomically and limits assistant completion to service role", () => {
    expect(conversationMigration).toMatch(
      /create function research\.max_append_conversation_user_message[\s\S]*security invoker set search_path = ''/i,
    );
    expect(conversationMigration).toMatch(/pg_advisory_xact_lock/i);
    expect(conversationMigration).toMatch(/conversation_idempotency_conflict/i);
    expect(conversationMigration).toMatch(
      /revoke all on function research\.max_append_conversation_user_message[\s\S]*from public, anon, authenticated/i,
    );
    expect(conversationMigration).toMatch(
      /grant execute on function research\.max_append_conversation_user_message[\s\S]*to service_role/i,
    );
    expect(conversationMigration).toMatch(
      /create function research\.max_complete_conversation_assistant_message[\s\S]*returns boolean/i,
    );
  });
});
