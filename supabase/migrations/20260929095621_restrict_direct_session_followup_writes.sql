-- Session and follow-up mutations must pass through Fastify, where request
-- validation, ownership checks, and user quotas are enforced. Keep owner-scoped
-- reads available to authenticated users; server-side service_role writes remain
-- available to the API and workers.
revoke all privileges
  on table research.max_research_sessions, content.max_post_followups
  from public, anon, authenticated;

grant select
  on table research.max_research_sessions, content.max_post_followups
  to authenticated;

-- Stable keyset pagination for owner-scoped session history reads.
create index if not exists max_research_sessions_owner_created_id_idx
  on research.max_research_sessions (owner_id, created_at desc, id desc);
