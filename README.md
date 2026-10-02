# Research Agent MAX

Research Agent MAX combines one autonomous chat surface with bounded web research and a separate autonomous publishing workflow. It interprets a question before searching, retrieves and ranks sources, maps claims to evidence, and cites sources in its answer. Deep Research uses the same agent with a larger budget.

## What is implemented

- Next.js web workspace with one autonomous chat input, a Deep Research action, live SSE progress, evidence, and source inspection.
- Installable PWA surface with manifest, icon, theme metadata, and a lightweight service worker.
- Fastify + strict TypeScript API with research jobs, health/readiness endpoints, validation, structured logging, and graceful failure handling.
- Google web discovery through Serper, behind a provider interface so another provider can be added later. MAX fetches and evaluates discovered pages itself; every attempt is recorded. Fresh internal documents remain available to the knowledge and retrieval flows.
- URL canonicalization, private-network/SSRF protection, DNS-pinned HTTP fetching, bounded HTML/RSS/structured JSON/PDF extraction, browser rendering for JavaScript-only pages, source quality scoring, claim extraction, and OpenRouter synthesis.
- Query Understanding before discovery: conservative normalization, high-confidence typo correction, entity/intent/topic extraction, ambiguity scoring, diversified DIRECT/OFFICIAL/RECENT/EXPERT/CONTRARY queries, clarification pauses, and bounded second-pass query rewriting when the first result set is weak.
- One autonomous chat surface: normal Send chooses between direct synthesis and web research; Deep Research enables a larger research budget without becoming a separate agent mode. Both modes stop when reliable evidence is sufficient instead of consuming the full ceiling automatically.
- Backend tool registry with `understand_query`, `web_search`, `fetch_url`, `extract_content`, `search_again`, `find_relevant_section`, `extract_claims`, `gather_evidence`, `verify_claim`, `compare_sources`, `detect_conflict`, and `synthesize` capabilities.
- True Autonomous Research Loop v2: the runner observes state and chooses the next action, performs source triage before fetching, maps claims to evidence, verifies bounded claims, preserves conflict records, and adaptively rewrites/searches when evidence is insufficient.
- Adaptive Research Chat efficiency: `/api/chat` passes its initial query interpretation into the durable job so the worker can reuse it instead of interpreting the same request again. The chat research runner begins with one discovery query, retrieves only the minimum initial source set needed for independent evidence, then evaluates results before fetching more sources one at a time. It verifies claims individually and stops when the existing evidence-sufficiency and citation gates pass; limits remain hard ceilings, not targets. Retrieval and model calls are conditional, and browser rendering remains a bounded fallback. The Post Agent retains its existing batching and research workflow; its publication gate now requires claim-specific, source-bound evidence, including entity/version and requested-fact binding where applicable.
- Shared bounded Source Retrieval Engine used by normal Research Chat, fast lookup, and Post Agent research. It checks relevant Serper snippets first, then a matching discovered RSS/Atom entry, useful JSON/JSON-LD or OpenGraph metadata, normal safe HTTP extraction, and only then the existing bounded browser fallback for JavaScript shells. Failed sources are retained with extraction status and the controller can move to another selected source or its bounded search-again path; Post Agent never treats a search snippet alone as publication evidence.
- Repository-backed persistence: local SQLite for development/tests and Supabase PostgreSQL by default in production; sessions retain the complete nested research state.
- Durable background jobs: research and Post Agent work is persisted before acknowledgement, processed by a separate worker process, and recovered from expired leases with bounded retries, cancellation, idempotency, and persisted progress/results.
- Private semantic memory in the Supabase `research` schema: only explicit user requests are saved, embeddings are provider-backed, retrieval is user-scoped and thresholded, and relevant memory is injected into chat as untrusted context only when the request asks about prior user context.
- Separate content agent with feed/trusted-domain topic discovery, novelty filtering, queued/manual/scheduled runs, evidence quality gate, publication, retry, and cancellation. The scheduler is off by default.
- Post Agent model roles are independently configurable for planning/tool decisions, research writing, and verification. Each role may use the shared default model or an optional fallback model; model failures stay bounded and publication remains fail-closed.
- Discover feed and research-post detail pages with provenance links and follow-up questions that can continue live research.
- Environment-driven deployment configuration. No search service needs to be self-hosted.

MAX does not use Redis/Valkey or MongoDB. SQLite backs local development jobs; production workers coordinate through PostgreSQL with atomic leases. Sharing v1 uses Supabase-backed, owner-managed read-only links for completed owner-owned research and published posts linked to the owner's completed research.

### Exports v1

Exports are generated only from persisted completed research sessions or published posts whose linked completed research belongs to the authenticated owner. `POST /api/exports` accepts `{ resourceType, resourceId, format }`, where `resourceType` is `research_session` or `published_post` and `format` is `markdown`, `json`, or `pdf`. `GET /api/exports`, `GET /api/exports/:id`, `GET /api/exports/:id/download`, and `DELETE /api/exports/:id` are authenticated and owner-scoped. A public share token never grants export access.

