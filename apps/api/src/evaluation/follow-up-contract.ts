export interface FollowUpCitationContractInput {
  status?: string;
  answer?: string;
  sourceIds?: readonly string[];
  modelCallsBefore: number;
  modelCallsAfter: number;
}

export interface FollowUpCitationContractResult {
  passed: boolean;
  status?: string;
  answerPresent: boolean;
  answerLength: number;
  citationNumbers: number[];
  sourceIdCount: number;
  modelCallsBefore: number;
  modelCallsAfter: number;
  modelCallsDelta: number;
  checks: {
    completed: boolean;
    answerPresent: boolean;
    cited: boolean;
    sourceIdsPresent: boolean;
    citationsInRange: boolean;
    modelCallObserved: boolean;
  };
  failedChecks: string[];
}

/**
 * Capture the evaluator's follow-up acceptance contract without retaining the
 * answer text or source identifiers in the diagnostic report.
 */
export function inspectFollowUpCitationContract(
  input: FollowUpCitationContractInput,
): FollowUpCitationContractResult {
  const answer = typeof input.answer === "string" ? input.answer : "";
  const sourceIdCount = input.sourceIds?.length ?? 0;
  const citationNumbers = [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  const checks = {
    completed: input.status === "COMPLETED",
    answerPresent: answer.trim().length > 0,
    cited: citationNumbers.length > 0,
    sourceIdsPresent: sourceIdCount > 0,
    citationsInRange:
      citationNumbers.length > 0 &&
      citationNumbers.every((number) => number >= 1 && number <= sourceIdCount),
    modelCallObserved: input.modelCallsAfter > input.modelCallsBefore,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  return {
    passed: failedChecks.length === 0,
    status: input.status,
    answerPresent: checks.answerPresent,
    answerLength: answer.length,
    citationNumbers,
    sourceIdCount,
    modelCallsBefore: input.modelCallsBefore,
    modelCallsAfter: input.modelCallsAfter,
    modelCallsDelta: input.modelCallsAfter - input.modelCallsBefore,
    checks,
    failedChecks,
  };
}
