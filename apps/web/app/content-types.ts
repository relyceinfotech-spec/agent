export interface PostSource {
  id: string;
  title: string;
  url: string;
  domain: string;
  publishedAt?: string;
  fetchedAt?: string;
  provider?: string;
  providers?: string[];
}

export interface ContentPost {
  id: string;
  title: string;
  summary: string;
  whyItMatters: string;
  findings: Array<{ text: string; citations: number[] }>;
  caveats: string[];
  sources: Array<{
    citation: number;
    title: string;
    url: string;
    domain?: string;
    publishedAt?: string;
    sourceType?: string;
  }>;
  publishedAt: string;
  researchedAt: string;
  category: string;
}

export interface PostFollowUp {
  id: string;
  postId: string;
  question: string;
  status: "QUEUED" | "RESEARCHING" | "SYNTHESIZING" | "COMPLETED" | "FAILED";
  usedLiveResearch: boolean;
  answer?: string;
  error?: string;
  sources?: PostSource[];
}
