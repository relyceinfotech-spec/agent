# Final Production Hardening v1

**Assessment date:** 2026-09-30
**Decision:** **BLOCKED — do not deploy yet**

This assessment records local code/build checks, Signova database inspection,
the one explicitly approved bounded live smoke, and a later approved
migration-history metadata repair. It is not a deployment approval or a claim
that every external production setting has been validated.

## Executive result

The provider-free API suite passed serially at 635/635 across 64 files; the
focused web API-origin suite passed 5/5. API/web typechecks and API/Next.js
production builds passed with the documented non-routable
`https://api.example.invalid` build value. Prettier and `git diff --check`
passed. The production dependency audit now passes after narrowly pinning the
affected major lines to `fast-uri@3.1.8` and `fast-uri@4.1.5`. Both the
repository-declared pnpm 9.15.4 and the active pnpm 11.19.0 report no known
production vulnerabilities. The lockfile contains those patched versions;
the compatibility overrides are recorded for both the declared pnpm version
and the active pnpm configuration. At the earlier scanner checkpoint, the
registered Codex Security standard scan was
`7b7a7e7e-2e94-4ccc-8dcf-01f71b6b7eaf`, bound to immutable snapshot digest
`codex-security-snapshot/v1:sha256:aa8116d12be6be6c9b197a1ca3069464d39eac841d72177665b5f15a9d81bf80`
at revision `cdb6c5c6f69ed317cc435a40636fbeaba490d810`. That historical
checkpoint is not a sealed current-worktree security result. Its three reviewer
packets are closed and its validation phase reports 2/2 candidate reviews, but
an unsealed `complete:false` checkpoint now preserves seven coverage surfaces
and deferred candidates. No final findings/report artifacts are sealed and the
later security-assurance update records scanner work as operationally
incomplete/canceled. The readiness-document edits in this checkpoint
post-date that immutable scan snapshot; do not describe it as a scan of those
later document changes or as a completed repository-wide result.
A Tahr
focused, source-only access-control review of session, follow-up, and memory
paths has a current-schema artifact that passes structural validation with one
expected no-findings warning; coverage remains incomplete, it is not a
repository-wide or runtime assessment, and exports/shares are separate
candidates.

The existing approved live smoke reached Signova and stopped before the
research worker because similarity was `0.449243`, just below the configured
`0.45` threshold. MAX correctly withheld the memory. That earlier smoke is not
being retried. The two specifically approved migrations were originally
applied to Signova under generated remote versions `20260929200634` and
`20260929200647`; their history metadata has since been reconciled to the
canonical local versions without replaying SQL. Post-migration catalog checks
show owner-scoped RLS remains enabled; authenticated can SELECT
but not INSERT/UPDATE/DELETE sessions or post follow-ups; service_role retains
CRUD on both; and the retained-memory trigger is installed as SECURITY INVOKER.
A bounded Fastify ownership diagnostic passed with temporary users and one
temporary session, including owner read, peer invisibility, and API read
behavior. A provider-free 500-row trigger diagnostic verified the ceiling,
inactive-row counting, and hard-delete slot reuse. Temporary fixtures and
identities were cleaned and checked. No Serper/OpenRouter calls or research
work occurred.

The earlier runner reported no cleanup error, and its separate read-only
database check confirmed zero matching temporary rows. The post-migration
owner diagnostic also verified exact-user cleanup; the cap fixture was removed
inside the SQL diagnostic, its temporary identity was deleted by exact email,
and a follow-up privileged query returned zero memory rows. No final research
acceptance run was made.

### Current-state recheck (2026-09-30)

This checkpoint reran the complete serial API suite (64 files, 635/635), the
five web API-origin tests, API/web typechecks, API and Next.js production
builds, Prettier, and `git diff --check`. The production build used the
non-secret, non-routable placeholder `https://api.example.invalid`; it verifies
build-time URL validation, not the actual Vercel value. The dependency audit
blocker was remediated with version-scoped overrides for `fast-uri@3` → `3.1.8`
and `fast-uri@4` → `4.1.5`; `pnpm why -r fast-uri` confirms those are the only
resolved versions. `pnpm audit --prod` passes under both pnpm 9.15.4 and
11.19.0 with no known vulnerabilities. The repository declares pnpm 9.15.4,
while the host's active `pnpm` binary is 11.19.0; both configurations are
represented so the patched lock graph remains stable across the two tested
versions. The actual host environment and deployment configuration remain
unverified.

At this earlier current-state checkpoint, the active Signova migration ledger
ended with `20260929200634 restrict_direct_session_followup_writes` and
`20260929200647 memory_retained_limit_v1`; see the later history-repair record
below for the verified canonical ledger. The earlier exports migration is
still present. Fresh catalog queries verified that `authenticated` has only
SELECT on research sessions and post follow-ups, no column-level DML grants on
either, while `service_role` retains table CRUD. Both tables and semantic
memories have RLS enabled; existing policies continue to bind `owner_id` to
`auth.uid()` and reject anonymous identities. The memory trigger
`max_user_memories_enforce_retained_limit` is installed and its function is
SECURITY INVOKER with an empty search path, owner check, advisory transaction
lock, and a count of all retained rows excluding the row being updated. The
authenticated memory table still has owner-scoped CRUD as designed. Initial
and final aggregate queries found zero memory rows and zero owners over the
cap. Fresh advisor responses observed on 2026-09-30 at 08:18 UTC report ten
RLS-enabled/no-policy tables, eleven init-plan warnings, six unused-index
notices, and the `public.rls_auto_enable()` SECURITY DEFINER warning. Catalog
inspection confirms the no-policy application tables have no `anon` or
`authenticated` table grants (default deny), so no permissive policy was added
or RLS disabled to silence that advisory. The event-trigger's ACL includes
PUBLIC/anon/authenticated EXECUTE, but it returns the special `event_trigger`
type, is attached to `ddl_command_end`, and a prior read-only direct RPC probe
was rejected by PostgreSQL's event-trigger context. Its provisioning
provenance remains unresolved: no repository migration owns its definition,
and the available database logs did not identify an external provisioner.

## Readiness checklist

