import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260929095621_restrict_direct_session_followup_writes.sql",
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
});