Each export is rendered from one allowlisted canonical projection. Research exports contain the persisted question/answer, evidence-linked claims and citation metadata; published-post exports contain published copy, findings/caveats and citation metadata. Source URLs and citation numbers are preserved. Prompts, fetched page bodies, private memory, verifier details, controller/job traces, credentials, and internal IDs are excluded from the document projection. Markdown, JSON, and PDF are deterministic for the same snapshot; changed persisted content creates a new snapshot instead of mutating a completed export. PDF rendering has a 5-second, 2 MB, and 80-page bound and does not access arbitrary filesystem paths or external providers.

The `content.max_exports` table is introduced by `supabase/migrations/20260929063759_exports_v1.sql`. RLS is enabled, owner identity is checked against `auth.uid()`, anonymous access is revoked, and snapshot identity fields cannot be updated by authenticated clients. Run `supabase/tests/exports_security.sql` to check deployed catalog grants and policies. Exports never invoke research, search, Serper, OpenRouter, crawling, or evidence regeneration. The deterministic coverage is in `apps/api/tests/exports.test.ts`; after the migration is applied, run `pnpm --filter @research-max/api eval:exports-smoke` once for the bounded live Signova verification.

## Local setup

Requirements: Node 24.x (tested with 24.8) and pnpm 9+. Local development/tests use Node's experimental `node:sqlite` module. A Serper API key is required for live web search; MAX does not send raw user input to Serper, only planner-generated search queries.

```bash
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Open http://localhost:3000. Set `SERPER_API_KEY` and `OPENROUTER_API_KEY` in `.env` for live search and automated synthesis. Without the Serper key, web search reports missing credentials and makes no provider request; direct answers and other configured local functionality remain available. Without the OpenRouter key, the app still performs fetching, extraction, ranking, and evidence collection, then reports that synthesis is unavailable. Browser retrieval needs a working Chromium installation or `BROWSER_EXECUTABLE_PATH`.

For the web app, `NEXT_PUBLIC_API_URL` is the Fastify API origin (default local value: `http://localhost:8000`). Configure it in the web build environment for Vercel; it is compiled into the browser bundle and must never contain a secret.

The local database defaults to `apps/api/data/max.sqlite` when the API starts from its package directory. Back it up before upgrades. `/ready` confirms local configuration and storage access; it does not guarantee upstream search/model availability.

### Live backend integration smoke

The bounded `eval:backend-integration` runner requires outbound HTTPS access to Signova Supabase, Serper, and OpenRouter. Codex's restricted Windows execution sandbox can deny outbound sockets with `EACCES` before an HTTP response exists; this is an execution-environment restriction, not evidence that the application or provider rejected the request. Do not repeatedly retry the live smoke from a blocked runtime or change application security controls to get around the restriction.

From the repository root, run `npm run check:live-network` first. It checks required configuration, resolves the service hosts, and makes only unauthenticated HTTPS `HEAD` requests; it does not send API keys, call provider operations, create users, or write data. Continue only when it prints `NETWORK READY`. In a normal network-enabled local terminal or network-enabled CI runner, provide the required environment variables through `.env` or the CI secret store, without printing or committing their values.

The integration smoke can briefly publish one quality-gated temporary post, so it remains behind an explicit approval flag. After approving that temporary visibility, run it once with PowerShell:

```powershell
$env:MAX_TEMPORARY_PUBLIC_SMOKE_POST_APPROVED = '1'
try { npm run eval:backend-integration } finally { Remove-Item Env:MAX_TEMPORARY_PUBLIC_SMOKE_POST_APPROVED -ErrorAction SilentlyContinue }
```

The runner performs its own network/configuration preflight before creating a temporary user. If preflight fails, it exits without making Supabase cleanup calls or creating fixtures. Once user creation is attempted, existing exact-email reconciliation and cleanup behavior remains active for uncertain outcomes.

## Production deployment contract

The repository does not contain Vercel or Railway service manifests, so the deployed project roots, commands, and environment values must be verified in those dashboards before deployment. Build the workspace from the repository root with `pnpm build`. Configure Vercel to build the Next.js app in `apps/web`; set `NEXT_PUBLIC_API_URL` to the HTTPS Fastify origin and set only the public Supabase URL and publishable key there. These `NEXT_PUBLIC_*` values are included in browser code and must never contain a secret.

Configure Railway with separate API and worker services from the monorepo. Use `pnpm --filter @research-max/api start` for the API and `pnpm --filter @research-max/api worker:start` for the worker after building the workspace. Both services require `NODE_ENV=production`, `MAX_PERSISTENCE_PROVIDER=supabase`, the Signova URL and backend-only Supabase secret key, the publishable key needed for owner-scoped database operations, and the same production quota/job configuration. The API additionally needs `PORT`, `APP_URL` (the API origin), `WEB_URL` (the Vercel origin), `SERPER_API_KEY`, and `OPENROUTER_API_KEY`; the worker needs the provider and database credentials needed to execute jobs. Never upload `.env`; supply secrets through the host's secret environment. The compiled start commands deliberately do not depend on a local `.env` file.

