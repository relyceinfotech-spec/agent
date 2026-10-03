import { extractKnownEntities } from "./entities.js";
// Request wording and research dimensions cannot establish subject relevance.
const contextWords = new Set(
  `a an and are as at be between by can could current describe differences different do does explain find for from have how in information into is it latest most new of on or overview performance research should strategies strategy tell than that the their them these this those to tradeoffs use verified verify versus vs what when where which who why will with would compare comparison stable version versions system systems release releases official documentation notes evidence recent pricing price cost date dates published historical using cite exact available availability benefits`.split(
    /\s+/,
  ),
);

export function querySubjectTerms(question: string): string[] {
  const terms = (question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (term) => !contextWords.has(term),
  );
  terms.push(
    ...(question.match(/\b[A-Z]{1,2}\b/g) ?? [])
      .map((term) => term.toLowerCase())
      .filter((term) => !contextWords.has(term)),
  );
  return [...new Set(terms)];
}

function matchesTerm(text: string, term: string): boolean {
  const tokens = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return tokens.has(term) || tokens.has(`${term}s`);
}

export function requestedSubjectNames(question: string): string[] {
  return [
    ...new Set(
      (question.match(/\b[A-Z][A-Za-z0-9.-]*(?:\s+[A-Z][A-Za-z0-9.-]*)*/g) ?? [])
        .map((name) =>
          name
            .replace(
              /^(?:(?:Compare|Explain|What|Which|Please|According|Using|Investigate|Consider|List|Show|Current|Latest)\s+)+/i,
              "",
            )
            .replace(/[.-]+$/, ""),
        )
        .filter(
          (name) =>
            !contextWords.has(name.toLowerCase()) &&
            !/^(?:Please|According|Using|Investigate|Consider|List|Show|I|We|You)$/i.test(name),
        ),
    ),
  ];
}

/** A comparison needs findings, rather than an announcement about what a page covers. */
export function comparisonClaimMismatchReason(question: string, claim: string): string | undefined {
  if (
    !/\b(?:compare|comparison|differences|versus|vs|tradeoffs)\b/i.test(question) ||
    !/\b(?:performance|latency|throughput|benchmark)\b/i.test(question)
  )
    return undefined;
  const targets = requestedSubjectNames(question);
  const namesTarget = targets.some((target) =>
    target
      .toLowerCase()
      .split(/\s+/)
      .every((term) => matchesTerm(claim, term)),
  );
  const finding =
    /\b(?:faster|slower|higher|lower|less|more|outperform\w*|reduce\w*|increase\w*|improve\w*|requires?|uses?|achieves?|offers?|provides?|trades?|measured|recorded|latency\s+(?:is|was)|throughput\s+(?:is|was))\b|\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds|qps|fps|percent|%)\b/i.test(
      claim,
    );
  const describesPage =
    /\b(?:article|page|guide|report|post)\s+(?:breaks?\s+down|discusses?|explains?|covers?|compares?|reviews?|shows?)\b/i.test(
      claim,
    );
  if (describesPage && !finding)
    return "Claim describes a page's scope rather than a comparison finding.";
  if (
    targets.length >= 2 &&
    !namesTarget &&
    !(
      /^(?:it|they|this|these|those|both|(?:a|an|the|independent) (?:independent |documented )?(?:benchmark|results|measurement))\b/i.test(
        claim.trim(),
      ) && finding
    )
  )
    return "Comparison claim contains no finding about a requested target.";
  return undefined;
}

export function querySubjectMismatchReason(
  question: string,
  candidate: string,
  sourceContext?: string,
): string | undefined {
  const terms = querySubjectTerms(question);
  const text = candidate.toLowerCase();
  const requestedEntities = extractKnownEntities(question);
  const candidateEntities = extractKnownEntities(candidate);
  if (
    requestedEntities.length &&
    candidateEntities.length &&
    !candidateEntities.some((entity) => requestedEntities.includes(entity))
  ) {
    return "Candidate names an entity outside the current request.";
  }
  const requestedEntityPresent = requestedEntities.some((entity) =>
    extractKnownEntities(candidate).includes(entity),
  );
  const matchedTerms = terms.filter((term) => matchesTerm(text, term)).length;
  const requestedOtherNamePresent = requestedSubjectNames(question)
    .filter((name) => !extractKnownEntities(name).length)
    .some((name) =>
      name
        .toLowerCase()
        .split(/\s+/)
        .every((term) => matchesTerm(text, term)),
    );
  const minimumSubjectTerms = /\b(?:price|pricing|cost)\b/i.test(question)
    ? 1
    : Math.min(2, terms.length);
  if (
    terms.length &&
    !(
      requestedEntityPresent ||
      requestedOtherNamePresent ||
      (!requestedEntities.length && matchedTerms >= minimumSubjectTerms)
    )
  ) {
    // A benchmark passage can use an implicit subject, but only inside an
    // already relevant source. Explicit foreign entities never inherit it.
    if (!(
      sourceContext &&
      !querySubjectMismatchReason(question, sourceContext) &&
      candidateEntities.every((entity) => requestedEntities.includes(entity)) &&
      /^(?:it|they|this|these|those|both|(?:a|an|the|independent) (?:documented )?(?:benchmark|study|results|measurement|source)|published version or release tag)\b/i.test(
        candidate.trim(),
      ) &&
      /\b(?:performance|benchmark|latency|throughput|memory|architecture|comparison|methods|evidence|findings|study|version|release)\b/i.test(
        candidate,
      )
    ))
      return "Candidate does not mention the current request's subject.";
  }
  const dimensions = [
    [
      /\b(?:performance|latency|throughput|benchmark)\b/i,
      /\b(?:performance|speed|latency|throughput|benchmark|memory|recall|architecture|rendering|frame|frames|fps|accelerate|efficient|efficiency|search|retrieval)\b/i,
    ],
    [
      /\b(?:price|pricing)\b/i,
      /\b(?:price|pricing|cost|costs|free|paid|fee|fees|rate|dollars)\b|[$£€]/i,
    ],
    [
      /\bversion\b/i,
      /\b(?:version|versions|release|releases|released|semver|LTS|metadata)\b|\b\d+\.\d+(?:\.\d+)?\b/i,
    ],
  ];
  for (const [requestDimension, evidenceDimension] of dimensions) {
    if (requestDimension!.test(question) && !evidenceDimension!.test(candidate)) {
      return "Candidate does not address the requested evidence dimension.";
    }
  }
  return undefined;
}

/** Retain current-subject passages; a relevant title does not license arbitrary page sections. */
export function relevantSourceContent(
  question: string,
  content: string,
  sourceContext = "",
): string {
  const selected: string[] = [];
  let adjacentContext = sourceContext;
  for (const passage of content
    .split(/(?<=[.!?])\s+(?=[A-Z\p{Lu}])|\n+/u)
    .map((text) => text.trim())) {
    if (!passage) continue;
    const mismatch = querySubjectMismatchReason(question, passage);
    if (!mismatch) {
      selected.push(passage);
      adjacentContext = `${sourceContext} ${passage}`;
    } else if (adjacentContext && !querySubjectMismatchReason(question, passage, adjacentContext)) {
      selected.push(passage);
      adjacentContext = "";
    } else if (mismatch === "Candidate does not address the requested evidence dimension.") {
      if (/^Source:\s/i.test(passage)) selected.push(passage);
      adjacentContext = `${sourceContext} ${passage}`;
    } else {
      adjacentContext = "";
    }
  }
  return selected.join("\n");
}
