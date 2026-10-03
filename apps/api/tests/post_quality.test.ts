import { describe, expect, it } from "vitest";
import type { ResearchSession, Source } from "../src/domain.js";
import type { TopicCandidate } from "../src/content-domain.js";
import { evaluatePostQuality, postFromResearch } from "../src/post-quality.js";

const topic: TopicCandidate = {
  id: "topic-1",
  title: "React rendering performance research",
  url: "https://react.dev/blog/rendering-performance",
  summary: "A current research topic with a verified official source.",
  provider: "fixture-feed",
  publishedAt: new Date().toISOString(),
  discoveredAt: new Date().toISOString(),
  score: 0.9,
  status: "RESEARCHED",
};

function source(id: string, url: string): Source {
  return {
    id,
    title: "Verified rendering performance research",
    url,
    domain: new URL(url).hostname,
    snippet: "Research methodology and measured results",
    content:
      "The research explains rendering performance measurements, the reproducible methodology, the observed results, and limitations for interpreting the benchmark. ".repeat(
        2,
      ),
    quality: { relevance: 0.9, authority: 0.9, freshness: 0.9, completeness: 0.9, overall: 0.9 },
  };
}

function research(answer: string): ResearchSession {
  const sources = [
    source("source-1", topic.url),
    source("source-2", "https://engineering.example.org/rendering-study"),
  ];
  return {
    id: "research-1",
    question: topic.title,
    mode: "deep",
    status: "COMPLETED",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sources,
    claims: sources.map((item, index) => ({
      id: `claim-${index + 1}`,
      text: `The performance study documents its benchmark methodology and measured rendering results for source ${index + 1}.`,
      sourceIds: [item.id],
      evidence: item.content!,
      confidence: 0.9,
      verification: { verdict: "supported" },
    })),
    conflicts: [],
    steps: [],
    answer,
  };
}

