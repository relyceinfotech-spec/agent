import { describe, expect, it } from "vitest";
import type { Claim, Source } from "../src/domain.js";
import {
  bindVerifiedEndOfLifeClaimToSource,
  buildResearchChatFactBindings,
  enforceResearchChatBoundedFactCoverage,
  evaluateResearchChatLifecycleCitation,
} from "../src/research-chat-fact-gate.js";
import { requestedFactCoverage } from "../src/requested-facts.js";

const question =
  "According to the official Node.js release schedule, when does Node.js 22 reach end of life?";

function source(id: string, content: string, official = true): Source {
  return {
    id,
    title: "Node.js release schedule",
    url: "https://nodejs.org/en/about/previous-releases",
    domain: "nodejs.org",
    snippet: "",
    content,
    sourceType: official ? "official" : "blog",
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
}

function claim(sourceId: string, text: string, evidence: string): Claim {
  return {
    id: `claim-${sourceId}`,
    text,
    evidence,
    sourceIds: [sourceId],
    requestedFacts: ["end-of-life date"],
    confidence: 1,
    verification: { verdict: "supported" },
  };
}

function context(claims: Claim[], officialSourcesRequired = true) {
  return {
    question,
    requestedFacts: ["end-of-life date"],
    claims,
    officialSourcesRequired,
  };
}

describe("Research Chat fact-to-source binding", () => {
  it("rejects month-only EOL values even when entity, version, and support wording match", () => {
    const coverage = requestedFactCoverage(
      question,
      "Node.js 22 is actively supported until April 2027.",
      { requestedFacts: ["end-of-life date"] },
    );

    expect(coverage).toEqual({
      required: ["end-of-life date"],
      present: [],
      missing: ["end-of-life date"],
    });
  });

  it("rejects a Node.js 22 claim when its only official EOL source is for Node.js 18", () => {
    const node18 = source("node18", "Node.js 18 reached end of life on 2025-04-30.");
    const node22 = source("node22", "Node.js 22 entered Maintenance LTS in October 2024.");
    const node22Claim = claim(
      node18.id,
      "Node.js 22 is actively supported until April 2027.",
      "Node.js 18 reached end of life on 2025-04-30.",
    );

    expect(bindVerifiedEndOfLifeClaimToSource(question, node22Claim, node18, true)).toMatchObject({
      outcome: "WRONG_VERSION",
      verificationStatus: "UNVERIFIED",
    });
    expect(
      enforceResearchChatBoundedFactCoverage(
        requestedFactCoverage(question, [node22Claim.text, node22Claim.evidence], {
          requestedFacts: ["end-of-life date"],
        }),
        question,
        [node22Claim],
        [node18, node22],
        true,
      ).missing,
    ).toEqual(["end-of-life date"]);
  });

  it("does not accept a matching Node.js 22 source that omits the EOL fact", () => {
    const source22 = source("node22", "Node.js 22 entered Maintenance LTS in October 2024.");
    const node22Claim = claim(
      source22.id,
      "Node.js 22 reaches end of life on 2027-04-30.",
      "Node.js 22 reaches end of life on 2027-04-30.",
    );

    expect(bindVerifiedEndOfLifeClaimToSource(question, node22Claim, source22, true).outcome).toBe(
      "WRONG_FACT",
    );
    expect(
      enforceResearchChatBoundedFactCoverage(
        requestedFactCoverage(question, [node22Claim.text, source22.content!], {
          requestedFacts: ["end-of-life date"],
        }),
        question,
        [node22Claim],
        [source22],
        true,
      ),
    ).toEqual({
      required: ["end-of-life date"],
      present: [],
      missing: ["end-of-life date"],
    });
  });

  it("does not bind Node.js 18 EOL evidence to an earlier Node.js 22 mention in the same passage", () => {
    const mixedSource = source(
      "mixed-node-lifecycle",
      "Node.js 22 is supported, while Node.js 18 reached end of life on 2025-04-30.",
    );
    const node22Claim = claim(
      mixedSource.id,
      "Node.js 22 reached end of life on 2025-04-30.",
      mixedSource.content!,
    );
    const binding = bindVerifiedEndOfLifeClaimToSource(question, node22Claim, mixedSource, true);

    expect(binding).toMatchObject({
      outcome: "WRONG_VERSION",
      verificationStatus: "UNVERIFIED",
    });
    expect(
      enforceResearchChatBoundedFactCoverage(
        requestedFactCoverage(question, [node22Claim.text, node22Claim.evidence], {
          requestedFacts: ["end-of-life date"],
        }),
        question,
        [node22Claim],
        [mixedSource],
        true,
      ),
    ).toEqual({
      required: ["end-of-life date"],
      present: [],
      missing: ["end-of-life date"],
    });

    const ambiguousSource = source(
      "ambiguous-node-lifecycle",
      "Node.js 22 is supported, Node.js 18 reached end of life on 2025-04-30.",
    );
    const ambiguousClaim = claim(
      ambiguousSource.id,
      "Node.js 22 reached end of life on 2025-04-30.",
      ambiguousSource.content!,
    );
    expect(
      bindVerifiedEndOfLifeClaimToSource(question, ambiguousClaim, ambiguousSource, true),
    ).not.toMatchObject({ outcome: "EXACT_SUPPORT", verificationStatus: "VERIFIED" });
    expect(
      enforceResearchChatBoundedFactCoverage(
        requestedFactCoverage(question, [ambiguousClaim.text, ambiguousClaim.evidence], {
          requestedFacts: ["end-of-life date"],
        }),
        question,
        [ambiguousClaim],
        [ambiguousSource],
        true,
      ).missing,
    ).toEqual(["end-of-life date"]);
  });

  it("accepts only a verified claim, exact date, and same source-bound Node.js 22 row", () => {
    const source22 = source("node22", "Node.js 22 reaches end of life on 2027-04-30.");
    const node22Claim = claim(
      source22.id,
      "Node.js 22 reaches end of life on April 30, 2027.",
      source22.content!,
    );
    const answerStatement = {
      text: "Node.js 22 reaches end of life on April 30, 2027.",
      sourceIds: [source22.id],
    };

    expect(bindVerifiedEndOfLifeClaimToSource(question, node22Claim, source22, true)).toMatchObject(
      {
        value: "2027-04-30",
        evidenceSourceIds: [source22.id],
        verificationStatus: "VERIFIED",
        outcome: "EXACT_SUPPORT",
      },
    );
    expect(
      evaluateResearchChatLifecycleCitation(context([node22Claim]), answerStatement, [source22]),
    ).toMatchObject({ outcome: "EXACT_SUPPORT", value: "2027-04-30" });
    expect(
      buildResearchChatFactBindings(context([node22Claim]), [answerStatement], [source22]),
    ).toMatchObject([{ outcome: "EXACT_SUPPORT", verificationStatus: "VERIFIED" }]);
  });

  it("distinguishes wrong fact, wrong version, and missing citation outcomes", () => {
    const node18 = source("node18", "Node.js 18 reached end of life on 2025-04-30.");
    const answer = "Node.js 22 reaches end of life on 2027-04-30.";
    const node18Claim = claim(node18.id, answer, node18.content!);

    expect(
      evaluateResearchChatLifecycleCitation(
        context([node18Claim]),
        { text: answer, sourceIds: [node18.id] },
        [node18],
      )?.outcome,
    ).toBe("WRONG_VERSION");
    expect(
      evaluateResearchChatLifecycleCitation(context([]), { text: answer, sourceIds: [] }, [])
        ?.outcome,
    ).toBe("MISSING_CITATION");
  });

  it("does not let a non-official cited source satisfy an official-source requirement", () => {
    const unofficial = source(
      "unofficial-node22",
      "Node.js 22 reaches end of life on 2027-04-30.",
      false,
    );
    const node22Claim = claim(unofficial.id, unofficial.content!, unofficial.content!);

    expect(
      evaluateResearchChatLifecycleCitation(
        context([node22Claim], true),
        { text: unofficial.content!, sourceIds: [unofficial.id] },
        [unofficial],
      )?.outcome,
    ).toBe("UNSUPPORTED");
  });
});
