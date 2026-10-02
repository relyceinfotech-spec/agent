import type {
  QueryCategory,
  QueryGroup,
  ResearchMode,
  ResearchPlan,
  SearchResult,
  QueryInterpretation,
  LanguageProfile,
  ResponseFormatPreference,
  ResearchObjective,
  ResearchRecoveryRequirements,
  OfficialSourceRequirement,
} from "./domain.js";
import { OpenRouterProvider } from "./llm.js";
import { containsExactEntity, knownEntities, subjectEntityMismatchReason } from "./entities.js";
import {
  buildRequestedFactRequirements,
  extractRequestedFacts,
  requestedFactCoverage,
  type RequestedFactKind,
} from "./requested-facts.js";

const corrections: Record<string, string> = {
  "react natve": "React Native",
  "react-native": "React Native",
  fluter: "Flutter",
  pyton: "Python",
  "java script": "JavaScript",
  "node js": "Node.js",
};
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

function officialSourceRequirement(question: string): OfficialSourceRequirement {
  if (
    /\b(?:prefer(?:ably)?|prioriti[sz]e)\b.{0,40}\b(?:official|primary|first[- ]party|authoritative)\b/i.test(
      question,
    )
  ) {
    return "preferred";
  }
  if (/\b(?:official|primary|first[- ]party|authoritative)\b/i.test(question)) {
    return "required";
  }
  return "none";
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
  options: { includeSupportLifecycle?: boolean } = {},
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
  const requestedFacts = extractRequestedFacts(normalizedQuestion, options);
  const focusedLifecycleLookup =
    options.includeSupportLifecycle === true &&
    requestedFacts.length === 1 &&
    requestedFacts[0] === "end-of-life date" &&
    !compare;
  const formatPreference = focusedLifecycleLookup
    ? "lookup"
    : detectFormatPreference(question, mode);
  const preciseFactRequest = requestedFacts.length > 0 && !compare;
  const inferredIntent = compare
    ? lower.includes("best")
      ? "Evaluate options against decision criteria"
      : "Compare the identified entities"
    : /\b(latest|current|recent|news|version|enna|kya)\b/i.test(lower)
      ? "Find and explain current developments"
      : "Explain and investigate the topic";
  const inferredTopic = /\b(performance|speed|latency|benchmark)\b/i.test(lower)
    ? "performance"
    : /\b(ai|machine learning)\b/i.test(lower)
      ? "AI"
      : /\b(backend|server|api)\b/i.test(lower)
        ? "backend"
        : "general topic";
  const topic = preciseFactRequest && entities[0] ? entities[0] : inferredTopic;
  const intent = preciseFactRequest ? "Verify the requested factual requirements" : inferredIntent;
  const timeframe =
    lower.match(/\b20\d{2}\b/)?.[0] ??
    (/\b(latest|current|recent)\b/i.test(lower) ? "latest" : undefined);
  const defaultDimensions = lower.includes("best")
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
      : compare
        ? ["performance", "ecosystem", "developer experience", "trade-offs"]
        : ["capabilities", "trade-offs", "limitations", "recent developments"];
  const explicitDimensions = [
    [/\b(pricing|price|cost|free tier|billing)\b/i, "pricing"],
    [/\b(auth|authentication|authorization|login)\b/i, "auth"],
    [/\b(scalability|scale|scaling)\b/i, "scalability"],
    [/\b(developer experience|developer velocity|dx|tooling)\b/i, "developer experience"],
    [/\b(performance|speed|latency|benchmark)\b/i, "performance"],
    [/\b(ecosystem|libraries|community)\b/i, "ecosystem"],
    [/\b(compatibility|migration)\b/i, "compatibility"],
    [/\b(production|readiness|stability)\b/i, "production readiness"],
  ]
    .filter(([pattern]) => (pattern as RegExp).test(lower))
    .map(([, dimension]) => dimension as string);
  const dimensions = preciseFactRequest
    ? []
    : explicitDimensions.length
      ? unique([...explicitDimensions, "trade-offs"])
      : defaultDimensions;
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
    sourceRequirements: {
      officialSources: officialSourceRequirement(normalizedQuestion),
    },
  };
}

