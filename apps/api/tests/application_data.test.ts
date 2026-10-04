import { describe, expect, it } from "vitest";
import {
  extractEmbeddedApplicationData,
  extractPublicApplicationData,
} from "../src/application-data.js";
import { extractHtml, validateExtraction } from "../src/extract.js";
import {
  claimTextSupportsStructuredFact,
  extractRequestedPredicate,
  requestedFactCoverage,
  structuredFactMatchesPredicate,
} from "../src/requested-facts.js";

const relyceAboutHtml = `<!doctype html><html><head><title>Relyce Infotech | About</title><script type="application/ld+json">${JSON.stringify(
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Relyce Infotech",
        alternateName: "Relyce",
        description:
          "Relyce Infotech is a technology company specializing in web development, app development, AI solutions, digital marketing, UI/UX design, e-commerce solutions, SaaS development, and IT consulting for startups and SMEs worldwide.",
        foundingDate: "2024-09",
        employee: { "@type": "Person", name: "Ukenthiran A", jobTitle: "Founder & CEO" },
      },
    ],
  },
)}<\/script></head><body><main><h1>About Relyce Infotech</h1><p>Technology and consulting for growing teams.</p></main></body></html>`;

describe("bounded public application-data extraction", () => {
  it("keeps nested source structure so an entity and role stay associated", () => {
    const content = extractPublicApplicationData(
      JSON.stringify({
        data: {
          company: {
            name: "Relyce Infotech",
            leadership: [{ name: "Ukenthiran A", role: "Founder & CEO" }],
          },
        },
      }),
    );

    expect(content).toContain("company.name: Relyce Infotech");
    expect(content).toMatch(
      /Relyce Infotech.*leadership\.name: Ukenthiran A.*leadership\.role: Founder & CEO/,
    );
  });

  it("drops secret and personal-contact fields", () => {
    const content = extractPublicApplicationData(
      JSON.stringify({
        company: "Relyce Infotech",
        ceo: "Ukenthiran A",
        api_key: "secret-api-key-value",
        accessToken: "secret-access-token-value",
        email: "private@example.test",
        phone: "+1 555 0100",
      }),
    );

    expect(content).toContain("Relyce Infotech");
    expect(content).toContain("Ukenthiran A");
    expect(content).not.toContain("secret-api-key-value");
    expect(content).not.toContain("secret-access-token-value");
    expect(content).not.toContain("private@example.test");
    expect(content).not.toContain("555 0100");
  });

  it("parses bounded JSON hydration blocks without executing scripts", () => {
    const html = `<html><head><title>Company</title></head><body><div id="root"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      { props: { company: { name: "Relyce Infotech", ceo: "Ukenthiran A" } } },
    )}</script></body></html>`;

    const embedded = extractEmbeddedApplicationData(html);
    const document = extractHtml(html, new URL("https://relyce.example/about"));

    expect(embedded).toHaveLength(1);
    expect(document.contentType).toBe("structured");
    expect(document.content).toContain("Relyce Infotech");
    expect(document.content).toContain("Ukenthiran A");
    expect(() => validateExtraction(document)).not.toThrow();
  });

  it("normalizes the extracted Relyce JSON-LD employee relation into source-bound role evidence", () => {
    const sourceUrl = "https://relyceinfotech.com/about";
    const question = "Who is the CEO of Relyce Infotech?";
    const requirement = extractRequestedPredicate(question)!;
    const document = extractHtml(relyceAboutHtml, new URL(sourceUrl));
    const fact = document.structuredFacts?.[0];

    expect(document.structuredDataPresent).toBe(true);
    expect(fact).toMatchObject({
      sourceFormat: "json-ld",
      sourceUrl,
      entity: "Relyce Infotech",
      person: "Ukenthiran A",
      relationship: "employee",
      jobTitle: "Founder & CEO",
    });
    expect(document.content).toContain("Structured JSON-LD links Ukenthiran A");
    expect(document.predicateEvidenceContent).not.toContain("Founder & CEO");
    expect(
      requestedFactCoverage(question, document.content, {
        predicateEvidence: [document.predicateEvidenceContent ?? ""],
        structuredFacts: document.structuredFacts,
      }).requestedPredicate,
    ).toEqual({ predicate: "CEO", present: true });
    expect(structuredFactMatchesPredicate(fact!, requirement)).toBe(true);
  });

  it("binds a semicolon-serialized live claim to its structured organization-person-role relation", () => {
    const sourceUrl = "https://relyceinfotech.com/services";
    const question = "Who is the CEO of Relyce Infotech?";
    const requirement = extractRequestedPredicate(question)!;
    const document = extractHtml(relyceAboutHtml, new URL(sourceUrl));
    const fact = { ...document.structuredFacts![0]!, sourceUrl };
    const liveClaim =
      "@graph.@type: Organization; @graph.name: Relyce Infotech; " +
      "@graph.employee.@type: Person; @graph.employee.name: Ukenthiran A; " +
      "@graph.employee.jobTitle: Founder & CEO";

    expect(claimTextSupportsStructuredFact(liveClaim, fact, requirement)).toBe(true);
    expect(
      claimTextSupportsStructuredFact(
        liveClaim.replace("Relyce Infotech", "ITC Infotech"),
        fact,
        requirement,
      ),
    ).toBe(false);
    expect(
      claimTextSupportsStructuredFact(liveClaim, { ...fact, jobTitle: "CTO" }, requirement),
    ).toBe(false);
  });

  it("does not bind a role from another organization or from a JSON-LD description", () => {
    const question = "Who is the CEO of Relyce Infotech?";
    const requirement = extractRequestedPredicate(question)!;
    const sourceUrl = "https://example.org/about";
    const unrelated = extractHtml(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Other Infotech",
        employee: { "@type": "Person", name: "Sudip Singh", jobTitle: "Founder & CEO" },
      })}</script></head><body><main><p>Company profile.</p></main></body></html>`,
      new URL(sourceUrl),
    );
    const descriptionOnly = extractHtml(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Relyce Infotech",
        description: "Our CEO services help customers with executive hiring.",
      })}</script></head><body><main><p>Company profile.</p></main></body></html>`,
      new URL("https://relyceinfotech.com/about"),
    );

    expect(
      requestedFactCoverage(question, unrelated.content, {
        predicateEvidence: [unrelated.predicateEvidenceContent ?? ""],
        structuredFacts: unrelated.structuredFacts,
      }).requestedPredicate?.present,
    ).toBe(false);
    expect(
      requestedFactCoverage(question, descriptionOnly.content, {
        predicateEvidence: [descriptionOnly.predicateEvidenceContent ?? ""],
        structuredFacts: descriptionOnly.structuredFacts,
      }).requestedPredicate?.present,
    ).toBe(false);
    expect(structuredFactMatchesPredicate(unrelated.structuredFacts![0]!, requirement)).toBe(false);
  });

  it("matches the requested role on the correct employee when an organization has several employees", () => {
    const question = "Who is the CTO of Relyce Infotech?";
    const document = extractHtml(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            name: "Relyce Infotech",
            employee: [
              { "@type": "Person", name: "Ukenthiran A", jobTitle: "Founder & CEO" },
              { "@type": "Person", name: "Tamizharuvi P", jobTitle: "CTO" },
            ],
          },
        ],
      })}</script></head><body><main><p>Relyce Infotech team.</p></main></body></html>`,
      new URL("https://relyceinfotech.com/about"),
    );
    const requirement = extractRequestedPredicate(question)!;
    const matches = document.structuredFacts?.filter((fact) =>
      structuredFactMatchesPredicate(fact, requirement),
    );

    expect(matches).toHaveLength(1);
    expect(matches?.[0]).toMatchObject({ person: "Tamizharuvi P", jobTitle: "CTO" });
  });

  it("does not satisfy a CEO request with a source-bound CTO role fact", () => {
    const question = "Who is the CEO of Relyce Infotech?";
    const document = extractHtml(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Relyce Infotech",
        employee: { "@type": "Person", name: "Tamizharuvi P", jobTitle: "CTO" },
      })}</script></head><body><main><p>Relyce Infotech team.</p></main></body></html>`,
      new URL("https://relyceinfotech.com/about"),
    );

    expect(
      requestedFactCoverage(question, document.content, {
        predicateEvidence: [document.predicateEvidenceContent ?? ""],
        structuredFacts: document.structuredFacts,
      }).requestedPredicate?.present,
    ).toBe(false);
  });

  it.each([
    ["CEO", "Founder & CEO"],
    ["Founder", "Founder & CEO"],
    ["CTO", "Chief Technology Officer"],
    ["CFO", "Chief Financial Officer"],
    ["Director", "Managing Director"],
    ["President", "President"],
  ])("matches the requested %s within a linked jobTitle", (requestedRole, jobTitle) => {
    const question = `Who is the ${requestedRole} of Relyce Infotech?`;
    const document = extractHtml(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Relyce Infotech",
        employee: { "@type": "Person", name: "A Person", jobTitle },
      })}</script></head><body><main><p>Company profile.</p></main></body></html>`,
      new URL("https://relyceinfotech.com/about"),
    );
    const requirement = extractRequestedPredicate(question);

    expect(requirement).toBeDefined();
    expect(
      requestedFactCoverage(question, document.content, {
        predicateEvidence: [document.predicateEvidenceContent ?? ""],
        structuredFacts: document.structuredFacts,
      }).requestedPredicate?.present,
    ).toBe(true);
  });

  it("does not combine an organization employee link with a disconnected person's jobTitle", () => {
    const question = "Who is the CEO of Relyce Infotech?";
    const document = extractHtml(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            name: "Relyce Infotech",
            employee: { "@id": "#employee" },
          },
          { "@id": "#employee", "@type": "Person", name: "Ukenthiran A" },
          { "@type": "Person", name: "Someone Else", jobTitle: "CEO" },
        ],
      })}</script></head><body><main><p>Relyce Infotech profile.</p></main></body></html>`,
      new URL("https://relyceinfotech.com/about"),
    );

    expect(document.structuredFacts).toBeUndefined();
    expect(
      requestedFactCoverage(question, document.content, {
        predicateEvidence: [document.predicateEvidenceContent ?? ""],
        structuredFacts: document.structuredFacts,
      }).requestedPredicate?.present,
    ).toBe(false);
  });

  it("ignores malformed and oversized application data", () => {
    expect(extractPublicApplicationData("not-json")).toBeUndefined();
    expect(extractPublicApplicationData(JSON.stringify({ content: "x".repeat(100_000) }))).toBe(
      undefined,
    );
  });
});
