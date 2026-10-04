import { describe, expect, it, vi } from "vitest";
import {
  discoverInternalSiteCandidates,
  entityMatchedSiteOrigin,
  type SiteDiscoveryDependencies,
} from "../src/site-discovery.js";

const origin = "https://relyceinfotech.com";
const predicate = {
  entity: "Relyce Infotech",
  predicate: "CEO",
  aliases: ["CEO", "chief executive officer", "chief executive"],
};

function deps(routes: Record<string, { body: string; url?: string; status?: number }>) {
  const fetch = vi.fn(async (url: string) => {
    const route = routes[url];
    return {
      url: route?.url ?? url,
      response: new Response(route?.body ?? "", {
        status: route?.status ?? (route ? 200 : 404),
      }),
      dispose: async () => {},
    };
  });
  return { fetch } satisfies SiteDiscoveryDependencies;
}

const page = {
  rootUrl: `${origin}/en`,
  rootTitle: "Relyce Infotech | Technology consulting",
  rootHtml: `
    <nav>
      <a href="/services">Services</a>
      <a href="/company/leadership">Leadership team</a>
      <a href="/about-us">About the company</a>
      <a href="https://profiles.example/relyce">External profile</a>
      <a href="javascript:alert(1)">Unsafe link</a>
    </nav>`,
  entity: predicate.entity,
  predicate,
  maxCandidates: 4,
};

describe("bounded same-site discovery", () => {
  it("recognizes only an entity-matched site host or a declared official source", () => {
    expect(
      entityMatchedSiteOrigin({
        url: `${origin}/en`,
        title: "Relyce Infotech | IT consultancy",
        entities: [predicate.entity],
      }),
    ).toBe(origin);
    expect(
      entityMatchedSiteOrigin({
        url: "https://www.linkedin.com/company/relyce-infotech",
        title: "Relyce Infotech | LinkedIn",
        entities: [predicate.entity],
      }),
    ).toBeUndefined();
    expect(
      entityMatchedSiteOrigin({
        url: "https://company.example/about",
        title: "Relyce Infotech official company page",
        entities: [predicate.entity],
        sourceType: "official",
      }),
    ).toBe("https://company.example");
    expect(
      entityMatchedSiteOrigin({
        url: "http://relyceinfotech.com/en",
        title: "Relyce Infotech",
        entities: [predicate.entity],
      }),
    ).toBeUndefined();
  });

  it("ranks relevant navigation pages and sitemap URLs while rejecting external links", async () => {
    const dependencies = deps({
      [`${origin}/robots.txt`]: {
        body: `User-agent: *\nSitemap: ${origin}/sitemap.xml\nSitemap: https://other.example/sitemap.xml`,
      },
      [`${origin}/sitemap.xml`]: {
        body: `<urlset>
          <url><loc>${origin}/services</loc></url>
          <url><loc>${origin}/company/leadership</loc></url>
          <url><loc>https://elsewhere.example/relyce/leadership</loc></url>
          <url><loc>${origin}/our-story</loc></url>
        </urlset>`,
      },
    });

    const candidates = await discoverInternalSiteCandidates(page, dependencies);

    expect(candidates.map((candidate) => candidate.url)).toEqual([
      `${origin}/company/leadership`,
      `${origin}/about-us`,
      `${origin}/our-story`,
    ]);
    expect(candidates[0]?.title).toContain("Relyce Infotech");
    expect(candidates[0]?.provider).toBe("site-discovery");
    expect(candidates.every((candidate) => new URL(candidate.url).origin === origin)).toBe(true);
    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      `${origin}/sitemap.xml`,
      { method: "GET" },
      3,
      origin,
    );
  });

  it("limits sitemap-index expansion and candidate count", async () => {
    const dependencies = deps({
      [`${origin}/robots.txt`]: { body: `Sitemap: ${origin}/sitemap-index.xml` },
      [`${origin}/sitemap-index.xml`]: {
        body: `<sitemapindex><sitemap><loc>${origin}/nested.xml</loc></sitemap></sitemapindex>`,
      },
      [`${origin}/nested.xml`]: {
        body: `<urlset>${Array.from(
          { length: 12 },
          (_, index) => `<url><loc>${origin}/team/leadership-${index}</loc></url>`,
        ).join("")}</urlset>`,
      },
    });

    const candidates = await discoverInternalSiteCandidates(
      { ...page, rootHtml: "<main>Relyce Infotech</main>", maxCandidates: 2 },
      dependencies,
    );

    expect(candidates).toHaveLength(2);
    expect(dependencies.fetch).toHaveBeenCalledTimes(3);
    expect(dependencies.fetch.mock.calls.every((call) => call[3] === origin)).toBe(true);
  });

  it("rejects a manifest response that leaves the pinned origin", async () => {
    const dependencies = deps({
      [`${origin}/robots.txt`]: {
        body: `Sitemap: ${origin}/sitemap.xml`,
        url: "https://attacker.example/robots.txt",
      },
    });

    const candidates = await discoverInternalSiteCandidates(
      { ...page, rootHtml: "<main>Relyce Infotech</main>" },
      dependencies,
    );

    expect(candidates).toHaveLength(0);
    expect(dependencies.fetch).toHaveBeenCalledTimes(2);
    expect(dependencies.fetch.mock.calls.every((call) => call[3] === origin)).toBe(true);
  });

  it("does not make manifest requests when there is no usable root HTML or page budget", async () => {
    const dependencies = deps({});
    const empty = await discoverInternalSiteCandidates({ ...page, rootHtml: " " }, dependencies);
    const noBudget = await discoverInternalSiteCandidates(
      { ...page, maxCandidates: 0 },
      dependencies,
    );
    expect(empty).toEqual([]);
    expect(noBudget).toEqual([]);
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });
});
