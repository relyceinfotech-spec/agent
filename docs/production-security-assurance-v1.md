# Production Security Assurance v1 — Bounded Fallback

**Assessment date:** 2026-09-30
**Status:** SECURITY ASSURANCE FALLBACK — READY FOR FINAL DEPLOYMENT REVIEW
**Not a deployment approval, security certification, or substitute for a completed repository-wide security scan.**

## Executive summary

The Codex Security integration did not produce a valid sealed report. The
original scan is orphaned and unsealed; the later current-worktree scan was
canceled after 20 minutes 52 seconds with 0 of 212 coverage items closed and no
report artifact. No third scanner was started. This is an operational scanner
failure, not a security PASS and not evidence that the application is secure.

A bounded source/configuration review, read-only Signova catalog/policy checks,
and deterministic regression checks were completed instead. The review did
not establish a P0/P1 vulnerability in the surfaces inspected. It was not a
line-by-line review of every repository file. Findings and verification gaps
below remain visible for deployment review; P2/P3 candidates were not silently
accepted or fixed.

## Scope and coverage

The current unignored worktree inventory contains **215 files**: 178 under
`apps`, 15 under `supabase`, 2 under `infrastructure`, 1 under `docs`, 7 under
`.tahr-review`, and 12 at the repository root. The prior scanner inventory was
212 files and is reported separately; the inventories are not assumed equal.

Focused review covered the authentication/authorization and persistence
boundaries, job and quota orchestration, memory, sharing, exports, billing and
admin routes, outbound URL safety, extraction, browser-facing configuration,
logging and request limits, migrations/policies, and deployment ignore rules.
Existing deterministic API tests exercise these areas. The full 215-file
inventory was enumerated, but not every file was manually reviewed. Generated
evaluation traces, unrelated UI implementation details, third-party internals,
and actual cloud-provider settings were not comprehensively audited.

Source evidence does not establish production runtime behavior. Cloud service
roots, deployment upload roots, environment values, ingress/proxy topology,
replica count, and full provisioning history remain unverified. Current
PostgREST exposed schemas were verified from the authenticator role setting.

## Surface assessment

