import type { Claim, ComparisonCoverage, ComparisonObjective } from "./domain.js";
import { containsExactEntity, extractKnownEntities } from "./entities.js";
import { requestedSubjectNames } from "./query-relevance.js";

const facets: Array<[string, RegExp]> = [
  ["latency", /\b(?:latency|response time|startup time|speed)\b/i],
  ["recall", /\b(?:recall|accuracy)\b/i],
  ["throughput", /\b(?:throughput|queries per second|qps)\b/i],
  ["memory", /\b(?:memory|ram|storage footprint)\b/i],
  [
    "build/indexing cost",
    /\b(?:build(?:\/indexing)?|indexing|training) (?:cost|time)|\bindex construction\b/i,
  ],
  ["pricing", /\b(?:price|pricing|billing|free tier)\b/i],
  ["auth", /\b(?:auth|authentication|authorization|login)\b/i],
  ["scalability", /\b(?:scale|scalability|scaling)\b/i],
  ["developer experience", /\b(?:developer experience|tooling|dx)\b/i],
  ["ecosystem", /\b(?:ecosystem|libraries|community)\b/i],
  ["compatibility", /\b(?:compatibility|migration)\b/i],
  ["architecture", /\b(?:architecture|implementation)\b/i],
  ["profiling recommendations", /\bprofiling\b/i],
  ["security", /\b(?:security|encryption)\b/i],
  ["battery life", /\bbattery life\b/i],
  ["energy efficiency", /\benergy efficiency\b/i],
  ["reliability", /\b(?:reliability|durability)\b/i],
];

export function comparisonObjective(question: string): ComparisonObjective | undefined {
  if (!/\b(?:compare|comparison|versus|vs|differences between|tradeoffs between)\b/i.test(question))
    return undefined;
  // Criteria and source constraints may contain capitalized names too. Only
  // the comparison subject clause establishes the requested targets.
  const subject = question.split(/\b(?:on|in terms of|using)\s+/i)[0]!;
  let targets = [...new Set([...extractKnownEntities(subject), ...requestedSubjectNames(subject)])];
  if (targets.length < 2) {
    const pair =
      question.match(
        /(?:compare\s+(?:the\s+)?(?:current\s+)?|differences between\s+)(.+?)\s+(?:and|with|versus|vs\.?)\s+(.+?)(?=\s+(?:on|for|in|using|performance|latency|recall|memory|throughput|pricing|cost|architecture)\b|[?.]|$)/i,
      ) ??
      question.match(
        /^(.+?)\s+(?:versus|vs\.?)\s+(.+?)(?=\s+(?:on|for|in|performance|latency|recall|memory|throughput|pricing|cost)\b|[?.]|$)/i,
      );
    if (pair) targets = [pair[1]!.trim(), pair[2]!.trim()];
  }
  targets = targets.filter(
    (target, i) =>
      !targets.some(
        (other, j) => i !== j && other.length > target.length && containsExactEntity(other, target),
      ),
  );
  if (targets.length < 2) return undefined;
  const dimensions = facets
    .filter(([, pattern]) => pattern.test(question))
    .map(([dimension]) => dimension);
  const explicitClause = question.match(/\b(?:on|in terms of)\s+(.+?)(?=\s+using\b|[?.]|$)/i)?.[1];
  if (explicitClause) {
    for (const dimension of explicitClause.split(/\s+and\s+|,/i).map((part) => part.trim())) {
      if (dimension && !facets.some(([, pattern]) => pattern.test(dimension)))
        dimensions.push(dimension);
    }
  }
  if (
    /\b(?:performance|benchmark)\b/i.test(question) &&
    !dimensions.some((dimension) =>
      [
        "latency",
        "recall",
        "throughput",
        "memory",
        "build/indexing cost",
        "profiling recommendations",
      ].includes(dimension),
    )
  )
    dimensions.push("performance");
  if (!dimensions.length && /\bcost\b/i.test(question)) dimensions.push("pricing");
  // An unspecified comparison remains general; never invent latency, price, etc.
  if (!dimensions.length) dimensions.push("comparison");
  return { targets, dimensions };
}

function addressesDimension(text: string, dimension: string): boolean {
  if (dimension === "benchmark performance") return /\bbenchmark\b/i.test(text);
  if (dimension === "relative speed") return /\b(?:faster|slower)\b/i.test(text);
  if (dimension === "comparison") return true;
  if (dimension === "performance")
    return /\b(?:latency|recall|throughput|memory|startup time|build time|indexing cost|faster|slower|benchmark)\b/i.test(
      text,
    );
  return (
    facets.find(([name]) => name === dimension)?.[1].test(text) ??
    text.toLowerCase().includes(dimension.toLowerCase())
  );
}

/** Reconstruct subject context before filtering. Only actual source headings
 * establish section scope; plain target labels bind one following paragraph. */
