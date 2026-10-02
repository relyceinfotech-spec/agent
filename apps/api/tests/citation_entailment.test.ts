import { describe, expect, it, vi } from "vitest";
import type { Source } from "../src/domain.js";
import { validateCitationEntailment } from "../src/citation-entailment.js";

function source(id: string, content: string): Source {
  return {
    id,
    title: `${id} documentation`,
    url: `https://${id}.example.test/docs`,
    domain: `${id}.example.test`,
    snippet: "",
    content,
    quality: { relevance: 1, authority: 1, freshness: 1, completeness: 1, overall: 1 },
  };
}

function judgeWith(
  verdicts: Array<{
    id: string;
    isFactual?: boolean;
    verdict: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "INSUFFICIENT_EVIDENCE";
    rationale?: string;
  }>,
) {
  return vi.fn(async () =>
    JSON.stringify({ judgments: verdicts.map((item) => ({ isFactual: true, ...item })) }),
  );
}

describe("citation entailment quality gate", () => {
  it("treats a fail-closed insufficient-evidence response as process disclosure", async () => {
    const answer =
      "Insufficient evidence to provide a verified answer: the release date and latestness are not established.";
    const report = await validateCitationEntailment(answer, [
      source("react", "React documentation."),
    ]);

    expect(report.status).toBe("VALIDATED");
    expect(report.items).toEqual([
      expect.objectContaining({
        text: answer,
        isFactual: false,
        verdict: "SUPPORTED",
        method: "non_factual",
      }),
    ]);
  });

  it("accepts exact support locally without spending a model call", async () => {
    const evidence = source("react", "React Native aims for 60 frames per second.");
    const judge = vi.fn();
    const report = await validateCitationEntailment(
      "React Native aims for 60 frames per second [1].",
      [evidence],
      judge,
    );

    expect(report.status).toBe("VALIDATED");
    expect(report.items[0]).toMatchObject({ verdict: "SUPPORTED", method: "exact_match" });
    expect(judge).not.toHaveBeenCalled();
    expect(report.finalAnswer).toContain("[1]");
  });

  it("accepts a semantically supported paraphrase using the cited source", async () => {
    const evidence = source(
      "react",
      "React Native aims for a target frame rate of 60 frames each second.",
    );
    const judge = judgeWith([
      { id: "answer-1", verdict: "SUPPORTED", rationale: "Equivalent target rate stated." },
    ]);
    const report = await validateCitationEntailment(
      "React Native targets about 60 FPS [1].",
      [evidence],
      judge,
    );

    expect(report.items[0]).toMatchObject({ verdict: "SUPPORTED", method: "model" });
    expect(report.finalAnswer).toContain("React Native targets about 60 FPS [1].");
  });

  it("passes release page provenance to the judge without treating metadata alone as release proof", async () => {
    const evidence = source("react-19-3", "React 19.3 is now available on npm.");
    evidence.title = "React 19.3";
    evidence.url = "https://react.dev/blog/2026/09/09/react-19-3";
    evidence.canonicalUrl = evidence.url;
    evidence.pagePublishedAt = "2026-09-09";
    const judge = vi.fn(async (_system: string, _user: string) =>
      JSON.stringify({
        judgments: [
          {
            id: "answer-1",
            isFactual: true,
            verdict: "SUPPORTED",
            rationale: "Release event and date align.",
          },
        ],
      }),
    );

    const report = await validateCitationEntailment(
      "React 19.3 was released on September 9, 2026 [1].",
      [evidence],
      judge,
    );

    expect(report.items[0]).toMatchObject({ verdict: "SUPPORTED", method: "model" });
    const [systemPrompt, userPrompt] = judge.mock.calls[0] ?? [];
    expect(systemPrompt).toContain(
      "Never infer support from a title, URL, canonical URL, or page publication date alone",
    );
    expect(systemPrompt).toContain(
      "page content also explicitly identifies that version as a release or availability event",
    );
    expect(userPrompt).toContain('"url":"https://react.dev/blog/2026/09/09/react-19-3"');
    expect(userPrompt).toContain('"canonicalUrl":"https://react.dev/blog/2026/09/09/react-19-3"');
    expect(userPrompt).toContain('"pagePublicationDate":"2026-09-09"');
    expect(userPrompt).toContain("React 19.3 is now available on npm.");
  });

  it("checks a parsed npm version against the package and version fields locally", async () => {
    const metadata = source(
      "npm-react",
      "Source: react. Published version or release tag: 19.3.0.",
    );
    metadata.url = "https://registry.npmjs.org/react/latest";
    const judge = vi.fn();
    const report = await validateCitationEntailment(
      "The latest published React release on npm is version 19.3.0 [1].",
      [metadata],
      judge,
    );

    expect(report.items[0]).toMatchObject({ verdict: "SUPPORTED", method: "structured_match" });
    expect(report.items[0]?.text).toBe(
      "The latest published React release on npm is version 19.3.0.",
    );
    expect(judge).not.toHaveBeenCalled();
  });

  it("clearly qualifies partially supported claims", async () => {
    const evidence = source(
      "react",
      "React Native supports profiling tools for performance investigation.",
    );
    const judge = judgeWith([
      {
        id: "answer-1",
        verdict: "PARTIALLY_SUPPORTED",
        rationale: "Profiling is stated; superiority is not.",
      },
    ]);
    const report = await validateCitationEntailment(
      "React Native has profiling tools and is the fastest framework [1].",
      [evidence],
      judge,
    );

    expect(report.status).toBe("PARTIAL");
    expect(report.finalAnswer).toContain("Partially supported by the cited source:");
    expect(report.finalAnswer).toContain("[1]");
  });

  it("removes an unsupported claim and returns insufficiency when nothing remains", async () => {
    const evidence = source(
      "react",
      "React Native is a framework for building native applications.",
    );
    const judge = judgeWith([
      { id: "answer-1", verdict: "UNSUPPORTED", rationale: "The source says nothing about speed." },
    ]);
    const report = await validateCitationEntailment(
      "React Native is faster than Flutter [1].",
      [evidence],
      judge,
    );

    expect(report.status).toBe("REJECTED");
    expect(report.finalAnswer).toContain("evidence is insufficient");
    expect(report.finalAnswer).not.toContain("faster than Flutter");
  });

  it("retains a supported description of conflicting evidence and both citations", async () => {
    const sources = [
      source("bench-a", "Benchmark A found React Native faster on this workload."),
      source("bench-b", "Benchmark B found Flutter faster on a different workload."),
    ];
    const judge = judgeWith([
      { id: "answer-1", verdict: "SUPPORTED", rationale: "Both cited results are represented." },
    ]);
    const report = await validateCitationEntailment(
      "Published benchmarks disagree: one favors React Native, while another favors Flutter [1] [2].",
      sources,
      judge,
    );

    expect(report.items[0]?.sourceIds).toEqual(["bench-a", "bench-b"]);
    expect(report.finalAnswer).toContain("[1] [2]");
    expect(report.finalAnswer).toContain("disagree");
  });

  it("rejects citations that exist but do not support the answer claim", async () => {
    const evidence = source("react", "React Native is used to build native applications.");
    const judge = judgeWith([
      { id: "answer-1", verdict: "UNSUPPORTED", rationale: "No version information in source." },
    ]);
    const report = await validateCitationEntailment(
      "React Native's latest version is 99.0 [1].",
      [evidence],
      judge,
    );

    expect(report.items[0]?.sourceIds).toEqual(["react"]);
    expect(report.items[0]?.verdict).toBe("UNSUPPORTED");
    expect(report.finalAnswer).not.toContain("99.0");
  });

  it("does not let a controller-verified label bind a Node.js 22 claim to Node.js 18 evidence", async () => {
    const node18 = source("node18-eol", "Node.js 18 reached end of life on 2025-04-30.");
    const statement = "Node.js 22 is actively supported until April 2027.";
    const report = await validateCitationEntailment(
      `${statement} [1]`,
      [node18],
      undefined,
      [{ text: statement, sourceIds: [node18.id] }],
      {
        question:
          "According to the official Node.js release schedule, when does Node.js 22 reach end of life?",
        requestedFacts: ["end-of-life date"],
        officialSourcesRequired: false,
        claims: [
          {
            id: "node22-eol",
            text: statement,
            evidence: "Node.js 18 reached end of life on 2025-04-30.",
            sourceIds: [node18.id],
            requestedFacts: ["end-of-life date"],
            confidence: 1,
            verification: { verdict: "supported" },
          },
        ],
      },
    );

    expect(report.status).toBe("REJECTED");
    expect(report.items[0]).toMatchObject({
      verdict: "INSUFFICIENT_EVIDENCE",
      method: "fact_gate",
      factOutcome: "WRONG_VERSION",
    });
  });

  it("rejects an exact Node.js 22 EOL date when the citation only contains Node.js 18's date", async () => {
    const node18 = source(
      "node18-eol",
      "Node.js 22 is supported, while Node.js 18 reached end of life on 2025-04-30.",
    );
    const statement = "Node.js 22 reaches end of life on 2027-04-30.";
    const report = await validateCitationEntailment(
      `${statement} [1]`,
      [node18],
      undefined,
      [{ text: statement, sourceIds: [node18.id] }],
      {
        question:
          "According to the official Node.js release schedule, when does Node.js 22 reach end of life?",
        requestedFacts: ["end-of-life date"],
        officialSourcesRequired: false,
        claims: [
          {
            id: "node22-eol",
            text: statement,
            evidence: node18.content!,
            sourceIds: [node18.id],
            requestedFacts: ["end-of-life date"],
            confidence: 1,
            verification: { verdict: "supported" },
          },
        ],
      },
    );

    expect(report.status).toBe("REJECTED");
    expect(report.items[0]).toMatchObject({
      verdict: "INSUFFICIENT_EVIDENCE",
      method: "fact_gate",
      factOutcome: "WRONG_VERSION",
    });
    expect(report.finalAnswer).not.toContain("2027-04-30");
  });

  it("fails closed instead of skipping extra citations past the per-claim source ceiling", async () => {
    const sources = ["one", "two", "three", "four"].map((id) =>
      source(id, "Claim text is stated exactly."),
    );
    const judge = vi.fn();
    const report = await validateCitationEntailment(
      "Claim text is stated exactly [1] [2] [3] [4].",
      sources,
      judge,
    );

    expect(report.items[0]?.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(report.items[0]?.sourceLimitExceeded).toBe(true);
    expect(judge).not.toHaveBeenCalled();
    expect(report.finalAnswer).toContain("evidence is insufficient");
  });

  it("handles multiple claims with mixed support independently", async () => {
    const evidence = source(
      "facts",
      "React Native supports profiling tools for performance investigation.",
    );
    const judge = judgeWith([
      { id: "answer-2", verdict: "UNSUPPORTED", rationale: "No universal speed result stated." },
    ]);
    const report = await validateCitationEntailment(
      "React Native supports profiling tools for performance investigation [1]. React Native is always faster than Flutter [1].",
      [evidence],
      judge,
    );

    expect(report.items.map((item) => item.verdict)).toEqual(["SUPPORTED", "UNSUPPORTED"]);
    expect(report.finalAnswer).toContain("supports profiling tools");
    expect(report.finalAnswer).not.toContain("always faster");
  });

  it("leaves a direct answer with no factual citations untouched", async () => {
    const report = await validateCitationEntailment("Sure — I can explain that simply.", []);

    expect(report.status).toBe("SKIPPED");
    expect(report.finalAnswer).toBe("Sure — I can explain that simply.");
    expect(report.items).toEqual([]);
  });

  it("fails closed when the semantic judge fails and bounds its output", async () => {
    const evidence = source(
      "react",
      "Documentation describes framework architecture and runtime behavior.",
    );
    const judge = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const report = await validateCitationEntailment(
      "React Native has lower startup latency in every case [1].",
      [evidence],
      judge,
    );

    expect(report.status).toBe("REJECTED");
    expect(report.failure).toContain("provider unavailable");
    expect(report.finalAnswer).toContain("evidence is insufficient");
  });
});
