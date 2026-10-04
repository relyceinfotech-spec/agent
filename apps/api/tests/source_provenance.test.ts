import { describe, expect, it } from "vitest";
import type { Claim, Source } from "../src/domain.js";
import {
  buildClaimSourceReliance,
  isFirstPartySourceForEntities,
  publisherDomainKey,
  qualifySingleThirdPartyClaim,
} from "../src/source-provenance.js";

const fact = "Ukenthiran A is the CEO of Relyce Infotech.";

function source(
  id: string,
  url: string,
  title: string,
  sourceType: Source["sourceType"] = "unknown",
): Source {
  return {
    id,
    url,
    title,
    domain: new URL(url).hostname,
    snippet: fact,
    sourceType,
    quality: { relevance: 0.9, authority: 0.55, freshness: 0.6, completeness: 0.8, overall: 0.75 },
  };
}

function supportedClaim(id: string, sourceId: string): Claim {
  return {
    id,
    text: fact,
    sourceIds: [sourceId],
    evidence: fact,
    confidence: 0.75,
    verification: { verdict: "supported" },
  };
}

describe("source provenance and conservative corroboration", () => {
  it("normalizes subdomains and common multi-label public suffixes", () => {
    expect(publisherDomainKey("in.example.com")).toBe("example.com");
    expect(publisherDomainKey("people.acme.co.uk")).toBe("acme.co.uk");
    expect(publisherDomainKey("other.co.uk")).toBe("other.co.uk");
  });

  it("does not count subdomains of one publisher as independent corroboration", () => {
    const sources = [
      source("company", "https://company.directory.example.com/acme", "Acme company profile"),
      source("people", "https://people.directory.example.com/acme", "Acme staff profile"),
    ];
    const reliance = buildClaimSourceReliance(
      [supportedClaim("claim-company", "company"), supportedClaim("claim-people", "people")],
      sources,
      ["Relyce Infotech"],
    );

    expect(reliance.map((item) => item.independentPublisherCount)).toEqual([1, 1]);
    expect(reliance.every((item) => !item.corroboratedAcrossIndependentPublishers)).toBe(true);
  });

  it("marks identical supported claims corroborated only across distinct publishers", () => {
    const sources = [
      source(
        "directory",
        "https://directory.example/relyce",
        "Relyce company profile",
        "commercial",
      ),
      source("news", "https://newsroom.example/relyce", "Relyce leadership interview", "news"),
    ];
    const reliance = buildClaimSourceReliance(
      [supportedClaim("claim-directory", "directory"), supportedClaim("claim-news", "news")],
      sources,
      ["Relyce Infotech"],
    );

    expect(reliance.map((item) => item.independentPublisherCount)).toEqual([2, 2]);
    expect(reliance.every((item) => item.corroboratedAcrossIndependentPublishers)).toBe(true);
    expect(reliance[0]?.sources[0]).toMatchObject({
      sourceType: "commercial",
      relationshipToEntity: "third_party_or_unclassified",
      authorityScore: 0.55,
    });
  });

  it("qualifies a single third-party precise-fact source instead of overstating certainty", () => {
    const profile = source(
      "profile",
      "https://directory.example/relyce",
      "Relyce Infotech company profile",
      "commercial",
    );
    const [reliance] = buildClaimSourceReliance(
      [supportedClaim("claim", profile.id)],
      [profile],
      ["Relyce Infotech"],
    );

    expect(qualifySingleThirdPartyClaim(fact, reliance)).toBe(
      `A third-party listing at directory.example states that ${fact}`,
    );
  });

  it("leaves first-party and independently corroborated claims unqualified", () => {
    const firstParty = source(
      "official",
      "https://relyceinfotech.com/about",
      "Relyce Infotech leadership",
      "official",
    );
    const officialReliance = buildClaimSourceReliance(
      [supportedClaim("official-claim", firstParty.id)],
      [firstParty],
      ["Relyce Infotech"],
    )[0];
    expect(isFirstPartySourceForEntities(firstParty, ["Relyce Infotech"])).toBe(true);
    expect(qualifySingleThirdPartyClaim(fact, officialReliance)).toBe(fact);

    const first = source(
      "first",
      "https://directory.example/relyce",
      "Relyce profile",
      "commercial",
    );
    const second = source("second", "https://news.example/relyce", "Relyce interview", "news");
    const corroborated = buildClaimSourceReliance(
      [supportedClaim("claim-a", first.id), supportedClaim("claim-b", second.id)],
      [first, second],
      ["Relyce Infotech"],
    )[0];
    expect(qualifySingleThirdPartyClaim(fact, corroborated)).toBe(fact);
  });
});
