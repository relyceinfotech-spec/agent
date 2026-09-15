# Research Agent MAX

Research Agent MAX is an evidence-first research workspace: it plans a question, discovers sources through SearXNG, fetches and cleans pages with SSRF safeguards, ranks sources transparently, extracts evidence, and asks OpenRouter to write a cited report.

## What is implemented

- Next.js web workspace with one autonomous chat input, a Deep Research action, live SSE progress, evidence, and source inspection.
- Installable PWA surface with manifest, icon, theme metadata, and a lightweight service worker.
- Fastify + strict TypeScript API with research jobs, health/readiness endpoints, validation, structured logging, and graceful failure handling.
- SearXNG discovery adapter, URL canonicalization, private-network/SSRF protection, bounded fetching, HTML extraction, source quality scoring, claim extraction, and OpenRouter synthesis.
- Query Understanding before discovery: conservative normalization, high-confidence typo correction, entity/intent/topic extraction, ambiguity scoring, diversified DIRECT/OFFICIAL/RECENT/EXPERT/CONTRARY queries, clarification pauses, and bounded second-pass query rewriting when the first result set is weak.
- One autonomous chat surface: normal Send chooses between direct synthesis and web research; Deep Research forces the larger research budget without becoming a separate agent mode.
- Backend tool registry with `understand_query`, `web_search`, `fetch_url`, `extract_content`, `search_again`, `find_relevant_section`, `extract_claims`, `gather_evidence`, `verify_claim`, `compare_sources`, `detect_conflict`, and `synthesize` capabilities.
- True Autonomous Research Loop v2: the runner observes state and chooses the next action, performs source triage before fetching, maps claims to evidence, verifies bounded claims, preserves conflict records, and adaptively rewrites/searches when evidence is insufficient.
- An in-memory session store keeps the MVP simple; MongoDB persistence, queues, and alternative search/embedding providers remain future extension points.
- Docker Compose for SearXNG only; environment-driven deployment configuration.

The current MVP intentionally uses an in-memory session store and does not require Redis/Valkey or MongoDB. This keeps first boot simple and makes the core pipeline testable. Durable persistence, queues, authentication, usage accounting, uploads, sharing, and vector retrieval are future staged work rather than hidden mock implementations.

## Local setup

Requirements: Node 20+, pnpm 9+, and Docker Desktop for the local SearXNG service.

```bash
pnpm install
Copy-Item .env.example .env
docker compose up -d
pnpm dev
```

Open http://localhost:3000. Set `OPENROUTER_API_KEY` in `.env` for automated synthesis. Without it, the app still performs real discovery, fetching, extraction, ranking, and evidence collection, then clearly reports that synthesis is unavailable.

For the web app, `NEXT_PUBLIC_API_URL` may be set if the API is not at `http://localhost:4000`.

## API

- `GET /health`
- `GET /ready`
- `POST /api/chat` with `{ "message": "...", "deepResearch": false }`
- `POST /api/research` with `{ "question": "...", "mode": "quick" | "deep" }`
- `POST /api/research/:id/clarify` with `{ "answer": "..." }` when the planner marks a request ambiguous
- `GET /api/research`
- `GET /api/research/:id`
- `GET /api/research/:id/events` (SSE)
- `DELETE /api/research/:id`

## Safety and provenance

Retrieved pages are untrusted data and are separated from model instructions. Fetching only permits HTTP(S), rejects credentials, resolves DNS before requests, blocks private/link-local destinations, sets timeouts and a respectful User-Agent, and bounds the number of pages. The synthesis prompt requires citations only from retrieved source IDs; source IDs are generated from canonical URLs.

The raw user sentence is retained as provenance, but it is never sent to the SearXNG adapter. Search receives only planner-generated queries. If the planner cannot confidently interpret a request, the job enters `NEEDS_CLARIFICATION` before any search is performed.

## Autonomous research loop

Research jobs use a bounded observe → decide → act loop rather than a blind fixed chain. The model receives a sanitized research observation and may propose an action; the backend validates it against the current state, evidence-sufficiency guard, and hard budgets before allowing, overriding, or falling back. Quick autonomous research uses smaller budgets; Deep Research uses more queries, sources, pages, verification attempts, and search passes while keeping the same agent brain.

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

`eval:smoke` runs only direct chat, current information, and one compact comparison case. Its controller-enforced budget is three cases, four steps, three queries, two sources, one page, a 30-second session, and a 10-second OpenRouter request timeout. The comparison is intentionally a tool-decision smoke check through its first fetch, not a substitute for a complete evidence-quality run. It records model/tool traces plus model-requested actions and controller allow/override/fallback decisions to `apps/api/evaluation-results/` and never prints credentials.

`eval:real` remains the full bounded seven-case evaluation. Its caps are application-enforced through `EVAL_MAX_RESEARCH_STEPS`, `EVAL_MAX_SEARCH_QUERIES`, `EVAL_MAX_SOURCES`, `EVAL_MAX_PAGES`, `EVAL_MAX_RESEARCH_TIME_MS`, and `EVAL_MAX_CASES`. Controlled weak-result and conflict cases use fixture search/fetch tools while still exercising the configured model for understanding, claims, verification, conflict detection, and synthesis.

## Production roadmap

1. Add MongoDB persistence behind the existing `SessionStore` interface when the product needs durable history.
2. Add authentication, per-user authorization, quotas, cancellation, and durable job queues.
3. Add PDF extraction, semantic chunking/embeddings, conflict records, and stronger claim verification.
4. Add Markdown export, private/public sharing, and Railway service configuration.

See `.env.example` and `docker-compose.yml` for service configuration. Never put provider keys in frontend variables or commit `.env`.