SQLite is suitable for local development and deterministic tests, not a multi-service production queue. The app currently permits an explicit SQLite override in production, so verify the effective Railway value is `supabase`. No Railway volume, Vercel project setting, runtime environment value, or deployed artifact has been verified by this repository audit; those remain deployment-gate checks.

## Supabase persistence

The Fastify API uses Supabase PostgreSQL for production persistence (`MAX_PERSISTENCE_PROVIDER=supabase`). When the setting is omitted, production defaults to Supabase; development and tests default to SQLite. Set `SUPABASE_URL` and a backend-only `SUPABASE_SECRET_KEY`. Existing legacy `SUPABASE_SERVICE_ROLE_KEY` values are accepted as a fallback. Never use either secret in the web app or a `NEXT_PUBLIC_*` variable. The service key bypasses RLS and must remain server-side.

The migrations for Signova include `supabase/migrations/20260924154756_max_persistence_v1.sql`, `20260924175250_split_max_persistence_schemas.sql`, `20260924201347_auth_ownership_quotas_v1.sql`, `20260925100952_semantic_memory_v1.sql`, `20260925195403_durable_jobs_v1.sql`, `20260926162510_billing_subscriptions_v1.sql`, `20260928211608_sharing_v1.sql`, `20260929063759_exports_v1.sql`, and `20260929095621_restrict_direct_session_followup_writes.sql`. They separate MAX data into `research` and `content`; add private user ownership and atomic quotas; add private vector-backed memories; add a private service-role-only durable job table with atomic enqueue/quota, `SKIP LOCKED` claims, leases, fencing, retry, cancellation, and persisted progress/results; add provider-neutral plans, customer mappings, subscription snapshots, and idempotent webhook-event processing; add owner-scoped share metadata with RLS; add owner-scoped export snapshots with RLS; and remove direct `authenticated` DML grants for research sessions and post follow-ups while preserving owner-scoped reads. Existing ownerless research sessions remain inaccessible to end users. Knowledge documents are a shared internal cache; topics, runs, posts, and post relationships remain server/admin controlled, while public Discover reads continue through the API. RLS stays enabled. Memory, share, and export owner-scoped records are accessed with an authenticated user JWT so owner RLS applies; public share-token resolution is server-side and stores only a SHA-256 token hash. For a new migration, use `pnpm dlx supabase@latest migration new <descriptive_name>`, review the generated SQL, then apply it with the Supabase CLI or connected Supabase integration and verify the recorded migration version.

### Sharing v1

Authenticated users can create, list, and revoke links for completed research they own and for published posts whose completed research session they own. Share tokens are 256-bit random URL-safe bearer secrets; only their SHA-256 hashes are persisted. Links expire after 30 days by default and may be configured for 1–90 days. Revocation is immediate, cannot be undone, and expired, revoked, malformed, or unknown tokens all resolve as the same `404` response. Public token resolution is rate-limited and returned with `Cache-Control: private, no-store`.

The public representation is an explicit allowlist: research question/answer and safe citation metadata, or published post copy/findings/caveats and citations. It excludes user IDs, resource/share IDs, claim IDs/evidence, source snippets/page bodies, private memory, prompts, model traces, jobs, and billing state. Citation numbers are retained; a cited source with an unsafe URL causes sharing to fail closed. Only `http`/`https` public URLs are returned; credentials and localhost/private-network destinations are omitted, and the server never fetches a URL from the share request.

Endpoints: `POST /api/shares` with `{ resourceType: "research_session" | "published_post", resourceId, expiresInDays? }`; `GET /api/shares` and `DELETE /api/shares/:id` require authentication; `GET /api/share/:token` is public and read-only. The raw token is returned once from create and is never logged or stored in plaintext. Share creation intentionally makes a new link each time rather than reusing a secret on a retried request.

The deterministic API coverage is in `apps/api/tests/sharing.test.ts`; `supabase/tests/sharing_security.sql` checks the deployed RLS and column-grant boundaries. The bounded live smoke command is `pnpm --filter @research-max/api eval:sharing-smoke`; it creates temporary Auth identities and an owner-scoped completed research fixture only, calls no search/model providers, and verifies cleanup independently.

Persisted records are mapped as follows:

- Research sessions store the complete session snapshot in JSONB, including plan, steps/events, seed results, sources, claims, evidence, conflict state, answer/citation text, and search attempts.
- Knowledge documents use typed columns plus JSONB extraction metadata and a generated full-text search vector.
- Topics and autonomous runs keep indexed identity/status/timestamp columns plus complete JSONB snapshots.
- Posts keep their snapshot in JSONB with normalized topic, source-reference, and claim-reference relationships; follow-ups reference posts and keep their full snapshot.

