import { afterEach, describe, expect, it, vi } from "vitest";

const retrieval = vi.hoisted(() => ({ retrieveSource: vi.fn() }));

vi.mock("../src/source-retrieval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/source-retrieval.js")>();
  return { ...actual, retrieveSource: retrieval.retrieveSource };
});

import { createToolRegistry } from "../src/agent/tools.js";
import type { ResearchSession, SearchResult } from "../src/domain.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { auditResearchCitations, OpenRouterProvider } from "../src/llm.js";
import { QuotaPolicy } from "../src/quota-policy.js";
import { hasCitationValidationFailure } from "../src/research.js";
import { createServer, getServerBackgroundServices } from "../src/server.js";
import { SourceRetrievalError, type RetrievedSource } from "../src/source-retrieval.js";
import type { KnowledgeStore, StoredDocument } from "../src/store.js";
import { SqliteSessionStore } from "../src/store.js";
import type { UserMemoryService } from "../src/memory.js";
import type { SearchProvider } from "../src/search.js";

const owner = { id: "durable-retrieval-fixture-user", token: "durable-retrieval-fixture-token" };
const officialUrl = "https://react.dev/versions";
const officialPriorReleaseUrl = "https://react.dev/blog/fixture-prior-release";
const officialReleaseUrl = "https://react.dev/blog/fixture-release";
const officialHistoryUrl = "https://react.dev/versions/history";
const genericUrl = "https://blog.example/react-overview";
const wikipediaUrl = "https://en.wikipedia.org/wiki/React_(software)";
const reactNativeUrl = "https://reactnative.dev/releases/overview";
const misleadingDiscoveryUrl = "https://release-index.example/releases/overview";
const question =
  "Investigate the latest stable React release using official React release sources; verify the version and release date, then cite the supporting evidence.";
const officialContent =
  "React 19.3.0 is the latest stable release, released on October 12, 2025, and the official React release announcement identifies it as the current version.";
const completeOfficialHistoryContent = [
  "Complete official stable release history",
  "React 19.2.0 is a stable release, released on 2025-09-15.",
  "React 19.3.0 is a stable release, released on 2025-10-12.",
].join("\n");
const priorReleaseContent =
  "React 19.2.0 is a stable release, published on September 15, 2025, according to the official React release announcement.";
const incompleteOfficialContent =
  "The official React documentation describes its stable release channel and links to version announcements and support information.";

class OfflineModel extends OpenRouterProvider {
  completionCalls = 0;

  override get enabled() {
    return false;
  }

  override async complete(_system: string, _user: string): Promise<string> {
    this.completionCalls += 1;
    throw new Error("The provider-free fixture must not call OpenRouter");
  }
}

function retrievedSource(
  url: string,
  content: string,
  title: string,
  domain = "react.dev",
): RetrievedSource {
  return {
    url,
    html: "<article>Deterministic official release fixture</article>",
    contentType: "text/html",
    document: {
      title,
      description: "Official React release history and announcement links.",
      domain,
      canonicalUrl: url,
      content,
      headings: [title],
      contentType: "html",
    },
    retrievalMethod: "http",
    retrievalAttempts: ["serper_snippet", "rss", "structured", "http"],
    retrievalMethodsSkipped: ["browser"],
    retrievalReasons: ["Fixture supplied useful official release text after weak cache data."],
    extractionConfidence: 0.95,
    extractionStatus: "SUCCEEDED",
    retrievedContentLength: content.length,
  };
}

function storedDocument(
  url: string,
  title: string,
  content: string,
  domain: string,
): StoredDocument {
  const now = new Date().toISOString();
  return {
    url,
    title,
    content,
    rawHtml: "",
    fetchedAt: now,
    lastVerifiedAt: now,
    metadata: { contentType: "html", domain },
    contentHash: `fixture-${domain}`,
    version: 1,
  };
}

async function waitForTerminalJob(app: Awaited<ReturnType<typeof createServer>>, jobId: string) {
  const { jobStore } = getServerBackgroundServices(app);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const job = await jobStore.getJob(jobId);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Durable retrieval fixture job did not reach a terminal state");
}