export function comparisonEvidencePassages(
  objective: ComparisonObjective,
  content: string,
): string[] {
  const sections: Array<{ level: number; label: string; target?: string; blocksContext: boolean }> =
    [];
  let adjacentLabel: string | undefined;
  let sectionSuppressed = false;
  const passages: string[] = [];
  for (const rawParagraph of content.split(/\n+/)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;
    const heading = paragraph.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      while (sections.length && sections.at(-1)!.level >= level) sections.pop();
      const label = heading[2]!.trim();
      const targets = objective.targets.filter((target) => containsExactEntity(label, target));
      // A source can name a competing subject outside our requested/catalogued
      // entities. Coordinated names make the heading broad, not a target label.
      const sourceNames = label
        .split(/\s+(?:and|or|versus|vs\.?)\s+|\s*[,/&]\s*/i)
        .flatMap(requestedSubjectNames)
        .filter(
          (name) =>
            !facets.some(
              ([, pattern]) =>
                pattern.test(name) &&
                !objective.targets.some((target) => containsExactEntity(name, target)),
            ),
        );
      const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const coordinatedSubjects = sourceNames.some((first, index) =>
        sourceNames.slice(index + 1).some((second) => {
          const separator =
            "(?:\\s*,\\s*(?:and\\s+|or\\s+)?|\\s+(?:and|or|versus|vs\\.?)\\s+|\\s*[&/]\\s*)";
          return new RegExp(
            `\\b(?:${escape(first)}${separator}${escape(second)}|${escape(second)}${separator}${escape(first)})\\b`,
            "i",
          ).test(label);
        }),
      );
      const blocksContext =
        targets.length > 1 ||
        coordinatedSubjects ||
        extractKnownEntities(label).some(
          (entity) => !objective.targets.some((target) => containsExactEntity(target, entity)),
        );
      sections.push({
        level,
        label,
        target: targets.length === 1 && !blocksContext ? targets[0] : undefined,
        blocksContext,
      });
      adjacentLabel = undefined;
      sectionSuppressed = false;
      continue;
    }
    const plainTarget = objective.targets.find(
      (target) => paragraph.toLowerCase() === target.toLowerCase(),
    );
    if (plainTarget) {
      adjacentLabel = paragraph;
      sectionSuppressed = false;
      continue;
    }
    const section = [...sections].reverse().find((item) => item.target || item.blocksContext);
    const label =
      adjacentLabel ??
      (!sectionSuppressed && !section?.blocksContext && section?.target
        ? section.label
        : undefined);
    adjacentLabel = undefined;
    const normalized = paragraph.replace(/^[-*+]\s+/, "");
    const labelTarget =
      label && objective.targets.find((target) => containsExactEntity(label, target));
    const differentSubject =
      objective.targets.some(
        (target) => target !== labelTarget && containsExactEntity(normalized, target),
      ) ||
      extractKnownEntities(normalized).some(
        (entity) => !objective.targets.some((target) => containsExactEntity(target, entity)),
      );
    // Once a paragraph switches subject, a later implicit paragraph cannot
    // silently switch back to the old heading. A new heading/label restores it.
    if (label && differentSubject) sectionSuppressed = true;
    const sentences = normalized
      .split(/(?<=[.!?])\s+/)
      .map((text) => text.trim())
      .filter(Boolean);
    passages.push(
      ...sentences.flatMap((sentence, index) => {
        const previous = sentences[index - 1];
        const implicit =
          /^(?:this (?:means|results in|leads to)|it\b|they\b|the trade-off\b)/i.test(sentence);
        if (
          previous &&
          implicit &&
          objective.targets.filter((target) => containsExactEntity(previous, target)).length ===
            1 &&
          !requestedSubjectNames(previous).some(
            (name) =>
              !objective.targets.some((target) => containsExactEntity(name, target)) &&
              !facets.some(([, pattern]) => pattern.test(name)),
          ) &&
          !objective.targets.some((target) => containsExactEntity(sentence, target)) &&
          `${previous} ${sentence}`.length <= 480
        )
          return [`${previous} ${sentence}`];
        const namedTargets = objective.targets.filter((target) =>
          containsExactEntity(sentence, target),
        );
        if (
          label &&
          !namedTargets.length &&
          !differentSubject &&
          !/^(?:they|these|those|both)\b/i.test(sentence) &&
          `${label} ${sentence}`.length <= 480 &&
          comparisonClaimDimensions(objective, sentence).length > 0
        )
          return [`${label} ${sentence}`];
        return [sentence];
      }),
    );
  }
  return [...new Set(passages)];
}

export function comparisonClaimHasTargetFinding(
  objective: ComparisonObjective,
  text: string,
): boolean {
  return objective.targets.some((target) =>
    objective.dimensions.some((dimension) =>
      comparisonFindingForTarget(objective, text, target, dimension),
    ),
  );
}

