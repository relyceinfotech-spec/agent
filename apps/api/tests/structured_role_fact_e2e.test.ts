import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../src/agent/tools.js";
import type { ResearchSession, ResearchState, Source } from "../src/domain.js";
import { extractHtml } from "../src/extract.js";
import { OpenRouterProvider } from "../src/llm.js";
import { QuotaPolicy } from "../src/quota-policy.js";
import { hasCompleteRequestedFactCoverage } from "../src/requested-facts.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import { SqliteSessionStore } from "../src/store.js";

const question = "Who is the CEO of Relyce Infotech?";
const expectedAnswer = "Ukenthiran A is the Founder & CEO of Relyce Infotech. [1]";
const liveSerializedRoleClaim =
  "@graph.@type: Organization; @graph.name: Relyce Infotech; " +
  "@graph.employee.@type: Person; @graph.employee.name: Ukenthiran A; " +
  "@graph.employee.jobTitle: Founder & CEO";
const acceptanceCases = [
  {
    page: "About",
    sourceUrl: "https://relyceinfotech.com/about",
    retrievalUrl: "https://relyceinfotech.com/about",
    fixture: "./fixtures/relyce-about-jsonld.html",
    seedStaleCoverage: false,
  },
  {
    page: "Services",
    sourceUrl: "https://relyceinfotech.com/services",
    retrievalUrl: "https://relyceinfotech.com/services/",
    fixture: "./fixtures/relyce-services-jsonld.html",
    seedStaleCoverage: true,
  },
  {
    page: "Services live-serialized claim",
    sourceUrl: "https://relyceinfotech.com/services",
    retrievalUrl: "https://relyceinfotech.com/services/",
    fixture: "./fixtures/relyce-services-jsonld.html",
    seedStaleCoverage: true,
    roleClaim: liveSerializedRoleClaim,
  },
  {
    page: "Services serialized role prioritized among generic claims",
    sourceUrl: "https://relyceinfotech.com/services",
    retrievalUrl: "https://relyceinfotech.com/services/",
    fixture: "./fixtures/relyce-services-jsonld.html",
    seedStaleCoverage: true,
    roleClaim: liveSerializedRoleClaim,
    includeGenericClaims: true,
    exerciseFastPath: true,
  },
  {
    page: "Services unsupported live-serialized claim",
    sourceUrl: "https://directory.example/relyce-profile",
    retrievalUrl: "https://directory.example/relyce-profile",
    fixture: "./fixtures/relyce-services-jsonld.html",
    seedStaleCoverage: true,
    roleClaim: liveSerializedRoleClaim,
    verificationVerdict: "uncertain" as const,
    expectedStatus: "FAILED" as const,
    searchTitle: "Relyce Infotech profile on an independent directory",
  },
].map((testCase) => ({
  ...testCase,
  fixtureHtml: readFileSync(new URL(testCase.fixture, import.meta.url), "utf8"),
}));

function offlineProvider() {
  const provider = new OpenRouterProvider();
  vi.spyOn(provider, "enabled", "get").mockReturnValue(false);
  return provider;
}