The previous SQLite implementation remains available for local development, deterministic tests, and rollback during migration. Selecting Supabase does not automatically import historical SQLite records; keep the existing SQLite file backed up until any required historical data transfer is verified. To use local SQLite explicitly, set `MAX_PERSISTENCE_PROVIDER=sqlite`.

The API persists research jobs before returning and exposes owner-scoped `GET /api/jobs`, `GET /api/jobs/:id`, and `POST /api/jobs/:id/cancel` endpoints. Run a separate worker with `pnpm --filter @research-max/api worker:dev` (or `worker:start` for the compiled build); do not run the worker in every API replica. `MAX_JOB_WORKER_CONCURRENCY`, `MAX_JOB_LEASE_SECONDS`, and `MAX_JOB_POLL_INTERVAL_MS` bound worker behavior. The queue uses PostgreSQL in production and SQLite locally; an expired worker lease is reclaimed by another worker, while lease generations prevent a stale worker from completing a reclaimed job. The provider-free state-machine tests are `apps/api/tests/jobs.test.ts`; `pnpm --filter @research-max/api eval:durable-api-restart` verifies a real Fastify process restart with one temporary row and no provider calls. `pnpm --filter @research-max/api eval:durable-jobs` runs the bounded live worker-recovery check and one capped real research job. `pnpm --filter @research-max/api eval:durable-job-auth` performs the one-user authenticated route/quota/idempotency/result-read check with exactly one bounded worker attempt; it creates and deletes a temporary user and may consume one Serper query plus bounded OpenRouter usage.

Run provider-free persistence adapter tests with `pnpm --filter @research-max/api test:persistence`. The live persistence smoke command is `pnpm --filter @research-max/api eval:supabase-smoke`; it requires the backend-only Supabase URL and secret key, writes uniquely identified test records, verifies reads/relationships, and deletes only those test records.

After applying the auth ownership migration, `pnpm --filter @research-max/api eval:auth-smoke` performs one bounded two-user check of real Supabase Auth token verification, session/follow-up RLS ownership, quota isolation/rejection, and provider avoidance. It uses temporary confirmed users and uniquely identified fixtures, has a 90-second overall deadline and 15-second per-request timeout, and verifies cleanup before it reports success. It requires the Supabase URL, publishable key, and a server-only secret key; it does not call Serper or OpenRouter.

## Semantic memory

Semantic memory is private user context, not an alternate evidence store. The migration `20260925100952_semantic_memory_v1.sql` creates `research.max_user_memories` with an authenticated owner UUID, category, concise text, exact-content hash, source/provenance metadata, confidence/importance, an embedding, model identity, active state, and timestamps. The vector column is `extensions.vector(1536)` and uses the existing `vector` extension in Signova's `extensions` schema. An owner/active/update-time B-tree index supports bounded per-user listing; v1 deliberately does not add an approximate-nearest-neighbor index because each user is capped at 500 active memories and exact cosine scans over that small owner-scoped set are simpler and predictable.

Embeddings are provided through the backend-only `EmbeddingProvider` interface. V1 implements OpenRouter embeddings with `openai/text-embedding-3-small`; the model and endpoint are configurable, but dimensions must remain 1536 to match the deployed vector column. The API also rejects a configured memory-text limit above the database's 2000-character constraint. Retrieval embeds only the current question when a conservative prior-context heuristic says memory may help. PostgreSQL filters by `auth.uid()`, non-anonymous identity, active status, embedding model, and confidence (at least 0.5), orders candidates by cosine distance with importance/update time as tie-breakers, applies the configured similarity floor, then returns at most five results from at most 50 candidates. The final prompt context is capped at 4000 characters by default. The database RPC is `SECURITY INVOKER`, has no caller-supplied owner ID, and is executable only by `authenticated`; RLS applies matching owner checks in both `USING` and `WITH CHECK`.

MAX does not automatically save every chat. A chat is captured only when the user explicitly starts it with “remember”, “keep in mind”, or “for future reference”; `/api/memories` is also available for explicit create/update operations. Credential-shaped text is rejected before embedding. Normalized exact duplicates are deduplicated; v1 does not fuzzy-merge paraphrases because merging similar wording can incorrectly erase contradictory preferences. Memories can be listed, read, edited/deactivated, and deleted through authenticated owner-only API routes. Retrieved text is escaped and bracketed as untrusted user data; it is not instructions, verified web evidence, or authority over the current request. If memory retrieval fails, chat continues without it. Post Agent and public Discover do not receive private memory in v1.

