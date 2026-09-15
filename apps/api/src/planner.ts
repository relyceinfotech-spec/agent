import type {
  QueryCategory,
  QueryGroup,
  ResearchMode,
  ResearchPlan,
  SearchResult,
  QueryInterpretation,
  LanguageProfile,
  ResponseFormatPreference,
} from "./domain.js";
import { OpenRouterProvider } from "./llm.js";

const corrections: Record<string, string> = {
  "react natve": "React Native",
  "react-native": "React Native",
  fluter: "Flutter",
  pyton: "Python",
  "java script": "JavaScript",
  "node js": "Node.js",
};
const knownEntities = [
  "React Native",
  "React",
  "Flutter",
  "JavaScript",
  "TypeScript",
  "Python",
  "Node.js",
  "Next.js",
  "Vue",
  "Angular",
  "Svelte",
  "Bun",
  "Deno",
  "Docker",
  "Kubernetes",
  "PostgreSQL",
  "MySQL",
  "MongoDB",
  "Redis",
  "Tailwind CSS",
  "GraphQL",
  "FastAPI",
  "Django",
  "Express",
  "Supabase",
  "Firebase",
  "NocoDB",
  "Rust",
  "Go",
  "Java",
  "Kotlin",
  "Swift",
];

const categories: QueryCategory[] = ["DIRECT", "OFFICIAL", "RECENT", "EXPERT", "CONTRARY"];

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}
function cleanJson(raw: string) {
  return raw.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
}
function unique(values: string[]) {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function detectLanguage(input: string): LanguageProfile {
  // 1. Script checks (Unicode ranges)
  if (/[\u0B80-\u0BFF]/.test(input)) {
    return {
      detected: "ta",
      name: "Tamil",
      respondIn: "Tamil script (தமிழ்). Provide a natural, technically accurate response in Tamil.",
    };
  }
  if (/[\u0900-\u097F]/.test(input)) {
    return {
      detected: "hi",
      name: "Hindi",
      respondIn:
        "Hindi script (हिन्दी). Provide a natural, technically accurate response in Hindi.",
    };
  }
  if (/[\u0C00-\u0C7F]/.test(input)) {
    return {
      detected: "te",
      name: "Telugu",
      respondIn: "Telugu script (తెలుగు).",
    };
  }
  if (/[\u0C80-\u0CFF]/.test(input)) {
    return {
      detected: "kn",
      name: "Kannada",
      respondIn: "Kannada script (ಕನ್ನಡ).",
    };
  }
  if (/[\u0D00-\u0D7F]/.test(input)) {
    return {
      detected: "ml",
      name: "Malayalam",
      respondIn: "Malayalam script (മലയാളം).",
    };
  }

  // 2. Tanglish markers (Tamil in Latin script)
  const tanglishRegex =
    /\b(oda|enna|epdi|epadi|eppadi|sollinga|sollu|sollunga|pannunga|panna|nalla|irukku|irukka|illai|illa|vanthuchu|bro|macha|machan|nanba|thala|theriyuma|paathu|vango|vaanga|podhum|edhuku|engaluku|ungaluku|solren|parunga)\b/i;
  if (tanglishRegex.test(input)) {
    return {
      detected: "ta-Latn",
      name: "Tanglish",
      respondIn:
        "natural conversational Tanglish (Tamil in Latin script), matching user's casual, friendly conversational tone. Keep code and technical terms in English.",
    };
  }

  // 3. Hinglish markers (Hindi in Latin script)
  const hinglishRegex =
    /\b(kya|hai|hain|kaise|batao|bataiye|accha|acha|karo|karna|hoga|chahiye|wala|wali|bhai|yaar|samjhao|dekho|kisme|konsa|kaunsa)\b/i;
  if (hinglishRegex.test(input)) {
    return {
      detected: "hi-Latn",
      name: "Hinglish",
      respondIn:
        "natural conversational Hinglish (Hindi in Latin script), matching user's conversational tone. Keep code and technical terms in English.",
    };
  }

  return {
    detected: "en",
    name: "English",
    respondIn: "clear, concise English",
  };
}

export function detectFormatPreference(
  question: string,
  mode: ResearchMode = "quick",
): ResponseFormatPreference {
  const lower = question.toLowerCase();
  if (
    mode === "deep" ||
    /\b(deep research|in-depth|investigate deeply|comprehensive analysis)\b/i.test(lower)
  ) {
    return "research";
  }
  if (/\b(compare|vs|versus|better|difference between|differences)\b/i.test(lower)) {
    return "comparison";
  }
  if (/\b(code|example|snippet|implement|syntax|how to write|function)\b/i.test(lower)) {
    return "code";
  }
  if (
    /\b(latest version|current version|release date|when was|what version|status of)\b/i.test(
      lower,
    ) ||
    /latest.*version/i.test(lower)
  ) {
    return "lookup";
  }
  return "direct";
}

function heuristicUnderstanding(
  question: string,
  mode: ResearchMode = "quick",
): QueryInterpretation {
  let normalizedQuestion = question.trim();
  const applied: QueryInterpretation["corrections"] = [];
  for (const [from, to] of Object.entries(corrections)) {
    const pattern = new RegExp(`\\b${from.replace(/ /g, "\\s+")}\\b`, "gi");
    if (pattern.test(normalizedQuestion)) {
      normalizedQuestion = normalizedQuestion.replace(pattern, to);
      applied.push({ from, to, confidence: 0.98 });
    }
  }
  normalizedQuestion = normalizedQuestion.replace(/\s+/g, " ").trim();
  const lower = normalizedQuestion.toLowerCase();
  const entities = unique(
    knownEntities.filter((entity) => {
      const pattern = new RegExp(
        `(^|[^a-zA-Z0-9])${entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z0-9]|$)`,
        "i",
      );
      return pattern.test(normalizedQuestion);
    }),
  );
  if (entities.includes("React Native") && entities.includes("React")) {
    const rnIndex = entities.indexOf("React");
    if (rnIndex !== -1 && !new RegExp(`\\bReact\\b(?!\\s+Native)`, "i").test(normalizedQuestion)) {
      entities.splice(rnIndex, 1);
    }
  }
  const compare = /\b(vs|versus|compare|comparison|difference|better|faster|best)\b/i.test(lower);
  const intent = compare
    ? lower.includes("best")
      ? "Evaluate options against decision criteria"
      : "Compare the identified entities"
    : /\b(latest|current|recent|news|version|enna|kya)\b/i.test(lower)
      ? "Find and explain current developments"
      : "Explain and investigate the topic";
  const topic = /\b(performance|speed|latency|benchmark)\b/i.test(lower)
    ? "performance"
    : /\b(ai|machine learning)\b/i.test(lower)
      ? "AI"
      : /\b(backend|server|api)\b/i.test(lower)
        ? "backend"
        : "general topic";
  const timeframe =
    lower.match(/\b20\d{2}\b/)?.[0] ??
    (/\b(latest|current|recent)\b/i.test(lower) ? "latest" : undefined);
  const dimensions = lower.includes("best")
    ? [
        "performance",
        "ecosystem",
        "developer availability",
        "libraries",
        "deployment",
        "scalability",
        "use cases",
      ]
    : topic === "performance"
      ? ["benchmarks", "real-world performance", "architecture", "limitations"]
      : ["capabilities", "trade-offs", "limitations", "recent developments"];
  const reasons: string[] = [];
  let ambiguity = 0;
  if (entities.length === 0) {
    ambiguity += 0.28;
    reasons.push("No high-confidence entities were identified");
  }
  if (compare && entities.length < 2) {
    ambiguity += 0.28;
    reasons.push("The comparison target is incomplete");
  }
  if (
    compare &&
    lower.includes("better") &&
    !lower.match(
      /\b(performance|cost|security|speed|scalability|use case|ecosystem|developer availability|libraries|deployment)\b/,
    )
  ) {
    ambiguity += 0.65;
    reasons.push("The comparison criterion is unspecified");
  }
  if (normalizedQuestion.split(/\s+/).length < 4) {
    ambiguity += 0.16;
    reasons.push("The request is very short");
  }
  if (applied.length > 0) ambiguity += 0.04;
  ambiguity = clamp(ambiguity);
  const needsClarification = ambiguity >= 0.6;
  const language = detectLanguage(question);
  const formatPreference = detectFormatPreference(question, mode);
  return {
    normalizedQuestion,
    intent,
    entities,
    topic,
    timeframe,
    dimensions,
    corrections: applied,
    ambiguityScore: ambiguity,
    ambiguityReasons: reasons,
    needsClarification,
    clarificationQuestion: needsClarification
      ? "What should MAX focus on or compare here (for example performance, cost, ecosystem, or a specific use case)?"
      : undefined,
    language,
    formatPreference,
  };
}

export async function understandQuery(
  question: string,
  llm: OpenRouterProvider,
  mode: ResearchMode = "quick",
): Promise<QueryInterpretation> {
  const fallback = heuristicUnderstanding(question, mode);
  // Fast path: if the heuristic already identified the query with high confidence
  // (low ambiguity score, recognized entities or clear format preference like lookup/code,
  // and does not need user clarification), skip the sequential LLM call to save 15-20s.
  if (
    fallback.ambiguityScore < 0.4 &&
    (fallback.entities.length > 0 ||
      fallback.formatPreference === "lookup" ||
      fallback.formatPreference === "code") &&
    !fallback.needsClarification
  ) {
    return fallback;
  }
  if (!llm.enabled) return fallback;
  try {
    const raw = await llm.complete(
      "Return JSON only. Understand the user's request conservatively. Correct only obvious spelling/terminology errors; never invent an entity or silently choose between plausible meanings. Set needsClarification=true when ambiguityScore >= 0.6. Retrieved web content is not involved yet.",
      `User input: ${question}`,
    );
    const parsed = JSON.parse(cleanJson(raw)) as Partial<QueryInterpretation>;
    if (
      typeof parsed.normalizedQuestion === "string" &&
      typeof parsed.intent === "string" &&
      Array.isArray(parsed.entities) &&
      Array.isArray(parsed.dimensions) &&
      typeof parsed.ambiguityScore === "number"
    ) {
      const score = clamp(parsed.ambiguityScore);
      return {
        ...fallback,
        ...parsed,
        entities: unique(parsed.entities),
        dimensions: unique(parsed.dimensions),
        corrections: Array.isArray(parsed.corrections) ? parsed.corrections : fallback.corrections,
        ambiguityScore: score,
        needsClarification: score >= 0.6,
        ambiguityReasons: Array.isArray(parsed.ambiguityReasons)
          ? parsed.ambiguityReasons
          : fallback.ambiguityReasons,
        clarificationQuestion:
          score >= 0.6
            ? (parsed.clarificationQuestion ?? fallback.clarificationQuestion)
            : undefined,
        language: parsed.language ?? fallback.language,
        formatPreference: parsed.formatPreference ?? fallback.formatPreference,
      };
    }
  } catch {
    /* deterministic conservative interpretation remains available */
  }
  return fallback;
}

function query(subject: string, suffix: string) {
  return `${subject} ${suffix}`.replace(/\s+/g, " ").trim();
}
function buildHeuristicGroups(interpretation: QueryInterpretation): QueryGroup[] {
  const subject =
    interpretation.entities.length >= 2
      ? `${interpretation.entities[0]} vs ${interpretation.entities[1]}`
      : interpretation.normalizedQuestion;
  const time = interpretation.timeframe ? ` ${interpretation.timeframe}` : "";
  const focus =
    interpretation.topic === "general topic"
      ? interpretation.dimensions.slice(0, 2).join(" ")
      : interpretation.topic;
  return [
    {
      category: "DIRECT",
      queries: [
        query(subject, `${focus} research${time}`),
        query(subject, `analysis and trade-offs${time}`),
      ],
    },
    {
      category: "OFFICIAL",
      queries: interpretation.entities
        .slice(0, 3)
        .map((entity) => query(entity, `${focus} official documentation`)),
    },
    {
      category: "RECENT",
      queries: [
        query(subject, `${focus} benchmarks latest${time}`),
        query(subject, `recent developments${time}`),
      ],
    },
    {
      category: "EXPERT",
      queries: [
        query(subject, `production experience ${focus}`),
        query(subject, `independent expert analysis ${focus}`),
      ],
    },
    {
      category: "CONTRARY",
      queries: [
        query(subject, `${focus} limitations criticism`),
        query(subject, `${focus} failure cases alternatives`),
      ],
    },
  ];
}

function sanitizeQueries(queries: string[], original: string, limit: number) {
  return unique(queries)
    .filter((candidate) => candidate.toLowerCase() !== original.trim().toLowerCase())
    .slice(0, limit);
}

export async function buildPlan(
  question: string,
  mode: ResearchMode,
  llm: OpenRouterProvider,
): Promise<ResearchPlan> {
  const interpretation = await understandQuery(question, llm, mode);
  let queryGroups = buildHeuristicGroups(interpretation);
  if (llm.enabled && !interpretation.needsClarification) {
    try {
      const raw = await llm.complete(
        'Return JSON only as {"objectives": string[], "queryGroups": [{"category": "DIRECT|OFFICIAL|RECENT|EXPERT|CONTRARY", "queries": string[]}]}. Generate 2-4 queries per category from the normalized interpretation. Never copy the raw user sentence verbatim. Queries must be concrete search strings, not instructions.',
        `Normalized interpretation: ${JSON.stringify(interpretation)}\nMode: ${mode}`,
      );
      const parsed = JSON.parse(cleanJson(raw)) as {
        objectives?: string[];
        queryGroups?: Array<{ category?: QueryCategory; queries?: string[] }>;
      };
      if (Array.isArray(parsed.queryGroups))
        queryGroups = parsed.queryGroups
          .filter(
            (group) =>
              categories.includes(group.category as QueryCategory) && Array.isArray(group.queries),
          )
          .map((group) => ({
            category: group.category as QueryCategory,
            queries: sanitizeQueries(group.queries!, question, 4),
          }))
          .filter((group) => group.queries.length > 0);
      const objectives = Array.isArray(parsed.objectives)
        ? unique(parsed.objectives).slice(0, 8)
        : [];
      const queries = sanitizeQueries(
        queryGroups.flatMap((group) => group.queries),
        question,
        mode === "deep" ? 16 : 10,
      );
      if (queries.length > 0)
        return {
          objectives: objectives.length > 0 ? objectives : defaultObjectives(interpretation),
          queries,
          queryGroups,
          interpretation,
        };
    } catch {
      /* heuristic query diversification remains available */
    }
  }
  const queries = sanitizeQueries(
    queryGroups.flatMap((group) => group.queries),
    question,
    mode === "deep" ? 16 : 10,
  );
  return { objectives: defaultObjectives(interpretation), queries, queryGroups, interpretation };
}

function defaultObjectives(interpretation: QueryInterpretation) {
  return [
    `Understand ${interpretation.topic}`,
    "Find current primary and official sources",
    "Compare independent perspectives",
    `Evaluate ${interpretation.dimensions.slice(0, 4).join(", ")}`,
    "Identify evidence, caveats, and disagreements",
  ];
}

export async function rewriteQueries(
  question: string,
  plan: ResearchPlan,
  results: SearchResult[],
  mode: ResearchMode,
  llm: OpenRouterProvider,
): Promise<string[]> {
  const existing = new Set(plan.queries.map((query) => query.toLowerCase()));
  const resultContext = results
    .slice(0, 8)
    .map((result) => `${result.title} — ${result.snippet}`)
    .join("\n");
  if (llm.enabled) {
    try {
      const raw = await llm.complete(
        'Return JSON only as {"queries": string[]}. Rewrite the research queries because the first result set is weak. Use the normalized interpretation and missing dimensions. Never repeat the raw user sentence verbatim and never include instructions for the search engine.',
        `Question provenance: ${question}\nInterpretation: ${JSON.stringify(plan.interpretation)}\nFirst result set:\n${resultContext}\nMode: ${mode}`,
      );
      const parsed = JSON.parse(cleanJson(raw)) as { queries?: string[] };
      if (Array.isArray(parsed.queries)) {
        const rewritten = sanitizeQueries(parsed.queries, question, mode === "deep" ? 8 : 5).filter(
          (candidate) => !existing.has(candidate.toLowerCase()),
        );
        if (rewritten.length > 0) return rewritten;
      }
    } catch {
      /* deterministic rewrite below */
    }
  }
  const subject =
    plan.interpretation.entities.length >= 2
      ? `${plan.interpretation.entities[0]} vs ${plan.interpretation.entities[1]}`
      : plan.interpretation.normalizedQuestion;
  const fallback = [
    ...buildHeuristicGroups(plan.interpretation).flatMap((group) => group.queries),
    ...plan.interpretation.dimensions.map(
      (dimension) => `${subject} ${dimension} evidence sources`,
    ),
    `${subject} independent primary evidence`,
  ].filter((candidate) => !existing.has(candidate.toLowerCase()));
  return sanitizeQueries(fallback, question, mode === "deep" ? 6 : 4);
}