| Area                                               | Result                     | Evidence / remaining condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API and web regression                             | PASS, serialized           | This checkpoint: 635/635 API tests across 64 files in a single fork; 5/5 web API-origin tests; API/web typechecks; API and Next.js production builds with `https://api.example.invalid`; root Prettier and readiness Markdown Prettier checks; `git diff --check`. Production dependency audits pass under pnpm 9.15.4 and 11.19.0 after the scoped `fast-uri` fix. A prior parallel run had timing-sensitive failures and is not counted as a pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Production dependency audit                        | PASS                       | `pnpm audit --prod` passes under both the repository-declared pnpm 9.15.4 and active pnpm 11.19.0. The lockfile resolves `fast-uri@3.1.8` through Ajv and `fast-uri@4.1.5` through Fastify/Ajv/JSON serialization; both are the minimum patched versions for the prior advisories. No known vulnerabilities were reported. Overrides are version-scoped and do not change dependency majors. ([GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj), [GHSA-jvvf-x445-j334](https://github.com/advisories/GHSA-jvvf-x445-j334))                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Production secret loading                          | PASS in code               | Compiled API/worker start scripts do not load `.env`; production persistence selects Supabase and requires server configuration. Actual host environment values were not inspected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Request limits and CORS                            | PASS in code; scale caveat | Fastify body limit is 64 KiB; browser CORS is allowlisted from `WEB_URL`. In-process IP rate limiters do not coordinate across replicas. Durable per-user quotas protect metered research/follow-up paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SSRF / outbound fetch                              | PASS in code               | URL validation, DNS address rejection, redirect validation, bounded fetches, and IPv4/IPv6 private-range tests are present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Logging                                            | PASS in code               | Request URL sanitizer redacts share tokens and query values; regression tests cover the sanitizer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Health / readiness                                 | PASS in code               | `/health` is liveness; `/ready` performs a bounded sentinel store lookup rather than loading all sessions. Readiness does not promise provider availability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Durable worker and shutdown                        | PASS locally               | Restart/recovery and graceful-shutdown tests are included in the passing suite. The approved live run did not reach worker execution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Production browser API origin                      | PASS in code; host OPEN    | `next.config.ts` supplies localhost only in development; production builds require a valid HTTPS `NEXT_PUBLIC_API_URL` and reject loopback. The API origin is injected at build time, and the production client bundle contains no `http://localhost:8000` fallback. The local `.env` lacks this key; the production Vercel value remains unverified. Client modules share the validated API-origin helper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Migrations                                         | PASS — HISTORY ALIGNED     | After approved history-only repair, `npx supabase migration list` showed all 11 local and remote versions aligned. The canonical local versions are `20260929095621` and `20260929151139`; generated remote entries `20260929200634` and `20260929200647` are reverted in history. SQL was not replayed, and read-only catalog checks confirmed deployed grants, owner policies, index, memory function, and trigger remain intact. `public.rls_auto_enable()` provisioning provenance remains unresolved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Supabase RLS advisor                               | REVIEWED                   | Ten RLS-enabled/no-policy tables have no `anon`/`authenticated` table grants; they are service-role-only/default-deny by design. No policy was added or RLS disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Supabase function advisor                          | REVIEWED, provenance open  | `public.rls_auto_enable()` is `SECURITY DEFINER`, returns `event_trigger`, uses `search_path=pg_catalog`, and is attached to the `ddl_command_end` event trigger. Direct Data API RPC invocation failed with the expected event-trigger-only error, and `anon`/`authenticated` lack `public` schema CREATE. The advisor warning is not evidence of an ordinary callable RPC exploit; the missing migration provenance remains an operational concern. No remote change was made.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Supabase performance advisor                       | REVIEWED; FRESH 2026-09-30 | Fresh response observed 2026-09-30 08:18 UTC: 11 init-plan warnings and six unused-index notices. Inspected owner policies use scalar subqueries for `auth.uid()`/`auth.jwt()`; one unused index is the session keyset index. Unused-index notices remain informational pending workload data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Authenticated direct database writes and retention | REMOTE CHECK PASS; LIMITED | Authenticated grants on sessions/follow-ups are now SELECT-only and their owner policies remain. Service-role CRUD remains available. The bounded live diagnostic verified one server-mediated session write, owner read, peer denial, and Fastify owner read/404 behavior. It did not create a post-follow-up row through Fastify; its server-role grants are catalog-verified. The retained-memory trigger's 500 boundary, inactive-row counting, and hard-delete slot reuse passed a transaction-safe SQL diagnostic; that diagnostic used the test owner's auth claims but did not exercise a signed PostgREST memory write. These close the two remote grant/cap checks without constituting the final integrated acceptance test. Memory table owner-scoped CRUD remains intentional. This is a same-owner validation/quota/storage-abuse concern, not a cross-owner BOLA finding; RLS remains owner-scoped. `GET /api/research` remains keyset-paginated (default 50, maximum 100). |
| Queued-job history listing                         | LIMITED                    | Detached queued jobs are merged into the first research-history page only to prevent duplicates on later session pages. The separate `/api/jobs` list returns at most 100 newest owner jobs and has no continuation cursor; a caller that already has a job ID can still use `/api/jobs/:id`. A paginated job-list contract remains a low-severity product/API follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Deploy host settings / proxy trust                 | NOT VERIFIED               | No Vercel/Railway project roots, dashboard environment, build/deploy commands, domains, health checks, forwarded-IP behavior, or replica configuration were available. Set and verify `NODE_ENV=production` and `MAX_PERSISTENCE_PROVIDER=supabase` explicitly: source defaults NODE_ENV to development and selects SQLite unless production is active or the provider is set. Fastify does not trust forwarded headers by default; verify Railway ingress client-IP behavior and configure only known trusted proxies. The process-local IP limiter does not coordinate across replicas.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Export/share storage limits                        | P2 CANDIDATE               | Owner RLS remains in force, but Signova exposes authenticated column-level INSERT grants on `content.max_exports` and `content.max_shares`; exports also permit updates to selected payload/size columns and shares permit revocation updates. Per-row export size is capped at 2,000,000 bytes and share expiry at 90 days, but no per-owner aggregate row/byte cap or automatic cleanup was found. This is a same-owner resource-consumption concern (CWE-770), not BOLA. No direct REST abuse/write test or exhaustion test was performed; actual impact is not runtime-confirmed. Decide whether to add aggregate controls or explicitly accept this P2 before deployment.                                                                                                                                                                                                                                                                                                             |
| HTML extraction CPU cost                           | P2 CANDIDATE               | `extractHtml` synchronously rescans descendant paragraphs while sorting overlapping article roots. Fetch size is bounded at 2,000,000 bytes, but the parser runs on the event loop and worst-case CPU amplification has not been benchmarked. This is a source-level availability concern, not a demonstrated exploit. Add a bounded single-pass scorer or benchmark/accept the risk before deployment; no live hostile-input test was run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Public share source URL sanitization               | P3 CANDIDATE               | `apps/api/src/sharing.ts` rejects a fixed set of sensitive query-key names and URL userinfo, but passes the original source URL into public research/post projections. Provider/source URLs containing unrecognized credential keys (for example, `X-Amz-*` signed-URL parameters) may therefore be disclosed to anyone holding the public share link. Search canonicalization strips fragments, so this candidate is limited to query parameters unless another source path preserves them. It is conditional on such a URL entering the source set and an owner sharing it; no credential-bearing source row or live disclosure was observed. Treat as a low-severity source candidate pending focused validation/remediation, not a confirmed secret leak.                                                                                                                                                                                                                              |
| Export QA artifact and local env files             | LOCAL CLEAN; HOST OPEN     | `tmp/exports-v1-review-20260929` is absent locally. `.gitignore`, `.vercelignore`, and `.railwayignore` exclude `tmp/` and `.env` files while allowing `.env.example`. Actual configured monorepo roots/upload mode remain unknown, so host-side exclusion is not proven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tracked/build secret scan                          | PASS, pattern-based        | Tracked environment-file and secret-pattern checks found no credential material; `.env` key names were inspected without printing values, and no secret-like `NEXT_PUBLIC_*` names were present. Build output scan found no secret-pattern matches. This is not proof against every encoded or obfuscated secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Billing provider                                   | DEFERRED                   | Billing/plan logic is locally tested, but no live payment-provider configuration or checkout/webhook flow was part of this assessment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Bounded live-smoke record

- **Outcome:** BLOCKED at authenticated chat memory-recall assertion.
- **Duration:** 10.284 seconds.
- **Temporary fixtures:** one Auth user, one memory, one queued research request/quota fixture.
- **Embedding:** two requests; stored/query model IDs matched; both vectors had 1,536 dimensions.
- **Recall:** candidate was owner-visible and passed metadata/model/dimension filters; similarity `0.449243` was below `0.45`, so it was excluded.
- **Serper / OpenRouter chat:** zero requests.
- **Worker / evidence / citation / post / follow-up:** not reached.
- **Cleanup:** runner reported no cleanup failure; independent read-only SQL returned zero for the exact user, memory, owner sessions, owner jobs, quota rows, and follow-up rows.
- **Retry policy:** no retry. Do not lower the production threshold based on this one borderline fixture result.

## Supabase advisor disposition

The security advisor's `rls_enabled_no_policy` items are treated as intentional
default-deny service-role-only tables after verifying both RLS state and the
absence of `anon`/`authenticated` table grants. The security-definer execution
warnings for `public.rls_auto_enable()` are not treated as exploitable direct
RPC access because its PostgreSQL `event_trigger` return/context prevents an
ordinary Data API invocation; however, the function/event-trigger definition
must be brought under migration/provisioning control or explicitly retired
before a reproducible production setup is claimed. The fresh security advisor
response observed 2026-09-30 08:18 UTC reports ten no-policy tables and the
function warning; the fresh performance response reports 11 init-plan and six
unused-index notices. A read-only log query did not identify the external
provisioner. The two explicitly approved migrations were applied; no other
remote schema change was made.

## Validated security findings

**Medium — authenticated direct writes can bypass API validation/quotas and
consume storage (CWE-770).** This was validated against the deployed grants:
`authenticated` had CRUD on owner-scoped research sessions and post follow-ups,
while quota counters and consumption were service-role-only. RLS prevented
cross-owner access, but direct REST writes could bypass Fastify request
validation and quotas. The local mitigation now routes these writes through the
server-side persistence path and provides a migration that revokes direct DML;
the research list route is keyset-bounded. The approved migration is now applied
and independent catalog checks show `authenticated` has no table- or
column-level DML on sessions/follow-ups, while `service_role` retains CRUD.
The bounded live diagnostic verified the session server-write/owner-read path
and peer isolation. The post-follow-up server write itself remains
catalog-verified, not runtime-tested. No evidence showed direct paid-provider
spend: durable jobs remain server-only and provider work remains guarded by
the API quota path.

The original finding is supported by
[`20260924154756_max_persistence_v1.sql`](../supabase/migrations/20260924154756_max_persistence_v1.sql),
[`20260924201347_auth_ownership_quotas_v1.sql`](../supabase/migrations/20260924201347_auth_ownership_quotas_v1.sql),
[`server.ts`](../apps/api/src/server.ts), and
[`supabase-store.ts`](../apps/api/src/supabase-store.ts). The mitigation is in
[`20260929095621_restrict_direct_session_followup_writes.sql`](../supabase/migrations/20260929095621_restrict_direct_session_followup_writes.sql)
and remote migration `20260929200634`; the grant and owner-path checks now pass
for sessions. Follow-up grants are verified but a live Fastify follow-up write
was not exercised. Mark the direct authenticated DML path mitigated at the
database grant layer, with that narrower server-write verification limitation
visible. Owner RLS remains enabled; the original concern was same-owner bypass
of Fastify validation/quota, not BOLA.

**Medium — authenticated users could accumulate inactive semantic-memory rows
under the prior trigger (CWE-770; retained-row cap remediated).** The original memory migration
grants authenticated CRUD and counts only active rows, so unique inactive rows
can bypass that old 500-active-row ceiling. This is same-owner storage
consumption, not cross-user access or direct provider spend. The user selected
a 500-row retained cap counting active and inactive rows; hard deletion frees a
slot. Local application checks and
[`20260929151139_memory_retained_limit_v1.sql`](../supabase/migrations/20260929151139_memory_retained_limit_v1.sql)
implement it with deterministic tests and it is now applied remotely as
`20260929200647`. The installed SECURITY INVOKER trigger passed a bounded,
provider-free 500-row diagnostic: row 501 was rejected; setting all 500 rows
inactive did not free capacity; hard-deleting one row permitted one replacement;
all diagnostic rows were deleted and independently read back as zero. The test
used a temporary owner and controlled auth-claim context, not a signed
PostgREST insertion. No P1 remote cap blocker remains from this finding; the
application's signed-client/RLS memory insertion path remains covered by local
tests and catalog policy inspection, not by this cap diagnostic.

**P2 — authenticated users can accumulate export/share storage outside Fastify
(CWE-770).** Fresh read-only Signova checks confirmed that the PostgREST
`authenticator` role exposes `content`, authenticated users have column-level
INSERT grants on `content.max_exports` and `content.max_shares`, and owner-scoped
RLS policies remain enabled. Export UPDATE grants include `payload_base64` and
`output_bytes`; the pending-to-completed policy and table constraints permit a
completed payload up to 2,000,000 bytes per row. The caller can supply distinct
resource IDs and snapshot hashes, so the per-value uniqueness constraint is
not an aggregate quota. Share rows can also be inserted without an aggregate
cap; their 90-day expiry is logical and does not delete the row. This direct
Data API path bypasses Fastify's resource validation and any API-layer request
controls. Owner RLS prevents cross-owner writes, and per-row size/format checks
remain effective, but no per-owner total-row/byte limit or automatic cleanup
was found. No direct REST write or exhaustion test was run; the impact is a
source/catalog-validated shared-database storage-growth risk, not a demonstrated
outage. Consider revoking direct authenticated mutations and enforcing bounded
API-side quotas plus retention cleanup. The focused Tahr access-control
artifact explicitly excludes sharing and exports, so this is not a Tahr
runtime finding.

**P2 candidate — synchronous HTML extraction can amplify CPU work.**
`apps/api/src/extract.ts` computes paragraph text and scores nested/overlapping
article roots repeatedly from sort comparators, then scores candidates again.
The normal fetch path caps the downloaded body at 2,000,000 bytes, but Cheerio
parsing/scoring is synchronous on the event loop, so a timer-based research
deadline cannot interrupt CPU-bound parsing until the event loop yields. A
provider-free direct-call probe using valid generated HTML measured 63,026-byte
nested article markup at 1,171.7 ms versus 40.3 ms for a same-size sibling-
article control; 12,626-byte and 31,526-byte nested cases took 69.2 ms and
221.8 ms. This confirms local CPU amplification in the parser, not production
denial of service: the probe did not exercise authenticated enqueue, provider
discovery, deployed worker concurrency, or queue impact. Treat it as a P2
availability candidate; consider a bounded single-pass score/cache and verify
worker-level impact before deployment or document explicit risk acceptance.

For the deployment gate, the two approved migrations and their database grant,
owner-read, server-session-write, and retained-cap checks are complete. The
post-follow-up server write was not runtime-exercised. These results do not
clear unrelated provisioning, deployment-host, or final integrated acceptance
blockers.

## Deployment gate

Keep this milestone **BLOCKED**. Before deployment:

1. Put the `rls_auto_enable()` event-trigger definition under reproducible
   migration/provisioning control and rerun the advisors afterward.
2. Verify actual Vercel/Railway project roots, environment variables, service
   commands, domains, health checks, forwarded-IP behavior, and replica topology.
3. Confirm actual deployment upload roots exclude `tmp/` and `.env` files; the
   local QA artifact has been removed, but host-side configuration is unknown.
4. Decide whether to remediate or explicitly accept the P2 export/share
   persistent-storage accumulation and synchronous HTML extraction CPU
   candidates. Do not represent either as cross-owner access or runtime-proven
   exploitation.
5. Revisit process-local IP limits if deploying multiple replicas; use an
   upstream/shared limiter where cross-replica enforcement is required.
6. After the remaining host/provisioning
   checks, obtain fresh explicit authorization for exactly one bounded final
   live acceptance gate. Do not retry the previously consumed memory-recall
   smoke automatically or lower the `0.45` similarity threshold.

## Tahr focused access-control review

The current-schema, focused report is
[`access-control-review-current.json`](../.tahr-review/access-control/access-control-review-current.json).
The older detailed artifact
[`access-control-review.json`](../.tahr-review/access-control/access-control-review.json)
is preserved as historical evidence, but the installed Tahr 0.3.3 validator
rejects its legacy shape with seven structural errors. The current artifact
passes the installed validator with one expected warning because it contains
no promoted findings; its coverage gaps and four candidates are explicit. It
is not run with `--strict` and does not claim deep clearance.

The review models Fastify and direct PostgREST paths for sessions,
follow-ups, and semantic memory. It is explicitly `source_only` and `focused`:
it does not prove runtime authorization or migration behavior. Later remote
catalog and bounded owner diagnostics are separate evidence and do not update
the Tahr canonical artifact. The independent
challenger corrected the browser client path to
`apps/web/app/supabase-browser.ts` and distinguished same-owner workflow or
retention bypass from cross-owner access. This Tahr artifact does not cover
exports/shares; the newly recorded storage-growth candidate is based on
read-only catalog and source evidence, is not a Tahr finding, and was not
runtime tested. No callable Tahr MCP review tool was available in this session
to extend that artifact.

## Tahr secrets and configuration coverage

The repository-scoped configuration pass found no application-owned literal
provider key in the inspected source. Three high-signal pattern matches were
reviewed without printing their contents: two are deliberately fake
test-only bearer/password fixtures; the third is a variable reference to
`config.SUPABASE_SECRET_KEY`, not a key value. The local `.env` exists but was
not read, is ignored by Git/build-upload ignore rules, and is not tracked; only
`.env.example` documents blank secret variables and local development values.
The browser receives only Supabase's publishable key and configured API origin.
`MAX_ADMIN_TOKEN` absence fails closed for admin routes.

Source controls include allowlisted CORS origins, development-only localhost
origins, request URL redaction, and SSRF/DNS/redirect/fetch bounds. No Docker,
Kubernetes, Terraform, or repository CI workflow configuration was found in
the inspected root; external Vercel/Railway CI, IAM, runtime environment,
network-egress policy, replica count, and proxy topology are not visible here.
These are coverage gaps, not passes. `pnpm audit --prod` passed in the local
verification set; this note does not claim a new live CVE reachability audit.

One deployment configuration candidate remains important: because the API
schema defaults `NODE_ENV` to `development` and persistence selects SQLite
unless production is active or explicitly overridden, the actual Railway
service must set `NODE_ENV=production` and use Supabase persistence. The source
fallback is not evidence that Railway is misconfigured; dashboard settings
were unavailable. Verify these exact values before deployment.

No deployment or final integrated live acceptance run was performed. The two
explicitly approved production migrations and their narrowly bounded
verification fixtures were performed as documented above.

## Remediation milestone result

**PRODUCTION HARDENING REMEDIATION V1 — BLOCKED**

- **PASS — approved Signova migrations:** remote ledger versions
  `20260929200634` and `20260929200647` are present. Authenticated session and
  follow-up grants are SELECT-only, service-role CRUD remains, and owner RLS is
  intact. A temporary owner diagnostic verified server-mediated session
  creation/read, owner read, peer invisibility, and Fastify owner/peer
  behavior. A no-provider retained-cap test verified 500 retained rows,
  inactive-row accounting, hard-delete slot reuse, and cleanup. Live Fastify
  follow-up creation was not separately exercised.
- **PASS — local remediation:** API-only session/follow-up writes and the
  selected 500-row retained-memory cap are implemented locally. The cap counts
  active and inactive rows; deletion frees a slot. This checkpoint passed the
  full serial API suite (635/635), web API-origin tests (5/5), typechecks,
  production builds, Prettier, and `git diff --check`.
- **PASS — production dependency audit:** exact major-scoped overrides resolve
  `fast-uri@3.1.8` and `fast-uri@4.1.5`; both pinned and active pnpm production
  audits report no known vulnerabilities. The changes are limited to
  `package.json`, `pnpm-workspace.yaml`, and the lockfile.
- **P2 — provisioning provenance:** `public.rls_auto_enable()` remains outside
  repository migrations; establish its controlled provisioning source or
  explicitly retire it before claiming reproducible database setup.
- **UNVERIFIED — deployment:** Vercel/Railway roots, actual secret/environment
  values, `NODE_ENV=production`, Supabase persistence selection, ingress/proxy,
  replicas, and host upload roots were unavailable. Local `.env` content was
  not read; no deploy was performed.
- **UNVERIFIED — final live gate:** the prior memory-recall smoke is not being
  repeated. After the remaining deployment checks, obtain fresh explicit
  authorization for one bounded final acceptance run.
- **P2 candidates — not runtime-confirmed:** owner-authorized export/share
  rows lack aggregate retention caps/cleanup; synchronous article extraction
  repeatedly scores nested subtrees. Decide to remediate or accept before
  deployment. No BOLA or resource-exhaustion exploit was demonstrated.
- **INCOMPLETE — Codex Security:** registered scan
  `f7153756-9bc7-4257-b765-2e5ce1a5551c` is bound to target revision
  `cdb6c5c6f69ed317cc435a40636fbeaba490d810` and immutable digest
  `codex-security-snapshot/v1:sha256:3d224f1c3de89f006f62dfc0d236dd4a96be041cd76f9e00b68568c52b64ed95`.
  The latest workbench check still reports 8/9 review receipts and 4/9
  coverage rows closed across 212 files; no sealed report is available. No
  continuation or execution thread was exposed in this session. Its progress
  timestamp remains `2026-09-30T11:19:25.745453Z`. Do not treat the scan as
  complete. The dated verification note below was written after the immutable
  snapshot and is not covered by that scan.

## Current verification refresh — 2026-09-30

This dated refresh records read-only checks against the current checkout and
the connected Signova project. It supersedes older timestamps above where
they differ; it does not seal or replace the registered Codex Security scan.

- **Signova migrations and grants — verified:** project
  `atntvlkwchxavnjkthjv` is active/healthy. The migration ledger contains
  `20260929200634 restrict_direct_session_followup_writes` and
  `20260929200647 memory_retained_limit_v1`. Catalog checks show authenticated
  session and post-follow-up SELECT only, no authenticated INSERT/UPDATE/
  DELETE, and service-role CRUD. The existing owner policies remain enabled.
- **Memory retention — catalog verified:** the BEFORE INSERT/UPDATE trigger
  counts all owner rows (not only active rows), takes a per-owner transaction
  advisory lock, and rejects writes at 500 retained rows. The current
  read-only check confirms the trigger/function definition; the earlier
  transaction-safe boundary diagnostic remains the runtime evidence for
  inactive-row counting and slot reuse.
- **Fresh security advisor — disposition:** the advisor still reports ten
  RLS-enabled tables without policies. Direct catalog checks show none of
  those ten grant table privileges to `anon` or `authenticated`; service-role
  access is present. The `public.rls_auto_enable()` SECURITY DEFINER warning
  remains. It is attached to the enabled `ddl_command_end` event trigger and
  has `pg_catalog` search path; `anon` and `authenticated` still have EXECUTE
  privilege, while the prior direct RPC attempt failed as event-trigger-only.
  No matching provisioning definition exists in repository migrations/source,
  so its authoritative provisioning provenance remains UNVERIFIED. No remote
  change was made. The security-advisor snapshot was observed at
  `2026-09-30T12:12:47Z`.
- **Fresh performance advisor — informational:** observed 11 auth/RLS
  initialization-plan warnings and six unused-index notices. These remain
  performance/workload items, not evidence of a newly introduced security
  bypass; no index or policy changes were made. The snapshot was observed at
  `2026-09-30T12:24:00Z`.
- **Deployment boundary — locally verified, host UNVERIFIED:** `.gitignore`,
  `.vercelignore`, and `.railwayignore` exclude `.env` files and `tmp/`, while
  `.env.example` is allowed; `tmp/exports-v1-review-20260929` is absent. No
  Vercel/Railway service configuration file or dashboard integration was
  available, so project roots, actual environment values, build/deploy
  commands, domains, ingress/proxy behavior, replicas, and upload roots remain
  UNVERIFIED. The local `.tahr-review/` directory is untracked and is not
  excluded by Git, `.vercelignore`, or `.railwayignore`; if a deployment uploads
  the repository root, those assessment artifacts could be included. The
  deployment path is unknown, so this remains a conditional artifact-boundary
  risk; no local review files were deleted or changed.
- **Local verification — PASS with a build caveat:** `pnpm audit --prod`
  reports no known vulnerabilities; API tests pass 635/635; web API-origin
  tests pass 5/5; API/web typechecks pass. API and Next.js production builds
  pass when the build receives the temporary placeholder
  `NEXT_PUBLIC_API_URL=https://api.example.invalid`. A build without that
  required variable fails as designed. This validates compilation only; it
  does not verify the real Vercel API origin. Formatting and diff checks are
  recorded after this documentation-only refresh. pnpm warns that the
  duplicate `pnpm.overrides` field in `package.json` is ignored; the effective
  overrides are in `pnpm-workspace.yaml`, and the lockfile resolves
  `fast-uri` to 3.1.8 and 4.1.5.
- **P2/P3 dispositions remain open:** export/share aggregate storage growth
  and synchronous HTML extraction CPU are P2 candidates; public-share source
  URL query sanitization is a P3 candidate. None was remediated or explicitly
  accepted here. No final live acceptance, provider call, or deployment was
  performed; obtain fresh explicit authorization only after the remaining
  hardening checks are complete.

The exact remaining live checks and stop conditions are listed above. This
remediation result is not production approval and does not authorize deployment.

## Security assurance fallback refresh — 2026-09-30

The later Codex Security attempt is now recorded as operationally failed, not
pending: the original scan remains orphaned/unsealed; the fresh current-worktree
scan was canceled after 20m52s with 0/212 coverage rows closed and no report
artifact. No third scan or Tahr review was started. This does not constitute
security clearance.

A bounded source/test and read-only Signova catalog review was completed and
recorded in
[production-security-assurance-v1.md](production-security-assurance-v1.md).
It is a fallback, not a substitute for repository-wide scanner coverage. The
current unignored inventory contains 215 files; not every file received a
line-by-line review. The fallback's serialized API suite (635/635), focused web
tests (5/5), typechecks, production builds (Next build with a placeholder API
origin), `pnpm audit --prod`, Prettier, and `git diff --check` passed.

The disposition is **SECURITY ASSURANCE FALLBACK — READY FOR FINAL DEPLOYMENT
REVIEW**, not deployment approval. Open items include share/export aggregate
retention (P2), extraction CPU amplification (P2 candidate), signed-source-URL
filtering (P3 candidate), `rls_auto_enable()` provenance and Data API boundary,
deployed migration-history provenance, and Vercel/Railway roots, environment,
proxy, and replica settings. No final live acceptance or deployment was run.

## Final deployment review v1 — 2026-09-30

**Decision: FINAL DEPLOYMENT REVIEW — BLOCKED.** This section is the latest
deployment-review disposition and supersedes older open/undecided P2/P3 rows
above. No provider/live acceptance run or deployment was performed. The only
remote mutation in this continuation was the explicitly approved Supabase
migration-history metadata repair described below; it changed no application
SQL or database objects.

### Deployment and provisioning status

- **PASS — migration history reconciliation:** the current
  Signova project `atntvlkwchxavnjkthjv` is ACTIVE_HEALTHY on PostgreSQL
  17.6.1.166. Read-only inspection established the exact mappings:
  `20260929095621_restrict_direct_session_followup_writes.sql` maps to remote
  `20260929200634 restrict_direct_session_followup_writes`, and
  `20260929151139_memory_retained_limit_v1.sql` maps to remote
  `20260929200647 memory_retained_limit_v1`. For each migration, the remote
  statement has the same character length and MD5 as the local SQL after LF
  normalization and trimming the terminal newline (720 / `93494a3803a01aa5dcea019e6355aa73`; 1770 / `ff9048103f18e4ed9601e6715489bb55`). The live session/follow-up grants and owner policies, session index, retained-memory trigger, and function body were also checked against the files. Thus the SQL/name mapping is proven; timestamp history was the remaining issue.
  Before repair, the full local and remote inventories each contained 11
  migrations: the first nine version/name pairs agreed, and the final two
  names/statements agreed while their version timestamps differed. The
  history-only repair below reconciled those final two versions.
  The exact approved commands were executed after re-reading the remote ledger:
  `npx supabase migration repair 20260929095621 20260929151139 --status applied`
  and `npx supabase migration repair 20260929200634 20260929200647 --status reverted`.
  Post-repair `npx supabase migration list` and connected migration metadata
  showed all 11 local/remote versions aligned. The generated remote entries
  were removed and the canonical local versions marked applied. These were
  history-only operations: no `db push`, migration SQL replay, rollback, or
  manual SQL was run. A read-only catalog recheck found session/follow-up
  grants, owner RLS policies, the session index, and the memory retained-limit
  function/trigger intact. No other migration-history entry changed. Future
  schema changes should use reviewed, committed local files and the standard
  CLI workflow.
- **UNVERIFIED — `public.rls_auto_enable()` provenance:** the function/event
  trigger `ensure_rls` is live, enabled for `ddl_command_end`, and owned by
  `postgres`; its SECURITY DEFINER function has `search_path=pg_catalog`. The
  function ACL includes PUBLIC, `anon`, and `authenticated`; a prior direct
  RPC probe was rejected in event-trigger context. No repository migration or
  authoritative external provisioning record was found. Classification:
  **A (repository-managed) not established; B (external/provisioner-managed)
  is the best-supported hypothesis but remains unverified; C (safely removable)
  is not selected** because the active trigger enforces RLS on new public
  tables and no replacement lifecycle was verified. Retain it; do not remove
  or recreate it speculatively. Obtain its owner/provisioning source before
  claiming reproducible database setup.
- **UNVERIFIED — Vercel and Railway:** this environment has no Vercel or
  Railway project-configuration connector, and no project dashboard values
  were available. Actual project/service identity, monorepo roots, build and
  deploy commands, `NEXT_PUBLIC_API_URL`, `NODE_ENV=production`,
  `MAX_PERSISTENCE_PROVIDER=supabase`, worker startup, domains, health checks,
  forwarded-IP trust, and replica counts remain unverified. Local source
  defaults are not proof of hosted settings. Locally, `PORT` defaults to
  8000 and accepts the host-provided value; API and worker have separate
  `start`/`worker:start` scripts; graceful SIGINT/SIGTERM handling and
  `/health`/`/ready` handlers exist. These code facts do not prove that a
  Railway worker is configured or that either endpoint is externally routed.
- **UNVERIFIED — rate-limit topology:** the IP limiter is process-local and
  Fastify does not trust forwarded headers by default. No replica count or
  proxy behavior was verified. Do not add Redis or another shared limiter
  speculatively: if deployment is single-replica, document that assumption;
  if it is multi-replica or proxy IP attribution is unsuitable, require an
  upstream/shared limiter and explicitly trusted proxy configuration.
- **UNVERIFIED — artifact boundary:** local ignore files exclude `.env*`
  except `.env.example`, and `tmp/`; the historical export QA artifact is
  absent. `.tahr-review/` and `apps/api/evaluation-results/` currently exist
  locally and are not excluded by `.vercelignore` or `.railwayignore`. If a
  deployment packages the repository root, those review/evaluation files may
  be included. Because the actual provider root and upload method are unknown,
  neither safety nor exposure is claimed. Inspect the exact host artifact/root
  before the final gate.
- **PASS — Signova owner controls (scope-limited):** post-repair read-only catalog checks
  confirmed authenticated SELECT-only access to sessions/follow-ups with
  owner RLS, service-role CRUD, the expected session index, and the retained-
  memory cap trigger/function. This confirms deployed object state remains
  intact after metadata-only repair; `rls_auto_enable()` provisioning
  provenance remains unverified.

### Residual-risk decisions

- **P2 — export/share storage growth: C, defer.** No aggregate per-owner row or
  byte cap/retention cleanup was found for owner-authorized export/share rows.
  Current read-only counts were zero; no cross-owner access issue was found.
  Defer to `Pre-GA Storage Quotas and Retention v1`; before public/general
  availability, add aggregate caps, expiry/cleanup monitoring, and ensure
  writes pass validated API controls. Risk owner: product/deployment owner.
- **P2 — HTML extraction CPU amplification: C, defer.** The local nested-markup
  benchmark establishes parser CPU amplification, not production denial of
  service. Defer to `HTML Extraction CPU Bounds v1` before public/general
  availability; cap traversal/scoring work and add a reproducible performance
  regression. Risk owner: platform owner.
- **P3 — signed source URL exposure: A, minimally remediated.** The shared
  research/post projection rejects known AWS S3, Google Cloud Storage, Azure
  SAS, legacy AWS/Google, generic token/signature, and Tencent COS signing
  query keys. Ordinary query parameters and `x-amz-meta-*` are preserved.
  Provider-free regression coverage exercises both public projection paths,
  including encoded AWS keys and Tencent COS capability parameters. Opaque
  path tokens and unknown provider-specific formats are not universally
  detectable; treat those as residual unverified cases, not as covered.
- **P2/P3 and scanner status:** P2 items are deferred, not accepted for broad
  public availability. The Codex Security scans remain operationally
  incomplete/canceled and are not security clearance. The bounded fallback
  review established no P0/P1 in the inspected evidence, but does not prove
  that none exist repository-wide.

### Local verification for this review

The source/test change adds a signed-query URL filter and deterministic sharing
coverage. The full serial API suite passed **636/636** across 64 files; the
focused sharing suite passed **7/7**; focused web API-origin tests passed
**5/5**; API/web typechecks, API production build, and Next.js production
build passed (the Next build used the documented placeholder origin
`https://api.example.invalid`); `pnpm audit --prod` found no known
vulnerabilities; Prettier and `git diff --check` passed. The placeholder is
not the production API origin. These checks do not verify the production API
origin or any Vercel/Railway setting.

### Prepared final live gate — NOT RUN

Fresh explicit user authorization is required before execution. When
authorized and after resolving the deployment/provisioning blocker, execute
one run only:

1. Preflight the actual Vercel/Railway roots, required production environment
   settings, worker service, ingress/proxy behavior, and migration history.
   Stop before writes if any required target/configuration is ambiguous.
2. Create one temporary Auth identity. If the create response is uncertain,
   reconcile that exact email before taking any further action; never blindly
   create a second identity.
3. Create exactly one relevant temporary memory and verify owner-scoped write,
   readback, and recall using the configured `0.45` threshold. Do not lower the
   threshold or repeat an uncertain embedding request. If recall fails, stop
   before research/provider work and record the observed score/filters.
4. Submit one authenticated, non-deep durable research job through the worker.
   Use the already-prepared integrated runner without changing production
   budgets: one worker attempt, four research steps, exactly one Serper query,
   at most two sources/pages, a 90-second research-session ceiling, two model
   decisions, a 25-second OpenRouter request cap, and at most two embedding
   requests with a 10-second request cap. No Deep Research and no retries
   beyond the configured policy. Use the canonical question: “Investigate the
   latest stable React release using official React release sources; verify
   the version and release date, then cite the supporting evidence.” Capture
   job transitions, provider requests/usage, retrieval/evidence/verifier/
   citation outcomes, persistence, and owner readback.
5. Only if research succeeds, create at most one temporary post from that
   result and publish only if the existing quality gate passes. The prepared
   integrated runner tests this quality-gated post projection and authenticated
   follow-up; it does not perform a separate autonomous topic-discovery run.
   If publication succeeds, execute one authenticated follow-up, create one
   share link and resolve it once, then make one each of Markdown, JSON, and
   PDF exports from the temporary research result. Do not start another
   research or Post Agent discovery job for these no-provider checks.
6. Clean all temporary sessions, jobs, quota rows, memory, post/follow-up,
   share, and export records, then independently query the exact temporary
   owner for zero leftovers. Reconcile uncertain deletes and do not retry the
   full run.

Any provider, verifier, quality-gate, owner-read, cleanup, or environment
failure ends this single attempt as BLOCKED; no automatic repeat is allowed.
No live gate or deployment was performed in this review.

### Final decision

**FINAL DEPLOYMENT REVIEW — BLOCKED**

The migration-ledger blocker is resolved: all 11 local/remote versions align
after the approved history-only repair, with no SQL replay or database-object
changes. Highest-priority remaining blocker: actual Vercel/Railway production
configuration and deployment/upload roots are unavailable for verification,
including API origin, worker service, proxy/forwarded-IP behavior, and replica
count. `rls_auto_enable()` provisioning provenance also remains unverified.
Obtain read-only hosting and provisioning evidence before requesting fresh
authorization for the final live gate. The final live gate has not run. Do not
deploy.

## Final deployment review v2 — host evidence intake — 2026-10-01

**Decision: FINAL DEPLOYMENT REVIEW — BLOCKED.** This was the initial
point-in-time host-evidence snapshot. The table below records what was known
before a Railway read-only connector became available; the later live-host
recheck below supersedes its Railway rows only. Vercel settings remain
unverified. Repository intent is not treated as proof of deployed settings.
No deployment, search/model provider call, or database write was performed.
Separately, while finishing the preceding Research Chat task, the serialized
provider-free API suite passed 640/640; that result is not evidence of hosted
configuration.

| Area                                                                     | Status                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Remaining action                                                                                                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel project, repository, root, install/build/framework/output, domain | UNVERIFIED                                           | No dashboard evidence or Vercel project manifest/link metadata was available. README describes `apps/web` as the intended app root and `pnpm build` as the workspace build.                                                                                                                                                                                                                                                                                                                                                                                               | Provide read-only Vercel project settings or restore dashboard access.                                                                                              |
| Vercel production/preview/development variables and scopes               | UNVERIFIED                                           | No hosting variable names/scopes were inspectable. Never expose values. `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are repository-documented client variables only.                                                                                                                                                                                                                                                                                                                                                    | Confirm each variable is configured in the intended scopes; verify the API origin is the production HTTPS API without disclosing values.                            |
| Railway API project/service, root, build/start, domain, health checks    | UNVERIFIED                                           | No dashboard evidence or Railway manifest/link metadata was available. Repository scripts and README describe the intended API start path and `/health`/`/ready` routes only.                                                                                                                                                                                                                                                                                                                                                                                             | Provide read-only Railway API service settings and externally configured health-check path.                                                                         |
| Railway API production variables/scopes                                  | UNVERIFIED                                           | Actual configured names/scopes and values were unavailable. The documented contract requires production mode, Supabase persistence, Supabase URL/server-only secret/publishable key, Serper/OpenRouter keys, `PORT`, `APP_URL`, and `WEB_URL`; no secret values were read.                                                                                                                                                                                                                                                                                                | Verify required names/scopes and effective production values in Railway without printing secrets.                                                                   |
| Railway worker service and isolation                                     | UNVERIFIED                                           | No evidence establishes a separate worker service, its root/build/start command, environment, replica count, or that API replicas do not start workers. `worker:start` is documented in the repository.                                                                                                                                                                                                                                                                                                                                                                   | Verify the separate service uses `pnpm --filter @research-max/api worker:start` and confirm replica/service isolation.                                              |
| Production API origin, health/readiness routing                          | UNVERIFIED at host                                   | Local source/documentation describes the API origin contract and handlers, but no production URL or host health-check configuration was available.                                                                                                                                                                                                                                                                                                                                                                                                                        | Confirm `NEXT_PUBLIC_API_URL`, API domain, and `/health`/`/ready` routing from host settings.                                                                       |
| Proxy / forwarded-IP behavior                                            | UNVERIFIED at host                                   | Prior source audit records process-local IP rate limiting and Fastify not trusting forwarded headers by default. No ingress behavior or proxy configuration was observable.                                                                                                                                                                                                                                                                                                                                                                                               | Verify the ingress path and client-IP behavior; record the actual replica topology before deciding whether shared rate limiting is needed.                          |
| Replica counts                                                           | UNVERIFIED                                           | No Vercel or Railway deployment settings were accessible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Record production replica/instance counts for API and worker.                                                                                                       |
| Artifact boundary / effective ignores                                    | PARTIALLY VERIFIED locally; host behavior UNVERIFIED | `.vercelignore` and `.railwayignore` exclude `.env`, `.env.*` except `.env.example`, and `tmp/`; neither excludes `.tahr-review/` or `apps/api/evaluation-results/`. Both ignore files are untracked in the current worktree, so they are not part of a Git deployment unless committed. `.gitignore` excludes `apps/api/evaluation-results/` but does not exclude `.tahr-review/`. Both directories currently exist; `tmp/exports-v1-review-20260929` does not. The actual provider root and upload mode are unknown, so effective deployed inclusion cannot be claimed. | Verify each host’s actual root and Git-vs-local upload method; inspect its effective ignore behavior before the final gate. Do not delete artifacts in this review. |
| `public.rls_auto_enable()` deployed metadata                             | VERIFIED — object state only                         | Read-only Signova catalog query (project `atntvlkwchxavnjkthjv`) found trigger `ensure_rls`, event `ddl_command_end`, enabled state `O`, trigger/function owner `postgres`, function `public.rls_auto_enable()`, `SECURITY DEFINER`, `search_path=pg_catalog`, no trigger/function comments, and no extension ownership.                                                                                                                                                                                                                                                  | No object change requested. Metadata does not establish who provisioned it.                                                                                         |
| `public.rls_auto_enable()` provisioning provenance                       | UNVERIFIED                                           | The current catalog has no comments or extension ownership marker; repository search found no canonical provisioning definition in migrations or inspected infrastructure paths. The live object’s owner is not proof of its provisioning source.                                                                                                                                                                                                                                                                                                                         | Obtain authoritative Supabase/provisioner/infrastructure ownership evidence; retain the trigger and do not recreate/remove it speculatively.                        |
| P2 export/share storage growth                                           | DEFERRED — pre-GA                                    | Existing review disposition is `C, defer`; no new runtime acceptance was performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Track aggregate storage caps/retention and cleanup monitoring before public/general availability.                                                                   |
| P2 HTML extraction CPU amplification                                     | DEFERRED — pre-GA                                    | Existing review disposition is `C, defer`; no new performance test was performed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Track bounded traversal/scoring work and a reproducible performance regression before public/general availability.                                                  |
| P3 signed-source URL residuals                                           | PARTIALLY REMEDIATED; residual unknowns remain       | Existing review records filtering for known provider signing keys and preserves ordinary parameters; opaque path tokens and unknown provider formats remain unverified.                                                                                                                                                                                                                                                                                                                                                                                                   | Keep residual limitation explicit; do not claim universal sanitization.                                                                                             |
| Repository-wide security scanner                                         | INCOMPLETE — not clearance                           | Existing Codex Security scans remain orphaned/unsealed or canceled; this pass did not start another scanner.                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Do not claim repository-wide security clearance.                                                                                                                    |
| Final live acceptance / deployment                                       | NOT RUN / NOT AUTHORIZED HERE                        | No provider calls, live acceptance, or deployment occurred in this review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Resolve hosting/provisioning evidence and obtain fresh explicit authorization before the single bounded gate.                                                       |

The initial snapshot's remaining primary blocker was **actual
Vercel/Railway configuration and artifact-boundary evidence**.
`rls_auto_enable()` provisioning provenance was also unresolved. See the
subsequent live-host recheck below; this review does not mark deployment
readiness.

## Live host configuration recheck — 2026-10-01

**Decision: FINAL DEPLOYMENT REVIEW — BLOCKED.** Read-only inspection used the
connected Railway integration and Signova database catalog. The likely MAX
Railway project is `exciting-laughter` because it contains services named
`@research-max/api` and `@research-max/web`; a separate `relyceai_chat` project
also exists, so production-project ownership should be confirmed. The Vercel
integration was discoverable but not connected, and no Vercel dashboard
settings were obtained. No secret values were read or reported. No deployment,
provider call, or database mutation occurred.

| Area                                                    | Status                                  | Current read-only evidence                                                                                                                                                                                                                                                                                                                              | Remaining action                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel project, repository, root/build/framework/domain | UNVERIFIED                              | Vercel integration is available but not connected; no project settings were accessible.                                                                                                                                                                                                                                                                 | Connect Vercel read-only access or provide dashboard evidence.                                                                                                                                                                                                                  |
| Vercel production/preview/development variables         | UNVERIFIED                              | Names, values, and scopes were not accessible.                                                                                                                                                                                                                                                                                                          | Verify required public variable names/scopes without exposing values.                                                                                                                                                                                                           |
| Railway project identity                                | PARTIALLY VERIFIED                      | Candidate `exciting-laughter`, production environment; matching API/web service names. Another Railway project `relyceai_chat` exists.                                                                                                                                                                                                                  | Confirm this candidate is the intended production project.                                                                                                                                                                                                                      |
| Railway API source/root/build/start                     | VERIFIED — current config               | Git source `relyceinfotech-spec/agent`, branch `main`; root directory is not set in the service config; build `pnpm --filter @research-max/api build`; start `pnpm --filter @research-max/api start`.                                                                                                                                                   | Configure/verify the intended production root and start behavior.                                                                                                                                                                                                               |
| Railway API public route and health checks              | BLOCKED — absent in current config      | API has only a private-network endpoint; no service/custom domain and no healthcheck path were returned. `/health` and `/ready` are application routes, not proof of host health-check configuration.                                                                                                                                                   | Configure and verify the production API domain and health/readiness checks.                                                                                                                                                                                                     |
| Railway API environment                                 | BLOCKED — required app variables absent | Production service variable listing returned only Railway-provided variables; no app-specific variable names were configured. Values were withheld. This leaves production mode, Supabase persistence/credentials, provider keys, `PORT`, `APP_URL`, and `WEB_URL` unverified/absent at this service scope.                                             | Configure required production variables using the proper scopes; verify names and non-secret mode values.                                                                                                                                                                       |
| Railway worker                                          | BLOCKED — no separate worker            | The project has no separate worker service. The `agent` service points to `/infrastructure/searxng` and has a public Railway domain; it is not configured as the MAX worker. API starts `pnpm --filter @research-max/api start`, not `worker:start`.                                                                                                    | Create/configure the intended worker service and ensure API replicas do not also run it.                                                                                                                                                                                        |
| Railway web service                                     | VERIFIED — current config               | `@research-max/web` is a Git-backed private service from `relyceinfotech-spec/agent:main`, root unset, build `pnpm --filter @research-max/web build`, start `pnpm --filter @research-max/web start`; no public/custom domain or app variables surfaced.                                                                                                 | Confirm whether this private Railway web service is intentional alongside the planned Vercel web deployment.                                                                                                                                                                    |
| Deployment revision and replicas                        | VERIFIED — observed snapshot            | Latest successful deployments for API, web, and `agent` are from 2026-09-15, commit `87449970f2a979d42603c0b156670a647752df4b` (`Initial Research MAX`). Each service config declares one replica in `us-west2`; live status did not return a replica count.                                                                                            | Treat the host as an old deployed snapshot; confirm desired current deployment/revision before any live gate.                                                                                                                                                                   |
| Proxy / forwarded-IP behavior                           | UNVERIFIED                              | API is not publicly routed in the observed config, so ingress/proxy behavior could not be established.                                                                                                                                                                                                                                                  | Verify trusted proxy/IP forwarding at the actual public API ingress.                                                                                                                                                                                                            |
| Artifact boundary at observed Railway revision          | VERIFIED for that revision only         | Railway uses Git source `main` at the commit above. Its tree contains `.env.example` but no other `.env*`, no `tmp/`, `.tahr-review/`, `apps/api/evaluation-results/`, `.vercelignore`, or `.railwayignore`. The committed `.gitignore` excludes `.env*` (except `.env.example`) and `apps/api/evaluation-results/`, but not `tmp/` or `.tahr-review/`. | Current local `.vercelignore`/`.railwayignore` are untracked and do not describe that deployed revision. `.tahr-review/` is not ignored by `.gitignore`; keep it out of future deploy commits or add an intentional exclusion. Recheck the new commit's tree before deployment. |
| `public.rls_auto_enable()` object metadata              | VERIFIED — metadata only                | Signova catalog shows event trigger `ensure_rls` on `ddl_command_end`, enabled, owner `postgres`, calling `public.rls_auto_enable()`; the function is `SECURITY DEFINER` and not owned by a database extension.                                                                                                                                         | Preserve the object; this metadata does not identify who provisioned it.                                                                                                                                                                                                        |
| `public.rls_auto_enable()` provisioning provenance      | UNVERIFIED                              | No authoritative provisioning record was returned by database metadata; extension ownership is false and the repository review found no canonical provisioning definition.                                                                                                                                                                              | Obtain evidence from the Supabase/provisioner owner; do not infer from `postgres` ownership.                                                                                                                                                                                    |
| P2 export/share storage; P2 HTML extraction             | DEFERRED — pre-GA                       | Existing dispositions remain deferred; this audit ran no performance or storage-growth test.                                                                                                                                                                                                                                                            | Keep both explicit pre-GA gates.                                                                                                                                                                                                                                                |
| P3 signed-source URL residuals                          | PARTIALLY REMEDIATED                    | Existing review records filtering for known signing parameters; opaque path tokens and unknown provider formats remain unverified.                                                                                                                                                                                                                      | Retain the residual limitation.                                                                                                                                                                                                                                                 |
| Repository-wide security scanner                        | INCOMPLETE — not clearance              | Existing Codex Security scan remains unsealed/incomplete.                                                                                                                                                                                                                                                                                               | Do not claim repository-wide security clearance.                                                                                                                                                                                                                                |
| Final live gate / deployment                            | NOT RUN                                 | No live acceptance or deployment occurred.                                                                                                                                                                                                                                                                                                              | Resolve the hosting/provenance blockers and obtain fresh authorization before the bounded gate.                                                                                                                                                                                 |

The current highest-priority blocker is the **non-production-ready Railway
configuration snapshot**: the observed API has no public domain or app-specific
variables, and the expected separate worker is absent. Vercel settings and
`rls_auto_enable()` provisioning ownership remain unverified. Do not deploy or
run the final live gate from this state.

## References

- [Vercel `.vercelignore` documentation](https://vercel.com/docs/deployments/vercel-ignore)
- [Fastify server options and proxy trust](https://fastify.dev/docs/latest/Reference/Server/)
- [Railway `railway up` and `.railwayignore`](https://docs.railway.com/cli/up)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase database advisors](https://supabase.com/docs/guides/database/database-advisors)
- [Supabase migration list](https://supabase.com/docs/reference/cli/supabase-migration-list)
- [Supabase migration repair](https://supabase.com/docs/reference/cli/supabase-migration-repair)
- [Supabase database function security](https://supabase.com/docs/guides/database/functions)
- [PostgreSQL trigger functions](https://www.postgresql.org/docs/current/plpgsql-trigger.html)