The settings are backend-only: `MEMORY_ENABLED`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_TIMEOUT_MS`, `MEMORY_MAX_RECORDS`, `MEMORY_MAX_TEXT_CHARS`, `MEMORY_MAX_EMBEDDING_BATCH`, `MEMORY_MAX_CANDIDATES`, `MEMORY_MAX_RESULTS`, `MEMORY_MAX_CONTEXT_CHARS`, and `MEMORY_MIN_SIMILARITY`. See `.env.example` for safe defaults. The unit/API tests use deterministic fake embeddings:

```bash
pnpm --filter @research-max/api test -- tests/memory.test.ts tests/memory_api.test.ts tests/embeddings.test.ts tests/memory_config.test.ts
```

One bounded live check runs the real embedding endpoint, exercises semantic retrieval and the authenticated `/api/chat` context path, verifies both-user isolation, and removes temporary memory and Auth fixtures:

```bash
pnpm --filter @research-max/api eval:semantic-memory-smoke
```

The smoke is capped at two temporary users, eight embedding requests, 10 seconds per outbound request, 120 seconds for test work, and a 30-second cleanup reserve. It records provider-reported token/cost data and sanitized embedding failure type/status when available in ignored `apps/api/evaluation-results/semantic-memory-smoke-report.json`; it never stores provider response bodies or credentials. It calls no Serper search or OpenRouter chat-completion endpoint; the chat synthesis tool is deterministic. A provider may omit cost metadata, in which case the report marks cost as unavailable rather than estimating it. Current limitations: only OpenRouter is implemented as an embedding adapter, memory capture is explicit rather than automatic, and exact-hash deduplication does not merge paraphrased records.

## API

`/api/chat`, `/api/research*`, and post follow-up routes require `Authorization: Bearer <Supabase access token>`. The API verifies the token with Supabase Auth and derives the owner from the verified `sub` claim; request body or URL user identifiers are never used as ownership proof. Research sessions and follow-ups are filtered by that identity in the store and enforced again by RLS. Expired/invalid credentials receive 401; Auth verification outages fail closed with a generic 503. `GET /api/discover` and `GET /api/posts/:id` remain public. Topic/run administration continues to require the backend-only `MAX_ADMIN_TOKEN`; ordinary signed-in users do not receive admin permissions.

For the web client, configure `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` with the project URL and publishable key. These are public client configuration values. Keep `SUPABASE_SECRET_KEY` and any legacy service-role key server-side only. The login page supports Supabase email/password sign-in and sign-up, restores the auth session, and signs out on an API 401.

Per-user usage is tracked in an atomic fixed-window counter before provider work. Defaults are configurable with `MAX_USER_RESEARCH_PER_WINDOW`, `MAX_USER_DEEP_RESEARCH_PER_WINDOW`, `MAX_USER_FOLLOWUPS_PER_WINDOW`, and `USER_QUOTA_WINDOW_SECONDS`. Optional `MAX_QUOTA_PLANS_JSON` defines named quota/feature configurations, while `MAX_USER_PLAN_OVERRIDES_JSON` assigns a user ID to a configured plan. These are infrastructure defaults, not Free/Pro definitions or prices. Rejected requests do not increment usage, and the SQLite adapter serializes concurrent consumption in a transaction; production uses a restricted Postgres RPC. Network/IP rate limits remain a separate control.

## Pricing and billing foundation

Pricing v1 is backend-only and provider-neutral. `billing.plans` is the canonical plan catalog; the migration seeds an active Free record and an inactive Pro placeholder with no invented price or quota values. Free continues to use the existing configured quota defaults. Pro can be activated and configured in plan data later, without changing the research agent or queue. The API exposes `GET /api/plans` and authenticated `GET /api/billing/me`; both return safe plan/subscription summaries and never return provider customer or subscription identifiers. There is no checkout route or configured payment provider yet.

`BillingService` resolves the plan from the verified Auth identity and persisted subscription snapshot, then supplies research, Deep Research, and follow-up quota definitions to the existing quota paths. Durable research enqueue continues to charge atomically through the existing quota/job store; changing a plan does not delete or reset the active usage window. Current accounting remains: a normal research request consumes the `research` window, Deep Research consumes `deep_research`, and each post follow-up consumes `followup`. Memory capture/retrieval does not consume a billing quota today and keeps its existing global memory cap; Post Agent publication remains an admin/system operation rather than a per-user billable unit. The plan schema also reserves `activeMemories`, `backgroundJobs`, and `postAgentRuns` limits so those can be configured when corresponding per-user billing semantics are defined; they are not currently metered independently.

`billing.customer_accounts` maps a verified provider customer to an Auth owner; `billing.subscriptions` stores normalized lifecycle state; and `billing.webhook_events` deduplicates provider event IDs. A provider adapter must verify the raw webhook signature and normalize lifecycle changes before the service accepts them. The generic webhook endpoint is `POST /api/billing/webhooks/:providerId` with `x-billing-signature`; with no provider configured it fails closed. The transaction records duplicate, unknown, stale, and unmatched events, maps ownership through the stored customer association rather than event-supplied user IDs, and applies newer snapshots only. RLS allows authenticated users to read active plans and their own limited subscription summary. Users cannot write their plan or billing identifiers; customer mappings and webhook records remain service-role-only. These grants and RLS policies were checked against the connected Signova project. See the provider-free coverage in `apps/api/tests/billing.test.ts` and `apps/api/tests/billing_api.test.ts`.

- `GET /health`
- `GET /ready`
- `GET /api/plans`, `GET /api/billing/me` (safe plan catalog and authenticated account entitlements)
- `POST /api/billing/webhooks/:providerId` (raw-body signature-verified provider event; unavailable until a provider adapter is configured)
- `POST /api/chat` with `{ "message": "...", "deepResearch": false }`
- `POST /api/research` with `{ "question": "...", "mode": "quick" | "deep" }`
- `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel` (authenticated, owner-scoped durable-job status/cancellation)
- `POST /api/research/:id/clarify` with `{ "answer": "..." }` when the planner marks a request ambiguous
- `GET /api/research`
- `GET /api/research/:id`
- `GET /api/research/:id/events` (SSE)
- `DELETE /api/research/:id`
- `GET /api/memories`, `POST /api/memories`, `GET|PATCH|DELETE /api/memories/:id` (authenticated, owner-only)
- `POST /api/shares`, `GET /api/shares`, `DELETE /api/shares/:id` (authenticated, owner-managed)
- `GET /api/share/:token` (public read-only share; token is the only lookup secret)
- `POST /api/exports`, `GET /api/exports`, `GET /api/exports/:id`, `GET /api/exports/:id/download`, `DELETE /api/exports/:id` (authenticated, owner-only immutable export snapshots)
- `GET /api/discover`, `GET /api/posts/:id`
- `POST /api/posts/:id/ask`, `GET /api/posts/:id/ask/:followUpId`
- `GET /api/topics`, `GET /api/autonomous/runs`, `GET /api/autonomous/runs/:id`
- `POST /api/autonomous/runs`, `POST /api/autonomous/runs/:id/retry`, `POST /api/autonomous/runs/:id/cancel` (admin bearer token required)

`GET /api/research` returns an owner-scoped, newest-first page of up to 50 sessions by default. Pass `?limit=1..100` to choose a page size. When more sessions are available, the response includes an opaque `X-Next-Cursor` header; pass its value as `?cursor=...` to request the next page. The API validates the cursor and exposes the header to browser clients through CORS. A detached queued research job is merged into the first page only so it does not repeat on later session pages; `GET /api/jobs` lists up to the 100 newest owner jobs, and `GET /api/jobs/:id` remains available for direct status lookup. Session and follow-up mutations go through Fastify; authenticated Supabase roles retain owner-scoped reads, while writes use the server-side persistence path.

Manual content runs require `Authorization: Bearer <MAX_ADMIN_TOKEN>`. Set a strong `MAX_ADMIN_TOKEN` before enabling them. Set `AUTONOMOUS_SCHEDULER_ENABLED=true` only when recurring paid research is intended. User-level quotas and separate network rate limits apply to chat/research and follow-ups.

## Safety and provenance

Retrieved pages are untrusted data and are separated from model instructions. Fetching only permits HTTP(S), rejects credentials, resolves DNS before requests, blocks private/link-local destinations, sets timeouts and a respectful User-Agent, and bounds the number of pages. HTTP requests pin vetted DNS resolutions; source and feed retrieval retry one transient network/timeout or retryable HTTP failure, while permanent HTTP and URL-validation failures stop immediately. Every retry revalidates the URL and redirect chain. OpenRouter retries at most one transient network or server failure within the research deadline; it does not retry timeouts, rate limits, authorization errors, malformed responses, or truncated completions, and each attempt is recorded. Browser rendering routes every page and subresource through that same safe fetch path, blocks non-GET requests, and uses a closed proxy as a network fail-closed guard. Browser runs also cap request count, resource bytes, and total response size. Research synthesis requires citations for factual statements and now checks each answer statement against its cited source content. Exact source text is checked locally; other statements are judged together in one bounded OpenRouter request (up to 10 statements, three cited sources per statement, 1,200 source characters per source, and a 1,024-token response cap). Unsupported and insufficiently evidenced statements are removed; partially supported statements are explicitly qualified. If validation fails or is unavailable, MAX fails closed and reports insufficient evidence. Existing conflict records are retained rather than collapsed.

The source retrieval ladder uses relevance and minimum-content checks, not HTTP 200 alone. If Serper is insufficient, MAX first checks safe response headers and a 64 KB maximum range preview for advertised feeds, JSON representations, JSON-LD, and OpenGraph data. This preview is bounded metadata discovery; it does not download the full article. RSS entries must match the selected article URL before use. The full page crawler is invoked only after snippet, advertised feed, and structured-data routes are insufficient. A page that remains empty or is a challenge/login shell is recorded as insufficient/failed rather than becoming evidence. Browser rendering is attempted only for a short full-HTML shell with JavaScript indicators, and remains bounded by the existing request, byte, timeout, SSRF, redirect, and content-size controls. Source provenance records the chosen method, attempted and skipped methods, escalation reasons, canonical URL, extracted content length, and confidence. Compact lookups inspect one useful candidate before spending a page budget on weaker alternatives; complex research continues gathering independent sources as required. This is a bounded fallback policy, not unlimited scraping.

This quality gate is not a guarantee of truth: semantic judgments can be wrong, extraction may omit relevant context, and only cited source text is checked. It does not independently establish source authority, freshness, or completeness. Direct answers without web citations remain outside this source-entailment check.

The raw user sentence is retained as provenance, but it is never sent to a search provider. Search receives only planner-generated queries. If the planner cannot confidently interpret a request, the job enters `NEEDS_CLARIFICATION` before any search is performed.

## Post Agent model roles

The publishing workflow keeps one autonomous research controller, but routes model calls through three backend-only logical roles:

- `POST_AGENT_PLANNER_MODEL` selects the model used for query understanding and next-action decisions.
- `POST_AGENT_RESEARCH_MODEL` writes a cited synthesis from collected evidence.
- `POST_AGENT_VERIFIER_MODEL` checks claims, conflicts, and cited-answer support.

Blank role model settings inherit `OPENROUTER_MODEL`, so one model can serve every role. Optional `POST_AGENT_*_FALLBACK_MODEL` settings provide one alternate model per role. The controller makes a bounded retry for transient provider/server failures, does not retry a rate limit indefinitely, and tries the configured fallback when the primary fails. `POST_AGENT_MODEL_TIMEOUT_MS` defaults to 20 seconds and is capped at 60 seconds. Role model identifiers and credentials are server-side configuration only; they are not returned by the API or exposed to the web client.

Post research has its own hard controller ceilings (8 steps, 2 searches, 4 sources, 3 pages, 120 seconds, and at most 8 model decisions by default). A failed or empty extraction is retained on the source with a failure category; insufficient evidence may use only the remaining bounded search budget. Claims without supported, source-bound evidence are excluded. If too few independently sourced claims or required facts remain, the run requires more research (`REQUIRES_RESEARCH`); other review conditions, such as open conflicts, may require review.

## Autonomous research loop

Research jobs use a bounded observe → decide → act loop rather than a blind fixed chain. The model receives a sanitized research observation and may propose an action; the backend validates it against the current state, evidence-sufficiency guard, and hard budgets before allowing, overriding, or falling back. Quick autonomous research uses smaller budgets; Deep Research allows more queries, sources, pages, verification attempts, and search passes while keeping the same agent brain. These budgets are ceilings: evidence-driven stopping applies to both, so deeper research continues only when current evidence leaves a material requirement unresolved.

Serper is the only configured live web-search provider. Research limits are hard controller-enforced ceilings, not targets: the default step ceiling is 24 (quick research is capped at 14), quick research is additionally capped at four queries, and Deep Research at eight. Evaluation runs use their separate smaller `EVAL_*` caps. The controller enforces per-run limits regardless of model requests. Successful Serper searches consume provider credits, so configure budgets deliberately. The search provider can be replaced or extended later without changing the agent interface.

## Autonomous Decision Quality v1

The API includes a provider-free benchmark for the agent's first decision. It covers stable questions, current information, comparisons, ambiguous requests, messy spelling, and Deep Research. The benchmark checks expected behavior rather than exact answer wording:

- route accuracy: direct answer, web research, or Deep Research
- clarification accuracy for high-ambiguity requests
- decision-trace completeness, including the reason for the selected route
- research-loop behavior through the existing adaptive-loop test

Run it with:

```bash
pnpm --filter @research-max/api eval
```

Each chat response now includes a `decide_next_action` trace event with `phase: "decision"` and a human-readable `reason`. Tool events remain additive, so the existing chat and research API contracts continue to work while evaluation can inspect whether MAX chose the minimum necessary first action.

Tool Decision Quality v1 adds deterministic research-loop scenarios for selective source fetching, targeted second-pass query rewriting after weak evidence, and early stopping when the evidence threshold is met. Source triage now filters low-relevance/low-quality results before fetches and records how many candidates were selected.

Trajectory Quality v1 validates complete action paths for direct synthesis, evidence-backed research, weak-result recovery, and conflict investigation. The assertions normalize `running`/`complete` progress entries into action transitions while still checking that verification and synthesis occur in the expected order.

## Real-model evaluation

The first OpenRouter evaluation is intentionally separate from the deterministic suite:

```bash
pnpm --filter @research-max/api eval:real
```

For fast real-model regression coverage, use:

```bash
pnpm --filter @research-max/api eval:smoke
```

`eval:smoke` runs only direct chat, current information, and one compact comparison case. Its controller-enforced defaults are three cases, four steps, three queries, two sources, one page, a 30-second session, and a 10-second OpenRouter request timeout; each can be overridden with the `EVAL_SMOKE_*` variables. Use a 20–30-second request timeout and a 60-second session only for a specifically authorized, bounded live case. The comparison is intentionally a tool-decision smoke check through its first fetch, not a substitute for a complete evidence-quality run. It records model/tool traces plus model-requested actions and controller allow/override/fallback decisions to `apps/api/evaluation-results/` and never prints credentials. When a deterministic fast path makes no model decisions, decision accuracy is reported as not measured rather than 100%.

`eval:real` remains the full bounded seven-case evaluation. Its caps are application-enforced through `EVAL_MAX_RESEARCH_STEPS`, `EVAL_MAX_SEARCH_QUERIES`, `EVAL_MAX_SOURCES`, `EVAL_MAX_PAGES`, `EVAL_MAX_RESEARCH_TIME_MS`, and `EVAL_MAX_CASES`. Controlled weak-result and conflict cases use fixture search/fetch tools while still exercising the configured model for understanding, claims, verification, conflict detection, and synthesis.

For deterministic citation-entailment and API-route-to-follow-up fixtures, run:

```bash
pnpm --filter @research-max/api eval:citations
```

These provider-free tests cover exact/paraphrased/partial support, unrelated or unsupported evidence, conflicting sources, valid citation IDs attached to unsupported claims, mixed support, judge failure, and the direct-answer/no-source path. The route-level fixture also exercises `/api/chat` through planning, independent-source fetching, evidence verification, citation validation, persistence, and a cited follow-up using deterministic providers (no paid calls).

For one bounded live-model citation-quality smoke, run:

```bash
pnpm --filter @research-max/api eval:citation-e2e
```

This makes one real `/api/chat` request through Serper, safe fetch/extraction, evidence verification, synthesis, semantic citation validation, and a follow-up when upstream services permit. Backend ceilings are 8 steps, 2 queries, 2 sources, 2 pages, a 150-second research session, 22 seconds per OpenRouter request, and a 45-second follow-up window. It writes answer claims, cited source IDs, support classifications, model usage/cost, duration, and failures to ignored `apps/api/evaluation-results/citation-quality-e2e-report.json`. It requires `SERPER_API_KEY` and `OPENROUTER_API_KEY`; run it once for this milestone, not as the routine test command. Provider/network/timeouts are recorded and the report is written even when the run fails. The recorded run reached source verification but OpenRouter returned HTTP 429, so synthesis and the follow-up were not reached; this is an upstream rate-limit result, not a model-quality verdict.

For the real-provider chat-to-follow-up path without another model request, run `pnpm --filter @research-max/api eval:citation-product-e2e` once. It performs at most one Serper query and fetches only the structured React package registry source; the local structured citation validator checks the answer, then `/api/posts/:id/ask` checks a cited follow-up. It does not call OpenRouter and records its outcome to ignored `apps/api/evaluation-results/citation-product-e2e-report.json`.

## Post Agent production verification

The deterministic Post Agent suite runs with `pnpm --filter @research-max/api eval:post-agent`. Its tests cover topic discovery/selection, bounded research, evidence quality and publication gates, atomic publication/provenance, API visibility, and a follow-up that continues through a live-search fixture without paid providers.

Run one real Post Agent workflow with:

```bash
pnpm --filter @research-max/api eval:post-e2e
```

This uses one GitHub RSS feed, at most one trusted-domain discovery fallback query, and caps each research session at 8 steps, 2 queries, 4 sources, 3 pages, 120 seconds, one model decision, and 20 seconds per OpenRouter call. It disables the scheduler, uses in-memory SQLite and an ephemeral process-local admin token, then checks publication in Discover/detail APIs and requires a follow-up to complete a live search. The report includes per-role primary/fallback model identity, provider attempts and failure categories, stage events, claims, citations, fetch errors, token/cost metrics, failures, and duration; it is saved to ignored `apps/api/evaluation-results/post-agent-production-e2e-report.json`. Run it once; this is not a routine test because it uses real feed/search/model providers.

`eval:quality-smoke` (one current lookup) and `eval:quality` (five research/answer cases) remain available for broader live evaluation. Reports are stored under ignored `apps/api/evaluation-results/` and may be affected by upstream rate limits or network restrictions. A passing citation-format check alone is not proof that every claim is true; inspect semantic verdicts and cited answer/source pairs.

Quality reports include effective per-case budgets and provider-reported token/cost metrics, including usage from failed or truncated model responses. If an answer honestly stops as insufficient because the evaluator's page, query, or step ceiling was exhausted, it is classified as an evaluation-budget limitation rather than a model-quality failure.

## Production roadmap

1. Continue measuring and improving semantic entailment accuracy against real cited answer/source pairs.
2. Run a full backend integration test across auth, queue, worker, research, retrieval, and persistence.
3. Add exports, sharing, billing, and deployment automation only after the core research quality gate is dependable.

See `.env.example` for configuration. Never put provider keys in frontend variables or commit `.env`.
