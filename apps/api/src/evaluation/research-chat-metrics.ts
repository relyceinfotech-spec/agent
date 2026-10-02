import type { ResearchDecision, Source } from "../domain.js";

export interface ResearchChatRetrievalMetrics {
  evidenceContentSources: number;
  snippetEvidenceSources: number;
  pageRetrievalSources: number;
  unknownMethodSources: number;
}

export function researchActionsUsed(decisions: ResearchDecision[] = []): number {
  return decisions.filter((decision) => decision.nextAction !== "synthesize").length;
}

export function researchChatRetrievalMetrics(sources: Source[]): ResearchChatRetrievalMetrics {
  const withContent = sources.filter((source) => Boolean(source.content?.trim()));
  const snippets = withContent.filter((source) => source.retrievalMethod === "serper_snippet");
  const pageUrls = new Set(
    sources
      .filter((source) => {
        const attemptedPageRetrieval = source.retrievalAttempts?.some(
          (method) => method !== "serper_snippet",
        );
        if (attemptedPageRetrieval) return true;
        if (source.retrievalMethod) return source.retrievalMethod !== "serper_snippet";
        return Boolean(source.fetchError);
      })
      .map((source) => source.url),
  );

  return {
    evidenceContentSources: withContent.length,
    snippetEvidenceSources: snippets.length,
    pageRetrievalSources: pageUrls.size,
    unknownMethodSources: withContent.filter((source) => !source.retrievalMethod).length,
  };
}
