import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ResearchPost, ResearchFollowUp, TopicCandidate } from "../src/content-domain.js";
import type { ResearchSession, Source } from "../src/domain.js";
import { PostFollowUpService, ResearchPostNotFoundError } from "../src/post-followup.js";
import { validateCitationEntailment } from "../src/citation-entailment.js";
import { SqliteSessionStore } from "../src/store.js";

const directories: string[] = [];
const offlineLlm = {
  enabled: false,
  validateCitedAnswer: (answer: string, sources: Source[]) =>
    validateCitationEntailment(answer, sources),
};
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);

function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), "max-followup-test-"));
  directories.push(directory);
  return new SqliteSessionStore(join(directory, "max.sqlite"));
}

function fixture(): { topic: TopicCandidate; post: ResearchPost } {
  const now = new Date().toISOString();
  const topic: TopicCandidate = {
    id: randomUUID(),
    title: "React rendering research",
    url: "https://react.dev/blog/rendering",
    summary: "Research on rendering performance",
    provider: "test",
    publishedAt: now,
    discoveredAt: now,
    score: 0.9,
    status: "PUBLISHED",
  };
  const source: Source = {
    id: "s1",
    url: topic.url,
    title: topic.title,
    snippet: topic.summary,
    domain: "react.dev",
    content:
      "Rendering performance was measured under controlled conditions. The documented benchmark includes caveats and methodology. ",
    quality: { relevance: 0.9, authority: 0.9, freshness: 0.9, completeness: 0.9, overall: 0.9 },
  };
  const post: ResearchPost = {
    id: randomUUID(),
    topicId: topic.id,
    researchId: randomUUID(),
    title: topic.title,
    summary: "Rendering performance was measured.",
    whyItMatters: "Readers can evaluate the evidence.",
    findings: [
      {
        claimId: "c1",
        text: "Rendering performance was measured under controlled conditions.",
        sourceIds: ["s1"],
      },
    ],
    caveats: [],
    sources: [source],
    claims: [
      {
        id: "c1",
        text: "Rendering performance was measured under controlled conditions.",
        evidence: source.content!,
        sourceIds: ["s1"],
        confidence: 0.9,
        verification: { verdict: "supported" },
      },
    ],
    publishedAt: now,
    researchedAt: now,
    category: "performance",
  };
  return { topic, post };
}

async function waitForFollowUp(store: SqliteSessionStore, id: string): Promise<ResearchFollowUp> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await store.getFollowUp(id);
    if (result && ["COMPLETED", "FAILED"].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Follow-up did not complete");
}