describe("durable worker version/date retrieval regression", () => {
  let app: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("rejects generic cache and sibling sources, continues past incomplete extraction, and cites verified facts", async () => {
    retrieval.retrieveSource.mockReset();
    retrieval.retrieveSource.mockImplementation(async ({ result }: { result: SearchResult }) => {
      if (result.url === genericUrl) {
        throw new SourceRetrievalError(
          "The source did not yield useful release evidence",
          ["serper_snippet", "rss", "structured", "http"],
          ["browser"],
          ["No requested version or release date was present."],
        );
      }
      if (result.url === officialUrl) {
        return retrievedSource(result.url, incompleteOfficialContent, "React Versions");
      }
      if (result.url === officialPriorReleaseUrl) {
        return retrievedSource(result.url, priorReleaseContent, "React 19.2 release announcement");
      }
      if (result.url === officialReleaseUrl) {
        return retrievedSource(result.url, officialContent, "React release announcement");
      }
      if (result.url === officialHistoryUrl) {
        return {
          ...retrievedSource(
            result.url,
            completeOfficialHistoryContent,
            "React complete official stable release history",
          ),
          releaseHistorySourceKind: "official_history_page",
          releaseHistoryComplete: true,
        };
      }
      throw new Error(`Unexpected source selected by task triage: ${result.url}`);
    });

    const store = new SqliteSessionStore(":memory:");
    await store.saveDocument({
      url: genericUrl,
      title: "React overview",
      content:
        "React is a library for building user interfaces with reusable components and declarative updates.",
      rawHtml: "",
      fetchedAt: new Date().toISOString(),
      metadata: { contentType: "html", domain: "blog.example" },
    });
    await store.saveDocument({
      url: officialUrl,
      title: "React Versions",
      content: incompleteOfficialContent,
      rawHtml: "",
      fetchedAt: new Date().toISOString(),
      metadata: { contentType: "html", domain: "react.dev" },
    });

    const knowledge: KnowledgeStore = {
      getDocument: (url) => store.getDocument(url),
      saveDocument: (document) => store.saveDocument(document),
      searchDocuments: async () => [],
    };
    const searchQueries: string[] = [];
    const initialResults: SearchResult[] = [
      {
        title: "React latest stable version and release date — Wikipedia",
        url: wikipediaUrl,
        snippet:
          "React latest stable version and release date details, with an overview of the JavaScript library.",
        provider: "serper-fixture",
        engine: "google-fixture",
        position: 1,
      },
      {
        title: "React Versions — Official React Documentation",
        url: officialUrl,
        snippet:
          "The official React versions page lists stable releases and release announcements.",
        provider: "serper-fixture",
        engine: "google-fixture",
        position: 2,
      },
      {
        title: "React 19.2 official release announcement",
        url: officialPriorReleaseUrl,
        snippet: "React 19.2.0 is a stable release, published September 15, 2025.",
        provider: "serper-fixture",
        engine: "google-fixture",
        position: 3,
      },
    ];
    const recoveryResults: SearchResult[] = [
      {
        title: "React 19.3.0 official release announcement",
        url: officialReleaseUrl,
        snippet: "React 19.3.0 is the latest stable release, released on October 12, 2025.",
        provider: "serper-fixture",
        engine: "google-fixture",
        position: 1,
      },
      {
        title: "React complete official stable release history",
        url: officialHistoryUrl,
        snippet: "Complete official stable release history with versioned release dates.",
        provider: "serper-fixture",
        engine: "google-fixture",
        position: 2,
      },
    ];
    const searchProvider: SearchProvider = {
      search: async (query) => {
        searchQueries.push(query);
        return searchQueries.length === 1 ? initialResults : recoveryResults;
      },
    };
    const model = new OfflineModel();
    const tools = createToolRegistry(searchProvider, model, knowledge);
    tools.register({
      name: "verify_claims_batch",
      description: "Deterministically verify facts against the fixture source text.",
      execute: async (input) =>
        (input as { claims: Array<{ id: string; claim: string; evidence: string }> }).claims.map(
          ({ id, claim, evidence }) => ({
            id,
            verdict: /React/i.test(claim) && evidence.includes(claim) ? "supported" : "uncertain",
            rationale: "Checked against the deterministic official-source fixture.",
          }),
        ),
    });

    const genericError = await tools
      .execute("fetch_url", {
        url: genericUrl,
        title: "React overview",
        snippet: "An overview of React components and interface development.",
        question,
      })
      .catch((error: unknown) => error);
    expect(genericError).toBeInstanceOf(SourceRetrievalError);
    expect((genericError as SourceRetrievalError).attempts).toContain("cache");

    const officialCacheResult = (await tools.execute("fetch_url", {
      url: officialUrl,
      title: "React Versions — Official React Documentation",
      snippet: "The official React versions page lists stable releases and release announcements.",
      question,
    })) as RetrievedSource & { cached: boolean };
    expect(officialCacheResult.cached).toBe(false);
    expect(officialCacheResult.retrievalMethod).toBe("http");
    expect(officialCacheResult.retrievalAttempts[0]).toBe("cache");

    retrieval.retrieveSource.mockClear();
    const memoryService = {
      enabled: false,
      retrieveForQuestion: async () => ({ needed: false, memories: [] }),
    } as unknown as UserMemoryService;
    const quotaPolicy = new QuotaPolicy(
      JSON.stringify({
        default: {
          quotas: {
            research: { limit: 2, windowSeconds: 3600 },
            deep_research: { limit: 2, windowSeconds: 3600 },
            followup: { limit: 2, windowSeconds: 3600 },
          },
          features: { research: true, deepResearch: true, postFollowUps: true },
        },
      }),
    );

    app = await createServer({
      store,
      jobStore: new InMemoryDurableJobStore(),
      searchProvider,
      llmProvider: model,
      toolRegistry: tools,
      memoryService,
      quotaPolicy,
      authVerifier: {
        verifyAccessToken: async (token) => (token === owner.token ? { id: owner.id } : undefined),
      },
      researchBudget: {
        maxSteps: 40,
        maxQueries: 5,
        maxSources: 5,
        maxPages: 5,
        maxClaimsToVerify: 4,
        maxTimeMs: 7000,
        maxModelDecisions: 0,
        maxSearchPasses: 4,
      },
      evaluationBudgetCeilings: {
        maxSteps: 40,
        maxQueries: 5,
        maxSources: 5,
        maxPages: 5,
        maxClaimsToVerify: 4,
        maxTimeMs: 7000,
        maxModelDecisions: 0,
        maxSearchPasses: 4,
      },
    });

    const queued = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { message: question, deepResearch: false },
    });
    expect(queued.statusCode).toBe(202);
    const { jobId, researchId } = queued.json<{ jobId: string; researchId: string }>();
    const { worker, jobStore } = getServerBackgroundServices(app);
    worker.start();

    const job = await waitForTerminalJob(app, jobId);

    const response = await app.inject({
      method: "GET",
      url: `/api/research/${researchId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(response.statusCode).toBe(200);
    const session = response.json<ResearchSession>();
    expect(job, JSON.stringify({ job, session })).toMatchObject({ status: "completed" });
    expect(job.result?.status).toBe("COMPLETED");

    expect(searchQueries).toHaveLength(2);
    expect(searchQueries.length).toBeLessThan(5);
    expect(searchQueries[0]).toContain("React");
    expect(searchQueries[0]).toContain("latest stable version");
    expect(searchQueries[0]).toContain("release date");
    expect(searchQueries[0]).toContain("official source");
    expect(searchQueries[1]).not.toBe(searchQueries[0]);
    expect(searchQueries[1]).toContain("latest stable");
    expect(searchQueries[1]).toContain("newer than 19.2.0");
    expect(searchQueries[1]).toContain("official release notes history");
    expect(session.plan?.queries[0]).toBe(searchQueries[0]);
    expect(session.plan?.queries).toContain(searchQueries[1]);
    expect(session.plan?.interpretation.entities).toContain("React");
    expect(session.plan?.interpretation.sourceRequirements?.officialSources).toBe("required");
    expect(session.plan?.requestedFacts).toEqual([
      "version",
      "release date",
      "stable status",
      "latestness",
    ]);
    expect(session.plan?.requestedFactRequirements).toMatchObject({
      version: true,
      releaseDate: true,
      stable: true,
      latest: true,
    });
    expect(session.plan?.structuredObjectives?.map((objective) => objective.category)).toEqual([
      "status",
      "release_date",
      "documentation",
    ]);
    expect(session.plan?.objectives.join(" ")).not.toMatch(
      /capabilit|benchmark|trade-off|limitation|comparison review|production analysis/i,
    );
    expect(session.state?.requestedFactCoverage).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: ["version", "release date", "stable status", "latestness"],
      missing: [],
    });
    const decisionActions = session.decisions?.map((decision) => decision.nextAction) ?? [];
    expect(decisionActions.indexOf("verify_claims")).toBeLessThan(
      decisionActions.indexOf("search_again"),
    );
    expect(
      session.decisions?.filter((decision) => decision.nextAction === "search_again"),
    ).toHaveLength(1);
    expect(
      session.decisions?.find((decision) => decision.nextAction === "search_again")?.reason,
    ).toContain("latestness remains unresolved");
    expect(session.searchRecoveries).toEqual([
      expect.objectContaining({
        missingRequestedFacts: ["latestness"],
        officialSourceRequirement: "required",
        queries: [searchQueries[1]],
        requirements: expect.objectContaining({
          requestedFacts: ["version", "release date", "stable status", "latestness"],
          resolvedFacts: ["version", "release date", "stable status"],
          unresolvedFacts: ["latestness"],
          latestnessRequired: true,
          latestnessResolved: false,
          knownVersionCandidates: ["19.2.0"],
          qualifiers: { latest: true, stable: true },
          officialEvidenceResolved: true,
        }),
        queryValidation: expect.objectContaining({ accepted: true, reasons: [] }),
      }),
    ]);
    expect(session.searchRecoveries?.every((recovery) => recovery.queries.length === 1)).toBe(true);
    expect(session.sourceSelectionDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "React latest stable version and release date — Wikipedia",
          url: wikipediaUrl,
          domain: "en.wikipedia.org",
          officialSource: false,
          officialSourceRequirement: "required",
          selected: false,
          reason: expect.stringContaining("requires official sources"),
          taskEvidence: expect.objectContaining({ status: "UNVERIFIED" }),
        }),
        expect.objectContaining({
          url: officialUrl,
          officialSource: true,
          selected: false,
          reason: expect.stringContaining(
            "Previously evaluated source omitted unresolved fact(s): latestness",
          ),
        }),
        expect.objectContaining({
          url: officialReleaseUrl,
          officialSource: true,
          selected: true,
          taskEvidence: expect.objectContaining({
            status: "GENERIC_SUPPORT",
            missingFacts: [
              "the requested latest/stable status is not established by a versioned claim",
            ],
            presentFacts: ["version", "release date", "stable status"],
          }),
          reason: expect.stringContaining("mentions 1/1 requested fact(s)"),
        }),
        expect.objectContaining({
          url: officialHistoryUrl,
          officialSource: true,
          selected: true,
        }),
      ]),
    );
    expect(session.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: officialUrl,
          retrievalMethod: "http",
          extractionStatus: "SUCCEEDED",
          retrievalAttempts: ["cache", "serper_snippet", "rss", "structured", "http"],
          taskEvidence: expect.objectContaining({
            status: "INSUFFICIENT_EVIDENCE",
            missingFacts: expect.arrayContaining([
              "the requested version is not stated in a verified claim",
              "the requested release date is not stated in a verified claim",
            ]),
          }),
        }),
        expect.objectContaining({
          url: officialReleaseUrl,
          taskEvidence: expect.objectContaining({
            status: "GENERIC_SUPPORT",
            missingFacts: [
              "the requested latest/stable status is not established by a versioned claim",
            ],
          }),
        }),
        expect.objectContaining({
          url: officialHistoryUrl,
          releaseHistorySourceKind: "official_history_page",
          releaseHistoryComplete: true,
        }),
      ]),
    );
    expect(session.sources.some((source) => source.url === reactNativeUrl)).toBe(false);
    expect(session.sources.some((source) => source.url === wikipediaUrl)).toBe(false);
    expect(session.claims.length).toBeGreaterThanOrEqual(3);
    expect(session.claims.some((claim) => claim.verification?.verdict === "supported")).toBe(true);
    expect(
      session.claims
        .filter((claim) => claim.verification)
        .every((claim) => claim.verification?.verdict === "supported"),
    ).toBe(true);
    expect(session.claims.map((claim) => claim.text).join(" ")).toContain("React 19.2.0");
    expect(session.claims.map((claim) => claim.text).join(" ")).toContain("React 19.3.0");
    expect(session.claims.map((claim) => claim.text).join(" ")).toContain("October 12, 2025");
    expect(session.answer).toContain("React 19.3.0");
    expect(session.answer).toContain("October 12, 2025");
    expect(session.state?.latestnessAssessment).toMatchObject({
      conclusion: "PROVEN",
      proof: "complete-official-history",
      latestVersion: "19.3.0",
    });
    expect(session.state?.latestnessAssessment?.comparisons).toEqual([
      expect.objectContaining({ olderVersion: "19.2.0", newerVersion: "19.3.0" }),
    ]);
    expect(session.state?.releaseRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "React",
          version: "19.2.0",
          releaseDate: "2025-09-15",
          dateAssociationReason: "versioned-release-statement",
          stability: "stable",
          officialSource: true,
        }),
        expect.objectContaining({
          entity: "React",
          version: "19.3.0",
          releaseDate: "2025-10-12",
          dateAssociationReason: "versioned-release-statement",
          stability: "stable",
          latestnessEvidence: expect.stringContaining("latest stable release"),
          sourceId: expect.any(String),
          sourceType: "official",
          officialSource: true,
        }),
      ]),
    );
    expect(session.state?.latestnessAssessment?.releaseRecords).toEqual(
      session.state?.releaseRecords,
    );
    const officialSourceNumber =
      session.sources.findIndex((source) => source.url === officialReleaseUrl) + 1;
    expect(officialSourceNumber).toBeGreaterThan(0);
    expect(session.answer).toContain(`[${officialSourceNumber}]`);
    expect(session.state?.evidenceStatus).toBe("SUPPORTED_EVIDENCE");
    expect(auditResearchCitations(session.answer ?? "", session.sources.length)).toEqual({
      invalidMarkers: [],
      uncitedSentences: [],
    });
    expect(
      hasCitationValidationFailure(
        undefined,
        undefined,
        session.answer ?? "",
        session.sources.length,
      ),
    ).toBe(false);
    const semanticCitationReport = model.metrics.citationEntailment;
    expect(semanticCitationReport?.status, JSON.stringify(semanticCitationReport, null, 2)).toBe(
      "VALIDATED",
    );
    expect(model.completionCalls).toBe(0);
    expect(retrieval.retrieveSource).toHaveBeenCalledTimes(4);
    expect(await jobStore.getJob(jobId)).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("fails closed when official 19.2 evidence has no latestness proof and recovery is non-official", async () => {
    retrieval.retrieveSource.mockReset();
    retrieval.retrieveSource.mockImplementation(async ({ result }: { result: SearchResult }) => {
      if (result.url === officialUrl) {
        return retrievedSource(result.url, incompleteOfficialContent, "React Versions");
      }
      if (result.url === officialPriorReleaseUrl) {
        return retrievedSource(result.url, priorReleaseContent, "React 19.2 release announcement");
      }
      throw new Error(`Unexpected source selected by latestness failure fixture: ${result.url}`);
    });

    const store = new SqliteSessionStore(":memory:");
    const searchQueries: string[] = [];
    const searchProvider: SearchProvider = {
      search: async (query) => {
        searchQueries.push(query);
        return searchQueries.length === 1
          ? [
              {
                title: "React Versions — Official React Documentation",
                url: officialUrl,
                snippet: "The official React versions page links to stable release announcements.",
                provider: "serper-fixture",
                engine: "google-fixture",
              },
              {
                title: "React 19.2 official release announcement",
                url: officialPriorReleaseUrl,
                snippet: "React 19.2.0 is a stable release, published September 15, 2025.",
                provider: "serper-fixture",
                engine: "google-fixture",
              },
            ]
          : [
              {
                title: "Independent React version tracker",
                url: misleadingDiscoveryUrl,
                snippet:
                  "React 19.3.0 is the latest stable release, published on October 12, 2025, according to this independent tracker.",
                provider: "serper-fixture",
                engine: "google-fixture",
              },
            ];
      },
    };
    const model = new OfflineModel();
    const tools = createToolRegistry(searchProvider, model, {
      getDocument: (url) => store.getDocument(url),
      saveDocument: (document) => store.saveDocument(document),
      searchDocuments: async () => [],
    });
    tools.register({
      name: "verify_claims_batch",
      description: "Deterministically verify official version/date fixture claims.",
      execute: async (input) =>
        (input as { claims: Array<{ id: string; claim: string; evidence: string }> }).claims.map(
          ({ id, claim, evidence }) => ({
            id,
            verdict: /React/i.test(claim) && evidence.includes(claim) ? "supported" : "uncertain",
            rationale: "Checked against deterministic official-source text.",
          }),
        ),
    });
    const memoryService = {
      enabled: false,
      retrieveForQuestion: async () => ({ needed: false, memories: [] }),
    } as unknown as UserMemoryService;
    const quotaPolicy = new QuotaPolicy(
      JSON.stringify({
        default: {
          quotas: {
            research: { limit: 2, windowSeconds: 3600 },
            deep_research: { limit: 2, windowSeconds: 3600 },
            followup: { limit: 2, windowSeconds: 3600 },
          },
          features: { research: true, deepResearch: true, postFollowUps: true },
        },
      }),
    );

    app = await createServer({
      store,
      jobStore: new InMemoryDurableJobStore(),
      searchProvider,
      llmProvider: model,
      toolRegistry: tools,
      memoryService,
      quotaPolicy,
      authVerifier: {
        verifyAccessToken: async (token) => (token === owner.token ? { id: owner.id } : undefined),
      },
      researchBudget: {
        maxSteps: 14,
        maxQueries: 2,
        maxSources: 3,
        maxPages: 3,
        maxClaimsToVerify: 4,
        maxTimeMs: 7000,
        maxModelDecisions: 0,
        maxSearchPasses: 2,
      },
    });

    const queued = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { message: question, deepResearch: false },
    });
    expect(queued.statusCode).toBe(202);
    const { jobId, researchId } = queued.json<{ jobId: string; researchId: string }>();
    const { worker, jobStore } = getServerBackgroundServices(app);
    worker.start();

    const job = await waitForTerminalJob(app, jobId);
    expect(job.status).toBe("failed");

    const response = await app.inject({
      method: "GET",
      url: `/api/research/${researchId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(response.statusCode).toBe(200);
    const session = response.json<ResearchSession>();

    expect(searchQueries).toHaveLength(2);
    expect(searchQueries[1]).not.toBe(searchQueries[0]);
    expect(searchQueries[1]).toContain("newer than 19.2.0");
    expect(searchQueries[1]).toContain("official release notes history");
    expect(session.searchRecoveries).toEqual([
      expect.objectContaining({
        officialSourceRequirement: "required",
        queries: [searchQueries[1]],
        requirements: expect.objectContaining({ knownVersionCandidates: ["19.2.0"] }),
      }),
    ]);
    expect(session.sourceSelectionDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: misleadingDiscoveryUrl,
          officialSource: false,
          officialSourceRequirement: "required",
          selected: false,
        }),
      ]),
    );
    expect(session.sources.some((source) => source.url === officialPriorReleaseUrl)).toBe(true);
    expect(session.claims.some((claim) => claim.text.includes("React 19.2.0"))).toBe(true);
    expect(session.state?.latestnessAssessment).toMatchObject({
      conclusion: "UNRESOLVED",
      highestCandidateVersion: "19.2.0",
      unresolvedReasons: [expect.stringContaining("no evidence establishes")],
      unresolvedState: {
        status: "unresolved",
        reason: "incomplete_official_history",
        candidates: [
          expect.objectContaining({
            version: "19.2.0",
            stability: "stable",
            sourceIds: expect.arrayContaining([expect.any(String)]),
          }),
        ],
        recommendedNextAction: "retrieve_additional_official_evidence",
      },
    });
    expect(session.state?.latestnessAssessment?.latestVersion).toBeUndefined();
    expect(session.state?.releaseRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: "19.2.0",
          stability: "stable",
          releaseDate: "2025-09-15",
        }),
      ]),
    );
    expect(session.error).toContain("INSUFFICIENT_EVIDENCE");
    expect(session.state?.evidenceStatus).toBe("GENERIC_SUPPORT");
    expect(session.state?.requestedFactCoverage).toEqual({
      required: ["version", "release date", "stable status", "latestness"],
      present: ["version", "release date", "stable status"],
      missing: ["latestness"],
    });
    expect(session.answer).toContain("Insufficient evidence");
    expect(
      session.decisions?.some(
        (decision) =>
          decision.nextAction === "search_again" &&
          decision.reason.includes("latestness remains unresolved") &&
          decision.reason.includes("retrieve additional official evidence"),
      ),
    ).toBe(true);
    expect(
      session.decisions?.some(
        (decision) =>
          decision.nextAction === "synthesize" &&
          decision.reason.includes("report uncertainty") &&
          decision.reason.includes("incomplete_official_history"),
      ),
    ).toBe(true);
    expect(job.result?.status).not.toBe("COMPLETED");
    expect(model.completionCalls).toBe(0);
    expect(retrieval.retrieveSource).toHaveBeenCalledTimes(2);
    expect(await jobStore.getJob(jobId)).toMatchObject({ status: "failed", attempts: 1 });
  });
});