describe("JSON-LD precise-fact API and durable-worker acceptance", () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it.each(acceptanceCases)(
    "recomputes $page predicate coverage from source-bound role evidence",
    async ({
      page,
      sourceUrl,
      retrievalUrl,
      fixtureHtml,
      seedStaleCoverage,
      roleClaim,
      includeGenericClaims,
      verificationVerdict,
      expectedStatus,
      searchTitle,
      exerciseFastPath,
    }) => {
      const store = new SqliteSessionStore(":memory:");
      const jobStore = store.createJobStore();
      let activeResearchId: string | undefined;
      let releaseFetchGate: () => void = () => {};
      const fetchGate = new Promise<void>((resolve) => {
        releaseFetchGate = resolve;
      });
      const search = {
        search: vi.fn(async () => [
          {
            title: searchTitle ?? `Relyce Infotech | ${page}`,
            url: sourceUrl,
            snippet: `${page} information from Relyce Infotech`,
            provider: "fixture-search",
          },
        ]),
      };
      const llm = offlineProvider();
      if (exerciseFastPath) vi.spyOn(llm, "enabled", "get").mockReturnValue(true);
      const modelComplete = vi.spyOn(llm, "complete");
      if (exerciseFastPath) {
        modelComplete.mockImplementation(async (_system, user) => {
          const allowed = user.match(/Allowed actions:\s*([^\n]+)/)?.[1];
          const firstAllowedAction = allowed?.split(",")[0]?.trim();
          if (!firstAllowedAction) throw new Error("Fast-path fixture had no allowed action");
          return JSON.stringify({ action: firstAllowedAction });
        });
      }
      const tools = createToolRegistry(search, llm, store);
      const verify = vi.fn(async (input: unknown) => {
        const claim = input as { claim: string; evidence: string; sourceIds: string[] };
        expect(claim.claim).toContain("Ukenthiran A");
        expect(claim.claim).toContain("Founder & CEO");
        expect(claim.evidence).toContain("Relyce Infotech");
        expect(claim.sourceIds).toHaveLength(1);
        return {
          claim: claim.claim,
          verdict: verificationVerdict ?? "supported",
          rationale:
            "The extracted JSON-LD links this employee and job title to the requested organization.",
        };
      });

      if (roleClaim) {
        tools.register({
          name: "extract_claims",
          description: "Return the live-shaped flattened structured-role claim.",
          execute: async (input) => {
            const sources = (input as { sources?: Source[] }).sources ?? [];
            return sources.flatMap((source) => [
              ...(includeGenericClaims
                ? [
                    {
                      id: "generic-company-profile",
                      text: "Relyce Infotech provides software and consulting services.",
                      sourceIds: [source.id],
                      evidence: "Relyce Infotech provides software and consulting services.",
                      confidence: 1,
                      importance: "critical" as const,
                    },
                    {
                      id: "generic-company-description",
                      text: "Relyce Infotech offers technology services to businesses.",
                      sourceIds: [source.id],
                      evidence: "Relyce Infotech offers technology services to businesses.",
                      confidence: 1,
                      importance: "critical" as const,
                    },
                    {
                      id: "generic-company-location",
                      text: "Relyce Infotech is based in Chennai.",
                      sourceIds: [source.id],
                      evidence: "Relyce Infotech is based in Chennai.",
                      confidence: 1,
                      importance: "critical" as const,
                    },
                  ]
                : []),
              {
                id: "live-shaped-role-claim",
                text: roleClaim,
                sourceIds: [source.id],
                evidence: roleClaim,
                confidence: 1,
              },
            ]);
          },
        });
      }

      tools.register({
        name: "fetch_url",
        description: "Return sanitized page JSON-LD fixtures without network access.",
        execute: async (input) => {
          const url = (input as { url: string }).url;
          expect(url).toBe(sourceUrl);
          if (seedStaleCoverage) {
            await fetchGate;
            const running = await store.get(activeResearchId!);
            expect(running).toBeDefined();
            await store.update({
              ...running!,
              state: {
                requestedFactCoverage: {
                  required: [],
                  present: [],
                  missing: ["requested predicate"],
                  requestedPredicate: { predicate: "CEO", present: false },
                },
              } as ResearchState,
            });
          }
          return {
            // The Services case models a redirect: the citation keeps the search
            // URL while structured facts are bound to the final retrieval URL.
            url: retrievalUrl,
            html: fixtureHtml,
            contentType: "text/html",
            document: extractHtml(fixtureHtml, new URL(retrievalUrl)),
            retrievalMethod: "http",
            retrievalAttempts: ["http"],
            retrievalMethodsSkipped: ["browser"],
            retrievalReasons: ["Loaded the checked-in sanitized fixture."],
            extractionStatus: "SUCCEEDED",
          };
        },
      });
      tools.register({
        name: "verify_claim",
        description: "Deterministic verification for the source-bound fixture fact.",
        execute: verify,
      });
      tools.register({
        name: "detect_conflict",
        description: "No contrary claim exists in this single-source fixture.",
        execute: async () => [],
      });
      tools.register({
        name: "synthesize",
        description: "Return the answer from the verified fixture claim with its source citation.",
        execute: async (input) => {
          const payload = input as {
            claims: Array<{ sourceIds: string[] }>;
            sources: Source[];
          };
          expect(
            payload.sources.some(
              (source) =>
                source.url === sourceUrl &&
                payload.claims.some((claim) => claim.sourceIds.includes(source.id)),
            ),
          ).toBe(true);
          return expectedAnswer;
        },
      });

      app = await createServer({
        store,
        jobStore,
        searchProvider: search,
        llmProvider: llm,
        toolRegistry: tools,
        authVerifier: {
          verifyAccessToken: async (token) =>
            token === "fixture-token" ? { id: "fixture-user" } : undefined,
        },
        memoryService: {
          enabled: false,
          retrieveForQuestion: async () => ({ needed: false, memories: [] }),
        } as never,
        quotaPolicy: new QuotaPolicy(
          JSON.stringify({
            default: {
              quotas: {
                research: { limit: 10, windowSeconds: 3600 },
                deep_research: { limit: 10, windowSeconds: 3600 },
                followup: { limit: 10, windowSeconds: 3600 },
              },
              features: { research: true, deepResearch: true, postFollowUps: true },
            },
          }),
        ),
        researchBudget: {
          maxSteps: 18,
          maxQueries: exerciseFastPath ? 2 : 1,
          maxPages: 1,
          maxSources: 1,
          maxSearchPasses: exerciseFastPath ? 1 : 0,
          maxModelDecisions: exerciseFastPath ? 4 : 0,
          maxTimeMs: 5000,
        },
      });

      const queued = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { authorization: "Bearer fixture-token" },
        payload: { message: question, deepResearch: false },
      });
      expect(queued.statusCode).toBe(202);
      const { jobId, researchId } = queued.json<{ jobId: string; researchId: string }>();
      activeResearchId = researchId;
      releaseFetchGate();
      await getServerBackgroundServices(app).worker.runNow(jobId);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await jobStore.getJob(jobId);
        if (current && ["completed", "failed", "cancelled"].includes(current.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const session = await store.get(researchId);
      const job = await jobStore.getJob(jobId);
      const terminalStatus = expectedStatus ?? "COMPLETED";
      expect(job?.status, job?.errorSummary).toBe(
        terminalStatus === "COMPLETED" ? "completed" : "failed",
      );
      expect(session?.status, session?.error).toBe(terminalStatus);
      if (terminalStatus === "FAILED") {
        expect(session?.claims[0]?.verification?.verdict).toBe("uncertain");
        expect(session?.state?.verifiedClaims).toHaveLength(0);
        expect(session?.state?.requestedFactCoverage?.requestedPredicate).toEqual({
          predicate: "CEO",
          present: false,
        });
        expect(session?.answer).toMatch(/insufficient evidence/i);
        const readback = await app.inject({
          method: "GET",
          url: "/api/research/" + researchId,
          headers: { authorization: "Bearer fixture-token" },
        });
        expect(readback.statusCode).toBe(200);
        const persisted = readback.json<ResearchSession>();
        expect(persisted.status).toBe("FAILED");
        expect(persisted.state?.requestedFactCoverage?.requestedPredicate?.present).toBe(false);
        expect(job?.attempts).toBe(1);
        return;
      }

      expect(job?.status, job?.errorSummary).toBe("completed");
      expect(session?.status, session?.error).toBe("COMPLETED");
      expect(session?.answer).toBe(expectedAnswer);
      expect(session?.answer).toContain("[1]");
      expect(session?.sources).toHaveLength(1);
      expect(session?.sources[0]).toMatchObject({
        url: sourceUrl,
        retrievalSourceUrl: retrievalUrl,
        structuredDataPresent: true,
        structuredFacts: [
          expect.objectContaining({
            sourceFormat: "json-ld",
            sourceUrl: retrievalUrl,
            entity: "Relyce Infotech",
            person: "Ukenthiran A",
            jobTitle: "Founder & CEO",
          }),
        ],
      });
      const supportedClaims = session?.claims.filter(
        (claim) => claim.verification?.verdict === "supported",
      );
      expect(supportedClaims).toHaveLength(1);
      expect(supportedClaims?.[0]?.text).toContain("Ukenthiran A");
      expect(supportedClaims?.[0]?.text).toContain("Founder & CEO");
      expect(supportedClaims?.[0]).toMatchObject({
        verification: { verdict: "supported" },
        sourceIds: [session?.sources[0]?.id],
      });
      expect(
        session?.state?.requestedFactCoverage?.requestedPredicate,
        JSON.stringify(
          {
            requirement: session?.plan?.interpretation.requestedPredicate,
            source: {
              url: session?.sources[0]?.url,
              retrievalSourceUrl: session?.sources[0]?.retrievalSourceUrl,
              structuredFacts: session?.sources[0]?.structuredFacts?.length,
            },
            claims: session?.claims.map((claim) => ({
              text: claim.text,
              supported: claim.verification?.verdict === "supported",
              sourceIds: claim.sourceIds,
            })),
          },
          null,
          2,
        ),
      ).toEqual({ predicate: "CEO", present: true });
      expect(hasCompleteRequestedFactCoverage(session?.state?.requestedFactCoverage!)).toBe(true);
      expect(session?.plan?.interpretation.requestedPredicate).toMatchObject({
        entity: "Relyce Infotech",
        predicate: "CEO",
      });
      expect(verify).toHaveBeenCalledTimes(expectedStatus === "FAILED" ? 1 : 0);
      if (exerciseFastPath) {
        expect(modelComplete).toHaveBeenCalledTimes(1);
        expect(modelComplete.mock.calls[0]?.[2]).toMatchObject({
          purpose: "research_action_decision",
        });
      }
      expect(search.search).toHaveBeenCalledTimes(1);

      const readback = await app.inject({
        method: "GET",
        url: `/api/research/${researchId}`,
        headers: { authorization: "Bearer fixture-token" },
      });
      expect(readback.statusCode).toBe(200);
      const persisted = readback.json<ResearchSession>();
      expect(persisted.status).toBe("COMPLETED");
      expect(persisted.answer).toBe(expectedAnswer);
      expect(persisted.state?.requestedFactCoverage?.requestedPredicate?.present).toBe(true);
      expect(session?.sources[0]?.url).toBe(sourceUrl);
      expect(session?.sources[0]?.structuredFacts?.[0]?.sourceUrl).toBe(retrievalUrl);
      expect(
        persisted.claims
          .filter((claim) => claim.verification?.verdict === "supported")
          .every((claim) => claim.sourceIds.includes(persisted.sources[0]!.id)),
      ).toBe(true);
      expect(persisted.sources[0]?.url).toBe(sourceUrl);
    },
  );
});