/** Entailment is still checked by the verifier; this checks whether there is a requested finding to verify. */
export function comparisonClaimDimensions(objective: ComparisonObjective, claim: string): string[] {
  if (
    /\b(?:unknown|not (?:reported|measured|documented|available)|no (?:evidence|measurement|data))\b/i.test(
      claim,
    )
  )
    return [];
  if (
    /\b(?:article|page|guide|post)\s+(?:breaks? down|covers?|discusses?|explains?|compares?)\b/i.test(
      claim,
    )
  )
    return [];
  const generic = /\b(?:is used for|used for|improves? (?:search )?efficiency)\b/i.test(claim);
  const finding =
    /\b\d+(?:\.\d+)?\b|\b(?:lower|higher|less|more|faster|slower|reduce\w*|requires?|supports?|lacks?|includes?|offers?|provides?|uses?|achieves?|recommends?|controls?|billed|costs?|has|is|are)\b/i.test(
      claim,
    );
  if (!finding) return [];
  return objective.dimensions.filter((dimension) => {
    if (!addressesDimension(claim, dimension)) return false;
    if (
      [
        "performance",
        "relative speed",
        "benchmark performance",
        "latency",
        "recall",
        "throughput",
        "memory",
        "build/indexing cost",
      ].includes(dimension)
    ) {
      const concrete =
        /\b\d+(?:\.\d+)?\b|\b(?:faster|slower|lower|higher|less|more|reduce\w*|requires?|achieves?|trades?|controls?|overhead)\b|\b(?:low|high|strong|stable)\s+(?:latency|recall|throughput|memory)\b|\blatency\s+(?:is |stays? |remains? )?stable\b/i.test(
          claim,
        );
      if (!concrete) return false;
      if (generic && !/\b\d+(?:\.\d+)?\b|\b(?:faster|slower|lower|higher|less|more)\b/i.test(claim))
        return false;
    }
    return true;
  });
}

export function comparisonCoverage(
  objective: ComparisonObjective,
  claims: Claim[],
): ComparisonCoverage {
  const supported = claims.filter((claim) => claim.verification?.verdict === "supported");
  const axes = [
    "latency",
    "recall",
    "throughput",
    "memory",
    "build/indexing cost",
    "benchmark performance",
    "relative speed",
  ];
  const targetHasAxis = (target: string, axis: string) =>
    supported.some((claim) =>
      comparisonFindingForTarget({ ...objective, dimensions: [axis] }, claim.text, target, axis),
    );
  const performanceDimensions = objective.dimensions.includes("performance")
    ? {
        observed: axes.filter((axis) =>
          objective.targets.some((target) => targetHasAxis(target, axis)),
        ),
        shared: axes.filter((axis) =>
          objective.targets.every((target) => targetHasAxis(target, axis)),
        ),
      }
    : undefined;
  const cells = objective.targets.flatMap((target) =>
    objective.dimensions.map((dimension) => {
      const matches = claims.filter(
        (claim) =>
          claim.verification?.verdict === "supported" &&
          containsExactEntity(claim.text, target) &&
          comparisonFindingForTarget(objective, claim.text, target, dimension) &&
          (dimension !== "performance" ||
            performanceDimensions?.shared.some((axis) =>
              comparisonFindingForTarget(
                { ...objective, dimensions: [axis] },
                claim.text,
                target,
                axis,
              ),
            )),
      );
      return {
        target,
        dimension,
        claimIds: matches.map((claim) => claim.id),
        sourceIds: [...new Set(matches.flatMap((claim) => claim.sourceIds))],
      };
    }),
  );
  const missing = cells
    .filter((cell) => !cell.claimIds.length)
    .map(({ target, dimension }) => ({ target, dimension }));
  return { ...objective, performanceDimensions, cells, missing, sufficient: missing.length === 0 };
}

function comparisonFindingForTarget(
  objective: ComparisonObjective,
  text: string,
  target: string,
  dimension: string,
): boolean {
  // Split explicitly different subjects before assigning properties. Mentioning
  // B in a separate generic clause cannot lend B the measurement stated for A.
  const targetPattern = objective.targets
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // An explicit relative finding binds both sides of the stated comparison.
  // A named reference without a comparative predicate does not establish this.
  const relative = new RegExp(
    `^Compared (?:with|to) (${targetPattern}),?\\s+(${targetPattern})\\b([^.!?]*)[.!?]?$`,
    "i",
  ).exec(text.trim());
  const relativePredicate = relative
    ? `${relative[2]} ${
        relative[3]!.split(
          new RegExp(
            `(?:[,;]\\s*|\\s+(?:and|while|whereas|but)\\s+)(?=(?:${targetPattern})\\b)`,
            "i",
          ),
        )[0]
      }`
    : "";
  if (
    relative &&
    [relative[1], relative[2]].some((name) => name?.toLowerCase() === target.toLowerCase()) &&
    relative[1]?.toLowerCase() !== relative[2]?.toLowerCase() &&
    /\b(?:lower|higher|less|more|faster|slower)\b/i.test(relativePredicate) &&
    comparisonClaimDimensions(objective, relativePredicate).includes(dimension)
  )
    return true;
  const clauses = text.split(
    new RegExp(`(?:[,.;]\\s*|\\s+(?:and|while|whereas|but)\\s+)(?=(?:${targetPattern})\\b)`, "i"),
  );
  return clauses.some(
    (clause) =>
      containsExactEntity(clause, target) &&
      comparisonClaimDimensions(objective, clause).includes(dimension),
  );
}