export async function understandQuery(
  question: string,
  llm: OpenRouterProvider,
  mode: ResearchMode = "quick",
  options: { includeSupportLifecycle?: boolean } = {},
): Promise<QueryInterpretation> {
  const fallback = heuristicUnderstanding(question, mode, options);
  // Fast path: if the heuristic already identified the query with high confidence
  // (low ambiguity score, recognized entities or clear format preference like lookup/code,
  // and does not need user clarification), skip the sequential LLM call to save 15-20s.
  if (
    fallback.ambiguityScore < 0.4 &&
    (fallback.entities.length > 0 ||
      fallback.formatPreference === "lookup" ||
      fallback.formatPreference === "code" ||
      (mode === "deep" && fallback.normalizedQuestion.split(/\s+/).length >= 5)) &&
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
        // Source authority is derived from the user's wording, not delegated to the model.
        sourceRequirements: fallback.sourceRequirements,
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
function buildHeuristicGroups(
  interpretation: QueryInterpretation,
  requestedFacts = extractRequestedFacts(interpretation.normalizedQuestion),
): QueryGroup[] {
  const subject =
    interpretation.entities.length >= 2
      ? `${interpretation.entities[0]} vs ${interpretation.entities[1]}`
      : interpretation.entities.length === 1
        ? interpretation.entities[0]
        : interpretation.normalizedQuestion;
  const comparison =
    interpretation.formatPreference === "comparison" || interpretation.entities.length >= 2;
  if (requestedFacts.includes("end-of-life date") && !comparison) {
    const versionedSubject = requestedLifecycleSubject(interpretation);
    return [
      {
        category: "DIRECT",
        queries: [`${versionedSubject} end of life date official support schedule`],
      },
      {
        category: "OFFICIAL",
        queries: [`${versionedSubject} EOL date official release schedule`],
      },
    ];
  }
  if (requestedFacts.length > 0 && !comparison) {
    const terms: string[] = [];
    if (requestedFacts.includes("latestness")) terms.push("latest");
    if (requestedFacts.includes("release status")) terms.push("release status");
    if (requestedFacts.includes("stable status")) terms.push("stable");
    if (requestedFacts.includes("version")) terms.push("version");
    if (requestedFacts.includes("release date")) terms.push("release date");
    if (requestedFacts.includes("price")) terms.push("current price");
    if (requestedFacts.includes("technical value")) terms.push("technical specifications");
    if (interpretation.sourceRequirements?.officialSources !== "none") {
      terms.push("official source");
    }
    const factQuery = query(subject, unique(terms).join(" "));
    const officialQuery = query(
      subject,
      `official ${requestedFacts.includes("release date") ? "release history" : terms.join(" ")}`,
    );
    return [
      { category: "DIRECT", queries: [factQuery] },
      { category: "OFFICIAL", queries: [officialQuery] },
    ];
  }

  const time = interpretation.timeframe ? ` ${interpretation.timeframe}` : "";
  const officialSourceQualifier = /\b(?:official|primary|first.party|authoritative)\b/i.test(
    interpretation.normalizedQuestion,
  )
    ? " official source"
    : "";
  const focus =
    interpretation.formatPreference === "lookup"
      ? `latest stable version release date${officialSourceQualifier}`
      : interpretation.topic === "general topic"
        ? interpretation.dimensions.slice(0, 2).join(" ")
        : interpretation.topic;
  const officialFocus =
    interpretation.formatPreference === "lookup" || interpretation.timeframe === "latest"
      ? "release"
      : (interpretation.dimensions[0] ?? "overview");
  return [
    {
      category: "DIRECT",
      queries: [
        query(subject, `${focus}${interpretation.formatPreference === "lookup" ? "" : time}`),
        ...(interpretation.entities.length >= 2
          ? []
          : interpretation.timeframe === "latest" || interpretation.formatPreference === "lookup"
            ? [query(subject, `latest release${time}`)]
            : interpretation.dimensions.slice(0, 2).map((dimension) => query(subject, dimension))),
      ],
    },
    {
      category: "OFFICIAL",
      queries: interpretation.entities
        .slice(0, 3)
        .map((entity) => query(entity, `official ${officialFocus} documentation`)),
    },
    {
      category: "RECENT",
      queries: [query(subject, `latest developments${time}`), query(subject, `benchmarks${time}`)],
    },
    {
      category: "EXPERT",
      queries: [query(subject, `production analysis`), query(subject, `comparison review`)],
    },
    {
      category: "CONTRARY",
      queries: [query(subject, `limitations trade-offs`)],
    },
  ];
}

function sanitizeQueries(queries: string[], original: string, limit: number) {
  return unique(queries)
    .filter((candidate) => candidate.toLowerCase() !== original.trim().toLowerCase())
    .slice(0, limit);
}

const genericQueryWords = new Set([
  "about",
  "and",
  "app",
  "are",
  "for",
  "from",
  "how",
  "into",
  "latest",
  "more",
  "new",
  "recent",
  "the",
  "this",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

function queryMatchesTopic(queryText: string, interpretation: QueryInterpretation): boolean {
  if (interpretation.entities.length > 0) return true;
  const topicTerms = (
    interpretation.normalizedQuestion.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
  ).filter((term) => !genericQueryWords.has(term));
  if (topicTerms.length === 0) return true;
  const queryTerms = new Set(queryText.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  return topicTerms.some((term) => queryTerms.has(term));
}

/** A small planned query for fast current-information lookups, never the raw prompt. */
export function planFastLookupQuery(interpretation: QueryInterpretation): string {
  const subject =
    interpretation.entities[0] ??
    interpretation.normalizedQuestion
      .replace(/^(?:what(?:'s| is)?|which|when|who|how|tell me|find out)\s+/i, "")
      .replace(/\b(?:the|latest|current|most recent|version|release|today)\b/gi, " ")
      .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const focus = subject || interpretation.topic;
  const timeframe =
    interpretation.timeframe && interpretation.timeframe !== "latest"
      ? ` ${interpretation.timeframe}`
      : "";
  return `${focus} latest official release documentation${timeframe}`.trim();
}

export async function buildPlan(
  question: string,
  mode: ResearchMode,
  llm: OpenRouterProvider,
  existingInterpretation?: QueryInterpretation,
  options: { researchChatOptimization?: boolean } = {},
): Promise<ResearchPlan> {
  const includeSupportLifecycle = options.researchChatOptimization === true;
  const requestedFacts = extractRequestedFacts(question, { includeSupportLifecycle });
  const focusedLifecycleLookup =
    includeSupportLifecycle &&
    requestedFacts.length === 1 &&
    requestedFacts[0] === "end-of-life date" &&
    !/\b(?:compare|comparison|versus|\bvs\b|between)\b/i.test(question);
  const interpretation = focusedLifecycleLookup
    ? await understandQuery(question, llm, mode, { includeSupportLifecycle: true })
    : (existingInterpretation ?? (await understandQuery(question, llm, mode)));
  const requestedFactRequirements = buildRequestedFactRequirements(requestedFacts);
  const structuredObjectives = generateStructuredObjectives(interpretation, mode, requestedFacts);
  let queryGroups = buildHeuristicGroups(interpretation, requestedFacts);

  // When entities are clear, or a deep-research topic has enough concrete
  // title words to build contextual heuristic queries, save the extra planning
  // call for evidence verification and synthesis. Entity-light titles have
  // previously produced generic model queries despite a usable heuristic plan.
  if (
    interpretation.ambiguityScore < 0.4 &&
    (interpretation.entities.length > 0 || mode === "deep") &&
    !interpretation.needsClarification
  ) {
    const queries = sanitizeQueries(
      queryGroups.flatMap((group) => group.queries),
      question,
      mode === "deep" ? 16 : 10,
    );
    return {
      objectives: structuredObjectives.map((o) => o.label),
      structuredObjectives,
      requestedFacts,
      requestedFactRequirements,
      queries,
      queryGroups,
      interpretation,
    };
  }

  if (llm.enabled && !interpretation.needsClarification) {
    try {
      const raw = await llm.complete(
        'Return JSON only as {"objectives": string[], "queryGroups": [{"category": "DIRECT|OFFICIAL|RECENT|EXPERT|CONTRARY", "queries": string[]}]}. Keep queries concise (under 6 words). Must include identified entities in all queries. Never copy user sentence verbatim.',
        `Research topic: ${interpretation.normalizedQuestion}\nEntities: ${interpretation.entities.join(", ")}\nTopic: ${interpretation.topic}\nDimensions: ${interpretation.dimensions.join(", ")}\nMode: ${mode}`,
      );
      const parsed = JSON.parse(cleanJson(raw)) as {
        objectives?: string[];
        queryGroups?: Array<{ category?: QueryCategory; queries?: string[] }>;
      };
      if (Array.isArray(parsed.queryGroups)) {
        const modelQueryGroups = parsed.queryGroups
          .filter(
            (group) =>
              categories.includes(group.category as QueryCategory) && Array.isArray(group.queries),
          )
          .map((group) => ({
            category: group.category as QueryCategory,
            queries: sanitizeQueries(group.queries!, question, 4).filter((candidate) =>
              queryMatchesTopic(candidate, interpretation),
            ),
          }))
          .filter((group) => group.queries.length > 0);
        if (modelQueryGroups.length > 0) queryGroups = modelQueryGroups;
      }
      const objectives = Array.isArray(parsed.objectives)
        ? unique(parsed.objectives).slice(0, 8)
        : [];
      const queries = sanitizeQueries(
        queryGroups.flatMap((group) => group.queries),
        question,
        mode === "deep" ? 16 : 10,
      );
      if (queries.length > 0) {
        return {
          objectives:
            requestedFacts.length > 0 || objectives.length === 0
              ? structuredObjectives.map((o) => o.label)
              : objectives,
          structuredObjectives,
          requestedFacts,
          requestedFactRequirements,
          queries,
          queryGroups,
          interpretation,
        };
      }
    } catch {
      /* heuristic query diversification remains available */
    }
  }
  const queries = sanitizeQueries(
    queryGroups.flatMap((group) => group.queries),
    question,
    mode === "deep" ? 16 : 10,
  );
  return {
    objectives: structuredObjectives.map((o) => o.label),
    structuredObjectives,
    requestedFacts,
    requestedFactRequirements,
    queries,
    queryGroups,
    interpretation,
  };
}

export function generateStructuredObjectives(
  interpretation: QueryInterpretation,
  mode: ResearchMode = "quick",
  requestedFacts = extractRequestedFacts(interpretation.normalizedQuestion),
): ResearchObjective[] {
  const isComparison =
    interpretation.formatPreference === "comparison" || interpretation.entities.length >= 2;
  const isLookup = interpretation.formatPreference === "lookup";

  if (isComparison) {
    const e1 = interpretation.entities[0] || "Entity A";
    const e2 = interpretation.entities[1] || "Entity B";
    const requested = new Set(interpretation.dimensions);
    const objectives: ResearchObjective[] = [
      {
        id: "obj-core",
        label: `Core architecture & feature parity between ${e1} and ${e2}`,
        category: "architecture",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
      {
        id: "obj-pricing",
        label: `Pricing model, free tiers, and operational cost breakdown`,
        category: "pricing",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
      {
        id: "obj-perf",
        label: `Performance benchmarks, scalability, and production limits`,
        category: "performance",
        importance: "high",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
      {
        id: "obj-auth",
        label: `Authentication, authorization, and identity management for ${e1} and ${e2}`,
        category: "auth",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
      {
        id: "obj-ecosystem",
        label: `Developer experience, tooling ecosystem, and migration friction`,
        category: "ecosystem",
        importance: "high",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
      {
        id: "obj-caveats",
        label: `Known limitations, failure modes, and trade-offs`,
        category: "limitations",
        importance: "medium",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
    ];
    return objectives.filter((objective) => {
      if (objective.id === "obj-pricing") return requested.has("pricing");
      if (objective.id === "obj-auth") return requested.has("auth");
      if (objective.id === "obj-perf")
        return ["performance", "scalability", "production readiness"].some((dimension) =>
          requested.has(dimension),
        );
      if (objective.id === "obj-ecosystem")
        return ["ecosystem", "developer experience", "compatibility"].some((dimension) =>
          requested.has(dimension),
        );
      return true;
    });
  }

  if (requestedFacts.length > 0) {
    const subject =
      interpretation.entities[0] ??
      (interpretation.topic !== "general topic" ? interpretation.topic : "the requested subject");
    const requirements = buildRequestedFactRequirements(requestedFacts);
    const objectives: ResearchObjective[] = [];

    if (
      requirements.version ||
      requirements.releaseStatus ||
      requirements.stable ||
      requirements.latest
    ) {
      const releaseQualifier = [
        requirements.latest ? "latest" : undefined,
        requirements.stable ? "stable" : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      const statusFacts = requestedFacts.filter((fact) =>
        ["version", "release status", "stable status", "latestness"].includes(fact),
      );
      objectives.push({
        id: "obj-version-status",
        label:
          requirements.version || requirements.stable || requirements.latest
            ? `Determine the ${releaseQualifier ? `${releaseQualifier} ` : ""}version of ${subject}`
            : `Verify the release status for ${subject}`,
        category: "status",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
        requiredFacts: statusFacts,
      });
    }

    if (requirements.releaseDate) {
      const releaseDateDependsOnLatestness = requirements.latest;
      objectives.push({
        id: "obj-release-date",
        label: `Verify the release date corresponding to the requested ${subject} version`,
        category: "release_date",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
        requiredFacts: ["release date"],
        dependsOn: releaseDateDependsOnLatestness ? ["obj-version-status"] : [],
      });
    }

    if (requirements.endOfLifeDate) {
      objectives.push({
        id: "obj-end-of-life",
        label: `Verify the end-of-life date for the requested ${subject} version`,
        category: "end_of_life",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
        requiredFacts: ["end-of-life date"],
      });
    }

    if (requirements.price) {
      objectives.push({
        id: "obj-price",
        label: `Verify the requested price for ${subject}`,
        category: "pricing",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      });
    }

    if (requirements.technicalValue) {
      objectives.push({
        id: "obj-technical-value",
        label: `Verify the requested technical specification for ${subject}`,
        category: "technical_value",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      });
    }

    if (interpretation.sourceRequirements?.officialSources !== "none") {
      objectives.push({
        id: "obj-official-provenance",
        label: `Verify official-source provenance for the requested ${subject} facts`,
        category: "documentation",
        importance: "high",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
        requiredFacts: requestedFacts,
        requiresOfficialSource: true,
      });
    }

    return objectives;
  }

  if (isLookup) {
    return [
      {
        id: "obj-version",
        label: `Current official release version and status of ${interpretation.topic}`,
        category: "status",
        importance: "critical",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
      {
        id: "obj-changes",
        label: `Key breaking changes, release dates, and core updates`,
        category: "features",
        importance: "high",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
      {
        id: "obj-official",
        label: `Official release provenance and documentation citation`,
        category: "documentation",
        importance: "medium",
        status: "pending",
        evidenceIds: [],
        sourceIds: [],
        coverage: 0,
      },
    ];
  }

  // General / Deep research
  const dims = interpretation.dimensions.slice(0, 3);
  return [
    {
      id: "obj-foundation",
      label: `Foundational concepts and authoritative definition of ${interpretation.topic}`,
      category: "foundation",
      importance: "critical",
      status: "pending",
      evidenceIds: [],
      sourceIds: [],
      coverage: 0,
    },
    {
      id: "obj-evidence",
      label: `Empirical evidence, benchmarks, and practical applications ${dims.length ? `(${dims.join(", ")})` : ""}`,
      category: "evidence",
      importance: "high",
      status: "pending",
      evidenceIds: [],
      sourceIds: [],
      coverage: 0,
    },
    {
      id: "obj-tradeoffs",
      label: `Critical analysis, limitations, caveats, and conflicting views`,
      category: "criticism",
      importance: "high",
      status: "pending",
      evidenceIds: [],
      sourceIds: [],
      coverage: 0,
    },
    {
      id: "obj-synthesis",
      label: `Industry best practices, current recommendations, and future direction`,
      category: "best_practices",
      importance: "medium",
      status: "pending",
      evidenceIds: [],
      sourceIds: [],
      coverage: 0,
    },
  ];
}

export async function rewriteQueries(
  question: string,
  plan: ResearchPlan,
  results: SearchResult[],
  mode: ResearchMode,
  llm: OpenRouterProvider,
  missingObjectives?: ResearchObjective[],
  recoveryRequirements?: ResearchRecoveryRequirements,
): Promise<string[]> {
  const existing = new Set(plan.queries.map((query) => query.toLowerCase()));
  const resultContext = results
    .slice(0, 8)
    .map((result) => `${result.title} — ${result.snippet}`)
    .join("\n");

  const unresolvedFacts = recoveryRequirements?.unresolvedFacts ?? [];
  if (unresolvedFacts.length > 0) {
    const candidate = buildFactRecoveryQuery(plan, recoveryRequirements!, question);
    return !existing.has(candidate.toLowerCase()) ? [candidate] : [];
  }

  if (missingObjectives && missingObjectives.length > 0) {
    const objective = prioritizeObjectives(missingObjectives)[0]!;
    const candidate = buildObjectiveRecoveryQuery(plan, objective);
    return !existing.has(candidate.toLowerCase()) ? [candidate] : [];
  }

  if (llm.enabled) {
    try {
      const raw = await llm.complete(
        'Return JSON only as {"query": string}. Generate exactly ONE concise search query for the remaining evidence gap. Preserve identified entities and any official-source requirement. Never copy the raw user sentence verbatim.',
        `Question: ${question}\nInterpretation: ${JSON.stringify(plan.interpretation)}\nCurrent evidence snippets:\n${resultContext}\nMode: ${mode}`,
      );
      const parsed = JSON.parse(cleanJson(raw)) as { query?: string; queries?: string[] };
      const candidates = sanitizeQueries(
        [parsed.query ?? "", ...(parsed.queries ?? [])],
        question,
        5,
      ).filter((candidate) => !existing.has(candidate.toLowerCase()));
      const accepted = candidates.find(
        (candidate) =>
          validateRecoveryQuery(candidate, question, plan, recoveryRequirements).accepted,
      );
      if (accepted) return [accepted];
      if (candidates[0]) return [candidates[0]];
    } catch {
      /* Use the deterministic one-query fallback below. */
    }
  }

  const subject = recoverySubject(plan);
  const sourceTerms = sourceConstraintTerms(
    recoveryRequirements?.officialSourceRequirement ??
      plan.interpretation.sourceRequirements?.officialSources ??
      "none",
  );
  const candidate = `${subject} ${plan.interpretation.dimensions[0] ?? "evidence"} ${sourceTerms}`;
  return !existing.has(candidate.toLowerCase()) ? [candidate] : [];
}

const factQueryTerms: Record<RequestedFactKind, string> = {
  version: "version",
  "release date": "release date",
  "release status": "release status",
  "stable status": "stable release status",
  latestness: "release status",
  "end-of-life date": "end of life date",
  price: "current price",
  "technical value": "technical specifications",
};

function recoverySubject(plan: ResearchPlan, question?: string): string {
  if (plan.requestedFacts?.includes("end-of-life date")) {
    return requestedLifecycleSubject(plan.interpretation, question);
  }
  if (plan.interpretation.entities.length >= 2) {
    return plan.interpretation.entities.join(" vs ");
  }
  if (plan.interpretation.entities[0]) return plan.interpretation.entities[0];
  if (plan.interpretation.topic !== "general topic") return plan.interpretation.topic;

  const subjectNoise = new Set([
    ...genericQueryWords,
    "about",
    "cite",
    "current",
    "date",
    "evidence",
    "investigate",
    "official",
    "release",
    "source",
    "sources",
    "stable",
    "verify",
    "version",
    "using",
  ]);
  const terms = plan.interpretation.normalizedQuestion.match(/[\p{L}\p{N}.-]{3,}/gu) ?? [];
  return (
    terms
      .filter((term) => !subjectNoise.has(term.toLowerCase()))
      .slice(0, 3)
      .join(" ") || plan.interpretation.topic
  );
}

function requestedLifecycleSubject(
  interpretation: QueryInterpretation,
  question = interpretation.normalizedQuestion,
): string {
  const entity = interpretation.entities[0];
  if (!entity) return interpretation.topic;
  const escapedEntity = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const version = question.match(
    new RegExp(`\\b${escapedEntity}\\s+(?:version\\s+|v)?(\\d+(?:\\.\\d+){0,3})\\b`, "i"),
  )?.[1];
  return version ? `${entity} ${version}` : entity;
}

function sourceConstraintTerms(
  requirement: ResearchRecoveryRequirements["officialSourceRequirement"],
): string {
  if (requirement === "required") return "official release notes history";
  if (requirement === "preferred") return "primary release source";
  return "release notes history";
}

function buildFactRecoveryQuery(
  plan: ResearchPlan,
  requirements: ResearchRecoveryRequirements,
  question: string,
): string {
  if (requirements.unresolvedFacts.includes("end-of-life date")) {
    const alternateSourceCue = requirements.factInsufficientSources?.some((source) =>
      source.missingFacts.includes("end-of-life date"),
    )
      ? "maintainer working group schedule"
      : "official release schedule";
    return `${requestedLifecycleSubject(plan.interpretation, question)} end-of-life date support lifecycle ${alternateSourceCue}`;
  }
  const terms: string[] = [];
  const latestnessGap = requirements.unresolvedFacts.includes("latestness");
  const versionGap = requirements.unresolvedFacts.includes("version");
  const knownVersion = requirements.knownVersionCandidates?.at(-1);

  if (requirements.latestnessRequired) {
    terms.push(requirements.qualifiers.latest ? "latest" : "current");
    if (requirements.qualifiers.stable) terms.push("stable");
  }

  if (latestnessGap && knownVersion) {
    terms.push("newer than", knownVersion, "release history");
  }

  for (const fact of requirements.unresolvedFacts) {
    if (fact === "latestness") continue;
    terms.push(factQueryTerms[fact]);
  }

  if (
    latestnessGap &&
    !knownVersion &&
    !versionGap &&
    !requirements.unresolvedFacts.includes("release date")
  ) {
    terms.push("release status");
  }

  return [
    recoverySubject(plan, question),
    ...unique(terms),
    sourceConstraintTerms(requirements.officialSourceRequirement),
  ]
    .filter(Boolean)
    .join(" ");
}

const objectiveRecoveryTerms: Record<string, string> = {
  architecture: "architecture implementation",
  limitations: "limitations trade-offs",
  performance: "performance benchmarks",
  ecosystem: "developer experience ecosystem",
  pricing: "current pricing",
  auth: "authentication authorization",
  scalability: "scalability evidence",
  status: "current version release status",
  release_status: "version release channel status",
  release_date: "official release date announcement",
  technical_value: "technical specification evidence",
  end_of_life: "end of life date support schedule",
  features: "release features updates",
  documentation: "official documentation release notes",
};

function prioritizeObjectives(objectives: ResearchObjective[]): ResearchObjective[] {
  const importance = { critical: 4, high: 3, medium: 2, low: 1 };
  return [...objectives].sort(
    (left, right) =>
      left.coverage - right.coverage || importance[right.importance] - importance[left.importance],
  );
}

function buildObjectiveRecoveryQuery(plan: ResearchPlan, objective: ResearchObjective): string {
  const requirement = plan.interpretation.sourceRequirements?.officialSources ?? "none";
  return `${recoverySubject(plan)} ${objectiveRecoveryTerms[objective.category] ?? `${objective.category} evidence`} ${sourceConstraintTerms(requirement)}`;
}

function queryCoversFact(query: string, fact: RequestedFactKind): boolean {
  switch (fact) {
    case "version":
      return /\b(?:version|semver)\b|\brelease\s+version\b/i.test(query);
    case "release date":
      return /\b(?:date|when|released|published|release history|announcement|changelog)\b/i.test(
        query,
      );
    case "release status":
      return (
        /\b(?:release|version|channel)\b/i.test(query) &&
        /\b(?:status|stable|canary|beta|alpha|preview|release history)\b/i.test(query)
      );
    case "latestness":
      return (
        /\b(?:latest|current|most recent)\b/i.test(query) &&
        /\b(?:stable|release|version)\b/i.test(query)
      );
    case "end-of-life date":
      return (
        /\b(?:end[- ]of[- ]life|eol|end[- ]of[- ]support|support(?:ed)?\s+(?:ends?|until))\b/i.test(
          query,
        ) && /\b(?:date|when|schedule|official|support)\b/i.test(query)
      );
    case "stable status":
      return /\bstable\b/i.test(query) && /\b(?:release|version)\b/i.test(query);
    case "price":
      return /\b(?:price|pricing|cost)\b/i.test(query);
    case "technical value":
      return /\b(?:technical|specification|spec|limit|capacity|latency|throughput|measurement)\b/i.test(
        query,
      );
  }
}

export function validateRecoveryQuery(
  candidate: string,
  question: string,
  plan: ResearchPlan,
  requirements?: ResearchRecoveryRequirements,
  missingObjectives: ResearchObjective[] = [],
): { accepted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const query = candidate.trim();
  if (!query) return { accepted: false, reasons: ["recovery query is empty"] };

  const siblingMismatch = subjectEntityMismatchReason(question, query);
  if (siblingMismatch) reasons.push(siblingMismatch);

  for (const entity of plan.interpretation.entities) {
    if (!containsExactEntity(query, entity)) {
      reasons.push(`recovery query omitted requested entity: ${entity}`);
    }
  }
  if (plan.requestedFacts.includes("end-of-life date")) {
    const lifecycleSubject = requestedLifecycleSubject(plan.interpretation);
    const entity = plan.interpretation.entities[0] ?? "";
    const requestedVersion = lifecycleSubject.slice(entity.length).trim();
    if (requestedVersion && !query.toLowerCase().includes(lifecycleSubject.toLowerCase())) {
      reasons.push("recovery query omitted the requested lifecycle version");
    }
  }
  if (!queryMatchesTopic(query, plan.interpretation)) {
    reasons.push("recovery query does not preserve the requested topic");
  }

  if (requirements?.latestnessRequired) {
    if (!/\b(?:latest|newest|current|most recent)\b/i.test(query)) {
      reasons.push("recovery query omitted the latest/current qualifier");
    }
    if (requirements.qualifiers.stable && !/\bstable\b/i.test(query)) {
      reasons.push("recovery query omitted the stable-release qualifier");
    }
    if (!/\b(?:release|version)\b/i.test(query)) {
      reasons.push("recovery query omitted the version/release dimension");
    }
    if (
      requirements.unresolvedFacts.includes("latestness") &&
      requirements.knownVersionCandidates?.length
    ) {
      const knownVersion = requirements.knownVersionCandidates.at(-1)!;
      if (!query.toLowerCase().includes(knownVersion.toLowerCase())) {
        reasons.push("latestness recovery query omitted the highest known version candidate");
      }
      if (!/\b(?:newer|after|later than)\b/i.test(query)) {
        reasons.push(
          "latestness recovery query did not ask for evidence newer than the known version",
        );
      }
    }
  }

  for (const fact of requirements?.unresolvedFacts ?? []) {
    if (!queryCoversFact(query, fact)) {
      reasons.push(`recovery query does not target unresolved fact: ${fact}`);
    }
  }

  const officialRequirement =
    requirements?.officialSourceRequirement ??
    plan.interpretation.sourceRequirements?.officialSources ??
    "none";
  if (
    officialRequirement === "required" &&
    !/\b(?:official|primary|first[- ]party|maintainer|release notes|release history|changelog)\b/i.test(
      query,
    )
  ) {
    reasons.push("recovery query omitted the required official/primary-source constraint");
  }

  if ((requirements?.unresolvedFacts.length ?? 0) === 0 && missingObjectives.length > 0) {
    const objective = prioritizeObjectives(missingObjectives)[0]!;
    const categoryTerms = objectiveRecoveryTerms[objective.category]
      ?.split(/\s+/)
      .filter((term) => term.length > 3) ?? [objective.category];
    if (!categoryTerms.some((term) => query.toLowerCase().includes(term.toLowerCase()))) {
      reasons.push(`recovery query does not target objective: ${objective.category}`);
    }
  }

  return { accepted: reasons.length === 0, reasons };
}