describe("autonomous publication quality gate", () => {
  it("does not accept search snippets as fetched publication evidence", () => {
    const session = research("A fully written answer with enough length for review purposes.");
    session.sources = session.sources.map((item) => ({
      ...item,
      retrievalMethod: "serper_snippet",
    }));
    const result = evaluatePostQuality(topic, session, []);

    expect(result.usefulSources).toBe(0);
    expect(result.status).toBe("REQUIRES_RESEARCH");
  });

  it("does not treat a metadata-only source as publishable article evidence", () => {
    const session = research("A fully written answer with enough length for review purposes.");
    session.sources[0]!.contentOrigin = "metadata";

    const result = evaluatePostQuality(topic, session, []);

    expect(result.usefulSources).toBe(1);
    expect(result.status).toBe("REQUIRES_RESEARCH");
    expect(postFromResearch(topic, session).claims.map((claim) => claim.id)).not.toContain(
      "claim-1",
    );
  });

  it("rejects a topic with a malformed publication date at the quality gate", () => {
    const malformedTopic = { ...topic, publishedAt: "not-a-real-date" };

    const result = evaluatePostQuality(
      malformedTopic,
      research("A complete and supported research answer."),
      [],
    );

    expect(result.status).toBe("REQUIRES_RESEARCH");
    expect(result.reasons).toContain("Topic is no longer fresh enough for autonomous publication");
  });

  it("omits superseded current claims while retaining supported historical claims", () => {
    const session = research("A verified release history with current and historical details.");
    const oldRelease =
      "React 18.2.0 is the latest stable release. This historical passage preserves the old release assertion as provenance for the research record.";
    const historical =
      "React 18.2.0 introduced the documented rendering behavior in the earlier release. This passage describes a historical change without presenting it as current.";
    session.sources[0]!.content = oldRelease;
    session.sources[1]!.content = historical;
    session.claims[0] = {
      ...session.claims[0]!,
      text: "React 18.2.0 is the latest stable release.",
      evidence: oldRelease,
      latestnessDisposition: {
        status: "superseded",
        entity: "React",
        acceptedVersion: "19.3.0",
      },
    };
    session.claims[1] = {
      ...session.claims[1]!,
      text: "React 18.2.0 introduced the documented rendering behavior in the earlier release.",
      evidence: historical,
    };

    const result = evaluatePostQuality(topic, session, []);
    const publishedClaims = postFromResearch(topic, session).claims;

    expect(result.status).not.toBe("READY_TO_PUBLISH");
    expect(publishedClaims.map((claim) => claim.id)).toEqual(["claim-2"]);
    expect(publishedClaims[0]?.text).toContain("earlier release");
  });

  it.each([
    "Research collected evidence but cannot present it as sufficiently verified: objective coverage is low.",
    "OpenRouter is not configured, so automated synthesis is unavailable. MAX collected claims and sources.",
    "Model synthesis timed out; MAX is returning only verified, source-linked findings as a partial result.\n\n- Verified finding [1].",
    "I couldn't verify a sufficiently supported answer from the cited source text. The available evidence is insufficient.",
    "Research reached its bounded 8-step budget with 3 claims. Review the evidence and sources collected.",
  ])("refuses to publish an incomplete fallback answer: %s", (answer) => {
    const result = evaluatePostQuality(topic, research(answer), []);

    expect(result.status).toBe("REQUIRES_REVIEW");
    expect(result.reasons).toContain("Research synthesis is incomplete or explicitly uncertain");
  });

  it("rejects a supported Node.js 22 EOL claim when its cited official source only dates Node.js 18", () => {
    const lifecycleTopic: TopicCandidate = {
      ...topic,
      title: "Node.js 22 end-of-life date",
      url: "https://nodejs.org/en/about/previous-releases",
    };
    const session = research(
      "The Node.js 22 schedule was checked against project release evidence.",
    );
    session.question = lifecycleTopic.title;
    const node22 = source("source-1", lifecycleTopic.url);
    node22.sourceType = "official";
    node22.content =
      "Node.js 22 is an active release line. Node.js 18 reached end-of-life on 2025-04-30. This page records release lifecycle information for maintainers and users.";
    session.sources[0] = node22;
    session.claims[0] = {
      ...session.claims[0]!,
      text: "Node.js 22 reaches end-of-life on 2025-04-30.",
      sourceIds: [node22.id],
      evidence: node22.content,
      requestedFacts: ["end-of-life date"],
    };

    const result = evaluatePostQuality(lifecycleTopic, session, []);

    expect(result.status).not.toBe("READY_TO_PUBLISH");
    expect(result.supportedClaims).toBe(1);
    expect(postFromResearch(lifecycleTopic, session).claims.map((claim) => claim.id)).not.toContain(
      "claim-1",
    );
  });

  it("rejects a React claim bound to a React Native passage", () => {
    const session = research("The release update was checked against the cited material.");
    const wrongEntity = source("source-1", topic.url);
    wrongEntity.sourceType = "official";
    wrongEntity.content =
      "React Native 0.80 is now available and documents the mobile framework release, compatibility notes, and migration guidance for application developers.";
    session.sources[0] = wrongEntity;
    session.claims[0] = {
      ...session.claims[0]!,
      text: "React 19.3 is now available with release improvements.",
      sourceIds: [wrongEntity.id],
      evidence: wrongEntity.content,
    };

    const result = evaluatePostQuality(topic, session, []);

    expect(result.status).not.toBe("READY_TO_PUBLISH");
    expect(result.supportedClaims).toBe(1);
    expect(postFromResearch(topic, session).claims.map((claim) => claim.id)).not.toContain(
      "claim-1",
    );
  });

  it("rejects an official Node.js 22 page that mentions the line but omits its requested EOL date", () => {
    const lifecycleTopic: TopicCandidate = {
      ...topic,
      title: "Node.js 22 end-of-life date",
      url: "https://nodejs.org/en/about/previous-releases",
    };
    const session = research("A researched update with the available support evidence.");
    session.question = lifecycleTopic.title;
    const officialSource = source("source-1", lifecycleTopic.url);
    officialSource.sourceType = "official";
    officialSource.content =
      "Node.js 22 is an active LTS release line supported by the project. This official page describes its current lifecycle status and release cadence, but gives no end-of-life date.";
    session.sources[0] = officialSource;
    session.claims[0] = {
      ...session.claims[0]!,
      text: "Node.js 22 reaches end-of-life on 2027-04-30.",
      sourceIds: [officialSource.id],
      evidence: officialSource.content,
      requestedFacts: ["end-of-life date"],
    };

    const result = evaluatePostQuality(lifecycleTopic, session, []);

    expect(result.status).not.toBe("READY_TO_PUBLISH");
    expect(result.supportedClaims).toBe(1);
    expect(postFromResearch(lifecycleTopic, session).claims.map((claim) => claim.id)).not.toContain(
      "claim-1",
    );
  });

  it("accepts an exact Node.js 22 EOL fact when its own cited source supports the same entity, version, and date", () => {
    const lifecycleTopic: TopicCandidate = {
      ...topic,
      title: "Node.js 22 end-of-life date",
      url: "https://nodejs.org/en/about/previous-releases",
    };
    const session = research(
      "The Node.js 22 lifecycle date is verified by the retrieved sources and independently checked against the project schedule.",
    );
    session.question = lifecycleTopic.title;
    const officialSource = source("source-1", lifecycleTopic.url);
    officialSource.sourceType = "official";
    officialSource.content =
      "Node.js 22 reaches end-of-life on 2027-04-30. The project publishes this lifecycle schedule for users and maintainers planning supported upgrades.";
    session.sources[0] = officialSource;
    session.claims[0] = {
      ...session.claims[0]!,
      text: "Node.js 22 reaches end-of-life on 2027-04-30.",
      sourceIds: [officialSource.id],
      evidence: officialSource.content,
      requestedFacts: ["end-of-life date"],
    };

    const result = evaluatePostQuality(lifecycleTopic, session, []);

    expect(result.status).toBe("READY_TO_PUBLISH");
    expect(result.supportedClaims).toBe(2);
    expect(postFromResearch(lifecycleTopic, session).claims.map((claim) => claim.id)).toContain(
      "claim-1",
    );
  });

  it("rejects a citation whose source ID does not contain the claim's bound evidence", () => {
    const session = research(
      "The research results were checked against the cited source material.",
    );
    session.sources[1]!.content =
      "An independent source describes separate benchmark findings and confirms the study context, methodology, and limitations for readers. ".repeat(
        2,
      );
    session.claims[1]!.evidence = session.sources[1]!.content!;
    session.claims[0] = {
      ...session.claims[0]!,
      sourceIds: ["source-2"],
      evidence: session.sources[0]!.content!,
    };

    const result = evaluatePostQuality(topic, session, []);

    expect(result.status).not.toBe("READY_TO_PUBLISH");
    expect(result.supportedClaims).toBe(1);
    expect(postFromResearch(topic, session).claims.map((claim) => claim.id)).not.toContain(
      "claim-1",
    );
  });

  it("does not promote a month-only EOL date to exact support", () => {
    const lifecycleTopic: TopicCandidate = {
      ...topic,
      title: "Node.js 22 end-of-life date",
      url: "https://nodejs.org/en/about/previous-releases",
    };
    const session = research("The Node.js 22 lifecycle date is only partially established.");
    session.question = lifecycleTopic.title;
    const officialSource = source("source-1", lifecycleTopic.url);
    officialSource.sourceType = "official";
    officialSource.content =
      "Node.js 22 reaches end-of-life in April 2027. The project publishes this lifecycle schedule for users and maintainers planning supported upgrades.";
    session.sources[0] = officialSource;
    session.claims[0] = {
      ...session.claims[0]!,
      text: "Node.js 22 reaches end-of-life in April 2027.",
      sourceIds: [officialSource.id],
      evidence: officialSource.content,
      requestedFacts: ["end-of-life date"],
    };

    const result = evaluatePostQuality(lifecycleTopic, session, []);

    expect(result.status).not.toBe("READY_TO_PUBLISH");
    expect(result.supportedClaims).toBe(1);
    expect(postFromResearch(lifecycleTopic, session).claims.map((claim) => claim.id)).not.toContain(
      "claim-1",
    );
  });
});
