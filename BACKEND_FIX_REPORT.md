# Backend fixes

## Scope

The 14 backend bugs from the audit are addressed in the local code and the new migration. Existing frontend changes were preserved. Tests use local databases and fixture providers; no paid model/search calls, production migration, or deployment was performed.

| Finding                                                               | Fix                                                                                       | Verification                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Private answers in stale shared citation metrics                      | Operation-scoped provider metrics and compact job results                                 | `operation_metrics.test.ts`, citation integration tests |
| Writes from workers with expired or replaced leases                   | Lease checks inside SQLite/PostgreSQL write transactions; owner checks                    | `backend_integrity.test.ts`, PostgreSQL harness         |
| Worker polling stops on terminal database errors                      | Poll loop contains transition failures; expired leases remain recoverable                 | `jobs.test.ts`                                          |
| Detached Post follow-ups                                              | API requests enqueue durable owned jobs with atomic quota and idempotency                 | Follow-up end-to-end tests                              |
| Chat quota races and missing direct/fast replay                       | Durable chat jobs, atomic quota/enqueue, stored response replay                           | Concurrent chat regression and API tests                |
| Competing clarification jobs                                          | One active research job per owner/session, enforced by database index                     | SQLite/PostgreSQL competing-job checks                  |
| Insufficient nonempty fast answers marked complete                    | Completion requires validated citations and complete requested fact coverage              | `fast_lookup.test.ts`                                   |
| React shortcut substitutes current versions for history/date requests | Shortcut restricted to current version-only requests                                      | Historical version/date regressions                     |
| Deleted research resurfaces from retained jobs                        | Owner-scoped tombstones, recreation rejection and fallback filtering                      | SQLite/PostgreSQL deletion regressions                  |
| Terminal jobs leave sessions/SSE pending                              | Read repair projects durable terminal state and tracks child execution generation         | Backend integrity and streaming tests                   |
| Child research survives Post worker shutdown                          | Parent abort signal reaches child research and model calls                                | Parent shutdown regression                              |
| Wrong subscription selected                                           | Prefer unexpired active/trialing subscription, deterministic newest fallback              | `billing_store.test.ts`                                 |
| Extensionless PDF retrieval fails                                     | MIME-based bounded binary retrieval and PDF extraction                                    | `source_retrieval.test.ts`                              |
| Direct export writes bypass API checks                                | Authenticated database clients retain owner reads; service-authorized API performs writes | Export SQL security checks and API tests                |

## Drawbacks addressed

- Provider histories retain at most 200 records while aggregate counters stay accurate.
- Discovery reconsiders eligible saved candidates instead of stranding them.
- Rate counters persist in shared storage. `MAX_TRUSTED_PROXIES` accepts an explicit comma-separated list of proxy IPs/CIDRs; leave it empty when no trusted proxy is configured. Set it to the actual deployment proxies to identify clients correctly behind a reverse proxy.
- Post research reads citation and synthesis metrics from the writer provider.
- The strict latestness evidence requirement remains intentional: incomplete release history does not establish that no newer release exists. Relaxing that requirement without a separate authoritative-current-version policy would reintroduce false success.

## Rollout

Local verification completed: **719 backend tests passed**, API TypeScript checking passed, **13 PostgreSQL integrity checks passed**, and `git diff --check` passed for the backend and database changes.

Applied `supabase/migrations/20261002141248_backend_integrity_fixes.sql` to the linked Signova production database on 2026-10-02 using `supabase db push --linked --skip-vault --yes`. The preceding 11 migrations matched the repository, and the dry run selected only this migration. A subsequent dry run reported no pending migrations. Production had zero jobs and no competing active-session groups before the change.

Hosted verification confirmed all seven functions have service-only execution, security invoker mode and empty search paths; both new tables have RLS and no public-role access; the active-job unique index and deletion trigger are valid; authenticated export reads remain while writes require the service role. A rolled-back verification transaction exercised targeted claiming, stale lease rejection, competing-job rejection, rate counters and deletion protection. REST probes confirmed the research/content write RPCs reach their lease guards and the new tables are accessible to the service client. No verification rows were retained.

All 719 backend tests passed again after the production migration; API typecheck and build passed. The local PostgreSQL harness also passed its 13 checks.

Migration-first deployment temporarily disables export mutations in the old API until the updated API is deployed. The configured Railway project contains the API service following `main`, but no separate Worker service. Durable follow-ups and queued high-effort chat require an updated Worker using the same Supabase database. API and Worker must use this backend version; old workers do not understand the new chat/follow-up payload tasks. Worker provisioning and live API/Worker acceptance are the next operational steps.

Post follow-ups require a running durable worker. Low/medium chat requests can return HTTP 202 when inline work exceeds the short response window; clients must follow the returned session/job as they already do for research.

The local PostgreSQL harness applies all non-vector migrations to an isolated engine with stub authentication roles. Hosted checks above verify the new integrity controls separately. Live model/search output, actual Worker restart recovery, deployment proxy configuration and end-to-end API/Worker behavior remain unverified.

## Upgrade ideas

1. Return a typed synthesis result containing answer, citation validation and evidence coverage, so success does not depend on reading provider metrics afterward.
2. Add job failure/lease recovery telemetry, alerts and an operator view for retries and failed jobs.
3. Add per-user provider spending budgets and retention rules for completed jobs, private answers and deletion markers.

These are proposed next improvements; they are not part of this fix.
