import type { ReleaseEvidenceRecord } from "../domain.js";
import {
  requestedFactCoverage,
  type RequestedFactCoverage,
  type RequestedFactKind,
} from "../requested-facts.js";

type CoverageOptions = Omit<
  NonNullable<Parameters<typeof requestedFactCoverage>[2]>,
  "releaseEvidence"
> & { releaseEvidence?: ReleaseEvidenceRecord[] };

export interface ResearchFactCoverageInput {
  question: string;
  verifiedClaimTexts: string[];
  verifiedOfficialClaimTexts: string[];
  latestnessProven: boolean;
  latestnessVersion?: string;
  requestedFacts?: RequestedFactKind[];
  releaseRecords: ReleaseEvidenceRecord[];
  officialSourcesRequired: boolean;
}

export interface ResearchFactCoverageResult {
  requested: RequestedFactCoverage;
  official: RequestedFactCoverage;
  requestedOptions: CoverageOptions;
}

/** Keep evaluator coverage aligned with the canonical research-state evidence inputs. */
export function researchFactCoverage(input: ResearchFactCoverageInput): ResearchFactCoverageResult {
  const requestedOptions: CoverageOptions = {
    latestnessProven: input.latestnessProven,
    latestnessVersion: input.latestnessVersion,
    requestedFacts: input.requestedFacts,
    releaseEvidence: input.releaseRecords,
    officialSourcesRequired: input.officialSourcesRequired,
  };
  const officialOptions: CoverageOptions = {
    ...requestedOptions,
    releaseEvidence: input.releaseRecords.filter((record) => record.officialSource),
    officialSourcesRequired: true,
  };

  return {
    requested: requestedFactCoverage(input.question, input.verifiedClaimTexts, requestedOptions),
    official: requestedFactCoverage(
      input.question,
      input.verifiedOfficialClaimTexts,
      officialOptions,
    ),
    requestedOptions,
  };
}