| Surface                                   | Assessment                                                                      | Evidence / limitation                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and identity               | PASS in reviewed source/tests; runtime config UNKNOWN                           | Fastify auth derives identity from verified claims; no service-role key was found in browser code. Live deployment environment was not inspected.                                                   |
| Ownership and quotas                      | PASS in deterministic coverage; production topology UNKNOWN                     | Ownership/quota tests are included in the API suite. Do not infer cross-service runtime configuration from tests alone.                                                                             |
| Supabase RLS and grants                   | PASS for the read-only catalog snapshot                                         | Signova owner policies and effective grants were inspected. Column grants and RLS were considered separately. No write or schema change was made.                                                   |
| Research sessions and post follow-ups     | PASS for deployed DML restriction                                               | RLS remains enabled; authenticated users have owner-scoped SELECT, while direct INSERT/UPDATE/DELETE are revoked. Server-role writes remain the application path.                                   |
| Semantic memory                           | PASS for reviewed trigger/policy                                                | Retained-row trigger counts active and inactive rows, serializes per-owner updates, enforces the 500-row cap, and checks authenticated ownership. Hard deletion frees a slot.                       |
| Jobs, worker recovery, cancellation       | PASS in deterministic suite; production worker topology UNKNOWN                 | Recovery/ownership/cancellation tests pass locally. Actual replica count and runtime supervisor settings are unavailable.                                                                           |
| Sharing                                   | PASS for owner/token controls; P2 retention deferred; signed-query filter fixed | High-entropy token/hash, expiry/revocation, owner checks and tests are present. Direct owner DML remains a storage risk.                                                                            |
| Exports                                   | PASS for owner/format/size controls; P2 aggregate-retention candidate remains   | Owner RLS, format constraints, output cap, path/name handling, and tests are present. See findings.                                                                                                 |
| Billing                                   | PASS in deterministic coverage; provider operation not configured/verified      | No payment provider was called in this review.                                                                                                                                                      |
| Admin routes                              | PASS in reviewed fail-closed source; runtime token config UNKNOWN               | Routes fail closed when `MAX_ADMIN_TOKEN` is absent. Production secret provisioning was not inspected.                                                                                              |
| SSRF and outbound fetch                   | PASS in deterministic coverage                                                  | Scheme, credentials, private/internal address, blocked-port, redirect, size, and timeout controls are covered by source/tests. No hostile load test was run.                                        |
| HTML extraction                           | P2 candidate                                                                    | Input is bounded, but repeated content scoring in DOM sorting may amplify CPU for adversarial markup. Exploitability/load impact was not measured.                                                  |
| Browser/UI storage                        | UNKNOWN / privacy consideration                                                 | No `innerHTML` or `dangerouslySetInnerHTML` use was found. Inquiry recents use owner-scoped local storage and are removed on sign-out; device-local retention remains a user-privacy consideration. |
| CORS, body limits, rate limiting, logging | PASS in reviewed source/tests; deployment values UNKNOWN                        | Strict configured-origin handling, request body limit, rate-limit tests, safe errors and readiness redaction are covered. Actual production values/proxy trust are unverified.                      |
| Secrets and environment                   | PASS for repository ignore/client-source checks; deployed values UNKNOWN        | `.env` was not read. It is ignored and untracked; browser code uses only the public Supabase URL/publishable key. Secret-manager values were not inspected.                                         |
| Deployment artifacts                      | UNKNOWN / conditional exposure                                                  | Ignore files exclude `.env*` (except `.env.example`) and `tmp/`, but do not exclude `.tahr-review/`. Whether the deployment uploads repository root is unknown.                                     |
| `rls_auto_enable()`                       | UNVERIFIED authoritative provenance; event-trigger RPC rejected                 | Public is exposed in PostgREST settings and the advisor flags EXECUTE, but a prior direct invocation returned the event-trigger-only error. No remote change was made.                              |

## Signova read-only database verification

The connected project was rechecked as **Signova** (`atntvlkwchxavnjkthjv`,
healthy, `ap-northeast-1`, PostgreSQL 17.6.1.166). Checks used the current
connected Supabase integration and read-only catalog/advisor queries. No
temporary data, DDL, grants, or policies were written.

- `research.max_research_sessions` and `content.max_post_followups`: RLS
  enabled; authenticated SELECT only; no authenticated DML; service-role CRUD.
- `research.max_user_memories`: RLS enabled; owner policies; authenticated
  operations remain owner-scoped; retained-row trigger is installed. The
  trigger is `SECURITY INVOKER`, has an empty search path, rejects non-owner or
  anonymous writes, and uses a per-owner advisory transaction lock before
  enforcing 500 retained rows.
- `content.max_shares`: RLS enabled with owner policies. Authenticated column
  grants permit owner-scoped create/read/revoke operations through PostgREST;
  service-role CRUD.
- `content.max_exports`: RLS enabled with owner policies. Authenticated
  column-level operations are constrained by policies and table checks;
  service-role CRUD. The stored payload limit is 2,000,000 output bytes.
  Current read-only aggregate counts: **0 export rows and 0 share rows**.
- Ten RLS-enabled tables without policies have no `anon` or `authenticated`
  table privileges in the inspected catalog; effective access is denied by
  grants. `service_role` has the expected application privileges. This is not
  treated as an RLS policy substitute.