describe("ask about saved research", () => {
  it("uses a typed not-found error only when the requested post is missing", async () => {
    const store = makeStore();
    const service = new PostFollowUpService(
      store,
      { start: vi.fn(), cancel: vi.fn() } as never,
      offlineLlm as never,
    );

    await expect(
      service.ask("missing-post", "What evidence supports this?"),
    ).rejects.toBeInstanceOf(ResearchPostNotFoundError);
    store.close();
  });

  it("answers an evidence question from the saved verified claims without new research", async () => {
    const store = makeStore();
    const { topic, post } = fixture();
    await store.saveTopic(topic);
    await store.savePost(post);
    const research = { start: vi.fn(), cancel: vi.fn() };
    const service = new PostFollowUpService(store, research as never, offlineLlm as never);
    const followUp = await waitForFollowUp(
      store,
      (await service.ask(post.id, "What evidence supports this research?")).id,
    );
    expect(followUp.status).toBe("COMPLETED");
    expect(followUp.usedLiveResearch).toBe(false);
    expect(followUp.answer).toContain("[1]");
    expect(research.start).not.toHaveBeenCalled();
    store.close();
  });

  it("answers singular source-provenance questions from saved research", async () => {
    const store = makeStore();
    const { topic, post } = fixture();
    await store.saveTopic(topic);
    await store.savePost(post);
    const research = { start: vi.fn(), cancel: vi.fn() };
    const service = new PostFollowUpService(store, research as never, offlineLlm as never);

    const followUp = await waitForFollowUp(
      store,
      (await service.ask(post.id, "Which source supports this claim?")).id,
    );

    expect(followUp.status).toBe("COMPLETED");
    expect(followUp.usedLiveResearch).toBe(false);
    expect(followUp.answer).toContain("[1]");
    expect(followUp.answer).toContain("Rendering performance was measured");
    expect(research.start).not.toHaveBeenCalled();
    store.close();
  });

  it("falls back to exact previously verified claims when generated prose cannot be cited", async () => {
    const store = makeStore();
    const { topic, post } = fixture();
    await store.saveTopic(topic);
    await store.savePost(post);
    const validateCitedAnswer = vi.fn(
      async (
        answer: string,
        sources: Source[],
        verifiedStatements: Array<{ text: string; sourceIds: string[] }> = [],
      ) => validateCitationEntailment(answer, sources, undefined, verifiedStatements),
    );
    const llm = {
      enabled: true,
      complete: vi.fn(async () => "React is the fastest UI framework. [1]"),
      validateCitedAnswer,
    };
    const service = new PostFollowUpService(
      store,
      { start: vi.fn(), cancel: vi.fn() } as never,
      llm as never,
    );

    const followUp = await waitForFollowUp(
      store,
      (await service.ask(post.id, "Which source supports this claim?")).id,
    );

    expect(followUp.status).toBe("COMPLETED");
    expect(llm.complete).toHaveBeenCalledOnce();
    expect(validateCitedAnswer).toHaveBeenCalledTimes(2);
    expect(validateCitedAnswer.mock.calls[1]?.[2]).toEqual([
      {
        text: post.claims[0]!.text,
        sourceIds: ["s1"],
      },
    ]);
    expect(followUp.answer).toContain(
      "Rendering performance was measured under controlled conditions.",
    );
    expect(followUp.answer).toContain("[1]");
    expect(followUp.answer).not.toContain("fastest UI framework");
    store.close();
  });

  it("does not repeat a supported claim when its cited source is missing", async () => {
    const store = makeStore();
    const { topic, post } = fixture();
    post.claims[0].sourceIds = ["missing-source"];
    await store.saveTopic(topic);
    await store.savePost(post);
    const service = new PostFollowUpService(
      store,
      { start: vi.fn(), cancel: vi.fn() } as never,
      offlineLlm as never,
    );

    const followUp = await waitForFollowUp(
      store,
      (await service.ask(post.id, "What evidence supports this research?")).id,
    );

    expect(followUp.status).toBe("COMPLETED");
    expect(followUp.answer).toContain("does not contain enough verified evidence");
    expect(followUp.answer).not.toContain("Rendering performance was measured");
    store.close();
  });

  it("continues live research for a current question and combines old and new sources", async () => {
    const store = makeStore();
    const { topic, post } = fixture();
    await store.saveTopic(topic);
    await store.savePost(post);
    const research = {
      start: vi.fn(async () => {
        const now = new Date().toISOString();
        const nextSource: Source = {
          ...post.sources[0],
          id: "s2",
          url: "https://example.org/new-report",
          domain: "example.org",
          title: "New independent report",
          content: "New independent measurements were published in 2026.",
        };
        const session: ResearchSession = {
          id: randomUUID(),
          question: "What changed in 2026?",
          mode: "quick",
          status: "COMPLETED",
          createdAt: now,
          updatedAt: now,
          sources: [nextSource],
          claims: [
            {
              id: "c2",
              text: "New independent measurements were published in 2026.",
              sourceIds: ["s2"],
              evidence: nextSource.content!,
              confidence: 0.9,
              verification: { verdict: "supported" },
            },
          ],
          steps: [],
          answer: "New measurements are documented. [1]",
        };
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(),
    };
    const service = new PostFollowUpService(store, research as never, offlineLlm as never);
    const followUp = await waitForFollowUp(
      store,
      (await service.ask(post.id, "What changed in 2026 after this report?")).id,
    );
    expect(followUp.status).toBe("COMPLETED");
    expect(followUp.usedLiveResearch).toBe(true);
    expect(followUp.sourceIds).toEqual(["s1", "s2"]);
    expect(followUp.answer).toContain("[2]");
    expect(followUp.answer).not.toContain(
      "Rendering performance was measured under controlled conditions",
    );
    expect(research.start).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("labels saved evidence as dated when a current follow-up cannot finish live research", async () => {
    const store = makeStore();
    const { topic, post } = fixture();
    await store.saveTopic(topic);
    await store.savePost(post);
    const research = {
      start: vi.fn(async () => {
        const session: ResearchSession = {
          id: randomUUID(),
          question: "What is the latest rendering performance?",
          mode: "quick",
          status: "FAILED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sources: [],
          claims: [],
          steps: [],
          error: "OpenRouter request timed out",
        };
        await store.create(session);
        return session;
      }),
      cancel: vi.fn(),
    };
    const service = new PostFollowUpService(store, research as never, offlineLlm as never);
    const followUp = await waitForFollowUp(
      store,
      (await service.ask(post.id, "What is the latest rendering performance?")).id,
    );
    expect(followUp.status).toBe("COMPLETED");
    expect(followUp.usedLiveResearch).toBe(false);
    expect(followUp.liveResearchId).toBeDefined();
    expect(followUp.answer).toContain("couldn't verify a current update");
    expect(followUp.answer).toContain("[1]");
    store.close();
  });
});