- `public.rls_auto_enable()` is a `SECURITY DEFINER` event-trigger function
  with `search_path=pg_catalog`; it is owned by `postgres`, executable by
  `anon`/`authenticated`, and attached to the enabled `ensure_rls`
  `ddl_command_end` event trigger. Its body enables RLS on newly created
  `public` tables and logs failures. The `authenticator` role setting exposes
  `public,graphql_public,research,content,billing` through PostgREST, and the
  current security advisor reports the function as RPC-executable. However,
  the prior direct RPC probe returned the expected event-trigger-only error;
  the function cannot run as an ordinary SQL/RPC function outside DDL event
  context. `anon`/`authenticated` lack `CREATE` on `public`, so they cannot
  cause the event by creating a public table. No matching definition exists in
  repository migrations/source. The evidence is most consistent with **B:
  external/provisioner-managed**, but authoritative provenance is not
  established. Do not remove it speculatively: it enforces RLS for future
  public tables. Keep the advisor warning documented until its owner confirms
  provenance and intended exposure. Advisor snapshot: `2026-09-30T16:06:37Z`.
- **Earlier migration-ledger checkpoint — superseded by the repair below:** remote `20260929200634 restrict_direct_session_followup_writes`
  exactly matches local `20260929095621_restrict_direct_session_followup_writes.sql`
  (720 characters, normalized MD5 `93494a3803a01aa5dcea019e6355aa73`); remote
  `20260929200647 memory_retained_limit_v1` exactly matches local
  `20260929151139_memory_retained_limit_v1.sql` (1770 characters, normalized
  MD5 `ff9048103f18e4ed9601e6715489bb55`). The live grants, owner policies,
  index, retained-limit function, and trigger were read-only checked. The MCP
  `apply_migration` schema has no explicit version parameter, but that alone
  does not prove timestamp-generation semantics ([tool schema](https://github.com/supabase/mcp/blob/main/packages/mcp-server-supabase/src/tools/database-operation-tools.ts#L1448)). At that earlier checkpoint, Supabase CLI reported timestamp divergence ([migration list](https://supabase.com/docs/reference/cli/supabase-migration-list)); this historical state was later resolved by the explicitly approved, non-replaying repair recorded below.
- Security advisors at `2026-09-30T16:06:37.474Z` reported ten informational
  RLS-enabled/no-policy tables and the `rls_auto_enable()` warning. The ten
  informational notices were cross-checked against effective privileges and
  are default-deny for `anon`/`authenticated` in the inspected catalog.

## Findings and dispositions

These are bounded-review observations, not scanner-confirmed vulnerabilities.
No P0/P1 was established in the inspected evidence; incomplete scanner coverage
means this is not equivalent to proving none exist.

### P2 — Share and export records have no aggregate retention bound

`POST /api/shares` validates ownership and caps each share expiry at 90 days,
but creates a new row per request; expiry/revocation does not itself delete the
row. Authenticated column-level grants also permit direct owner-scoped
PostgREST inserts. The listing limit of 100 is a response bound, not a storage
bound. Export rows similarly permit direct owner-scoped DML and have per-row
payload/attempt constraints but no aggregate per-owner storage cap or
retention policy. Repeated authenticated use can therefore grow persistent
storage and bypass Fastify's resource checks. Owner RLS prevents cross-owner
access; both tables currently contain zero rows. **Disposition: C — defer to
`Pre-GA Storage Quotas and Retention v1`; before public/general availability,
revoke direct authenticated DML in favor of validated API writes, define
per-owner row/byte limits, and add expiry/cleanup monitoring. Risk owner:
product/deployment owner. No remote change or acceptance for public launch.**

Evidence: [server.ts](../apps/api/src/server.ts#L1605),
[sharing migration](../supabase/migrations/20260928211608_sharing_v1.sql#L1),
[exports migration](../supabase/migrations/20260929063759_exports_v1.sql#L1).

### P2 candidate — HTML extraction can repeat DOM subtree scoring

`contentScore` traverses candidate paragraph subtrees and is invoked repeatedly
by sorting and selection. An existing provider-free direct-call benchmark
measured 63,026-byte nested-article markup at 1,171.7 ms versus 40.3 ms for a
same-size sibling-article control; 12,626-byte and 31,526-byte nested cases
took 69.2 ms and 221.8 ms. The fetch cap is 2,000,000 bytes and parsing is
synchronous on the event loop. This confirms local CPU amplification, not a
production denial of service; deployed concurrency and hostile-input impact
were not tested. **Disposition: C — defer to `HTML Extraction CPU Bounds v1`
before public/general availability; bound candidate traversal/scoring and add
a reproducible performance regression. Risk owner: platform owner.**

Evidence: [extract.ts](../apps/api/src/extract.ts#L53).

### P3 — signed source URL query filtering (locally remediated)

Public-share projections now reject known AWS `X-Amz-*`, Google `X-Goog-*`,
legacy AWS/Google credential keys, Tencent COS `q-signature`/`q-ak`/time keys
and `x-cos-security-token`, plus existing generic `sig`/`signature` keys. A
percent-encoded key is decoded by URL query parsing and rejected. Ordinary
query parameters and non-signing metadata keys remain shareable. This blocks
the tested common query-based signed forms; opaque path tokens or custom
provider-specific capability formats are not universally detectable.
**Disposition: A — minimal known-key filter implemented and covered; residual
opaque formats remain unverified.**

Evidence: [sharing.ts](../apps/api/src/sharing.ts#L9) and
[URL projection](../apps/api/src/sharing.ts#L81).

### UNVERIFIED — `rls_auto_enable()` authoritative provisioning source

Public is confirmed in the authenticator's PostgREST schema setting and the
advisor flags EXECUTE grants, but the prior direct call failed with the
event-trigger-only error. The function is most likely externally/provisioner-
managed, but its authoritative source is unknown. Do not remove it without a
reproducible replacement. **Disposition: B, probable but not provenance-
verified; obtain the provisioning record and retain the trigger until its
owner confirms the lifecycle.**

### UNVERIFIED — deployment/runtime configuration and artifact roots

No Vercel or Railway project-management connector is available in this
workspace; the Sites connector is not Vercel/Railway configuration. No local
`vercel.json`, `railway.json`, or `railway.toml` was found. Actual service
roots, upload roots, production environment values, proxy trust, replica count,
and service domains remain **UNVERIFIED**. Source defaults `PORT` to 8000 and
accepts the host-provided port; `MAX_PERSISTENCE_PROVIDER` defaults to Supabase
only when `NODE_ENV=production`, while `NODE_ENV` itself defaults to
development. API and worker have separate `start` / `worker:start` commands;
actual worker service startup is unverified. Graceful SIGINT/SIGTERM shutdown
and `/health` / `/ready` handlers exist locally.

The API rate limiter is an in-memory `Map` per Node process, and Fastify is
created without `trustProxy`; `request.ip` therefore uses the direct socket
peer unless host/runtime configuration changes that behavior. Multiple
replicas would have independent counters; behind an ingress proxy, clients may
share the ingress peer IP. **Disposition: UNVERIFIED topology; do not add Redis
or another limiter speculatively. Verify replica count and forwarded-IP
handling, then document a single-replica assumption or use an upstream shared
limiter if required.**

`.tahr-review/` is untracked and not excluded by `.gitignore`, `.vercelignore`,
or `.railwayignore`; `apps/api/evaluation-results/` is excluded by Git but not
the host ignore files. `.env*` (except `.env.example`) and `tmp/` are excluded
by host ignore files. Whether these artifacts can upload depends on the
deployment root and deploy method, both unverified. The historical
`tmp/exports-v1-review-20260929` artifact is absent locally.

### Other explicit dispositions

- Export/share storage and HTML CPU risks are explicitly deferred to named
  pre-GA milestones; they are not accepted for broad public launch.
- Known signed-query URL forms are filtered in the shared projection; opaque
  capability URL formats remain unverified.
- Performance advisor notices are informational and were not changed.
- No confirmed public-share source URL containing credentials or cloud signing
  parameters was observed.
- No evidence of an unresolved P0/P1 was established by this bounded review;
  repository-wide scanner coverage remains absent.

## Deterministic verification

Completed for the current checkout:

- Serialized API suite: **635/635 passed** (64 test files; one worker).
- Focused web API-origin tests: **5/5 passed** using the web test's
  `node:test` runner.
- API and web typechecks: **passed**.
- API production build: **passed**.
- Next.js production build: **passed** with temporary placeholder
  `NEXT_PUBLIC_API_URL=https://api.example.invalid`. The real production API
  origin remains unverified. The combined root build without this required
  variable fails as designed.
- `pnpm audit --prod`: **no known vulnerabilities found**.
- Prettier check: **passed**.
- `git diff --check`: **passed** (line-ending warnings only).

The existing tests include authentication/owner isolation, quotas, memory cap
and inactive-row accounting, sharing revocation, export ownership/bounds,
SSRF/redirect controls, API security/rate-limit behavior, worker ownership and
recovery. These tests prove the tested contracts, not live deployment topology.

## Scanner operational record

- Original registered scan `f7153756-9bc7-4257-b765-2e5ce1a5551c` is
  **ORPHANED / UNSEALED / NOT A VALID SECURITY CLEARANCE**. It had receipts but
  deferred coverage and no sealed findings artifact.
- Fresh scan `f4819243-4471-43b5-b435-4447d92d1007` was canceled after 20m52s;
  it had 0 of 212 coverage rows closed and produced no report artifact.
- No replacement scanner, Tahr scan, deployment, final live acceptance, or
  provider call was performed as part of this fallback.
- Scanner failure is an operational limitation. It is not a PASS, and this
  bounded fallback is **not a replacement** for a functioning
  repository-wide security scanner.

## Final disposition

**SECURITY ASSURANCE FALLBACK — READY FOR FINAL DEPLOYMENT REVIEW** means only
that this bounded fallback's deterministic checks are green, no P0/P1 was
established in the reviewed evidence, and the remaining findings/gaps are
explicitly recorded for a human deployment decision. It does **not** authorize
the final live acceptance test or deployment. The P2 risks, scanner coverage
limitation, migration-provenance discrepancy, `rls_auto_enable()` provenance,
and host/runtime configuration must be reviewed before production approval.

## Final deployment review update — 2026-09-30

The later `FINAL DEPLOYMENT REVIEW v1` remains **BLOCKED**, but migration
history is now reconciled. After re-reading the Signova ledger and confirming
the approved pre-state, the following exact commands were executed:

```sh
npx supabase migration repair 20260929095621 20260929151139 --status applied
npx supabase migration repair 20260929200634 20260929200647 --status reverted
```

The post-repair `npx supabase migration list` and connected migration metadata
show all 11 local and remote versions aligned. The two canonical local
migrations are marked applied; the generated remote timestamp entries are
marked reverted. No SQL was replayed: `db push`, migration up/reset, rollback,
and manual SQL were not run. A read-only database catalog recheck confirmed
the session/follow-up grants, owner RLS policies, session index, retained-row
function, and trigger remained intact; no other history entries changed.
The repair changed migration tracking metadata only, not application database
objects.

Vercel/Railway project settings, artifact roots, production environment,
proxy/forwarded-IP behavior, and replica count remain unverified because no
corresponding project dashboard integration was available. The `rls_auto_enable`
provisioning source remains unverified. P2 export/share storage growth and
HTML-extraction CPU amplification are explicitly deferred to named
pre-GA milestones, not accepted for broad public availability. The P3 signed
source URL candidate has a local allowlist-based remediation in the shared
research/post projection; provider-specific or opaque capability URLs outside
that known parameter set remain unverified. This update does not change the
scanner's operationally incomplete status or claim repository-wide security
clearance.

The previously recorded focused sharing tests passed **7/7** and the
serialized API suite passed **636/636** across 64 files. No application code
changed for the migration-history repair, and no application suite was rerun
for this metadata-only operation. No live acceptance, provider call, or
deployment was performed. Vercel/Railway settings and artifact roots remain
unverified; `rls_auto_enable()` provisioning provenance remains unresolved.
The Codex Security scan is still operationally incomplete and is not a sealed
repository-wide clearance. Fresh explicit authorization is still required
before the prepared bounded final live gate.
