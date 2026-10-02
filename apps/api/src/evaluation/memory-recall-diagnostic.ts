export type MemoryRecallSimilaritySource = "threshold_relaxed_rpc" | "local_cosine" | "unavailable";

export interface MemoryRecallDiagnosticInput {
  temporaryUserId: string;
  authenticatedUserId: string;
  authenticatedUserIsAnonymous: boolean;
  memoryId: string;
  storedRowVisible?: boolean;
  storedRowReadError?: string;
  storedOwnerId?: string;
  storedEmbeddingModel?: string;
  queryEmbeddingModel?: string;
  storedConfidence?: number;
  storedIsActive?: boolean;
  storedVector?: number[];
  queryVector?: number[];
  databaseSimilarity?: number;
  databaseCandidateCount?: number;
  temporaryMemoryReturnedByThresholdRelaxedRpc?: boolean;
  databaseDiagnosticError?: { name: string; code?: string };
  configuredSimilarityThreshold: number;
  schemaDimensions: number;
}

export interface MemoryRecallDiagnostic {
  temporaryUserId: string;
  memoryId: string;
  storedEmbeddingModel?: string;
  queryEmbeddingModel?: string;
  storedVectorDimensions?: number;
  queryVectorDimensions?: number;
  rawSimilarity?: number;
  similaritySource: MemoryRecallSimilaritySource;
  configuredSimilarityThreshold: number;
  databaseCandidateCount: number;
  temporaryMemoryReturnedByThresholdRelaxedRpc: boolean;
  candidateFilters: {
    authenticatedIdentityMatchesTemporaryUser: boolean;
    authenticatedUserIsNonAnonymous: boolean;
    rowVisibleToAuthenticatedUser: boolean | null;
    ownerMatchesAuthenticatedUser: boolean | null;
    isActive: boolean | null;
    embeddingModelMatches: boolean | null;
    confidenceAtLeastMinimum: boolean | null;
    storedDimensionsMatchSchema: boolean | null;
    queryDimensionsMatchSchema: boolean | null;
    storedAndQueryDimensionsMatch: boolean | null;
    similarityMeetsThreshold: boolean | null;
    expiryFilter: "not_present_in_schema";
    statusFilter: "not_present_in_schema";
  };
  exclusionReasons: string[];
  finalReason: string;
  storedRowReadError?: string;
  databaseDiagnosticError?: { name: string; code?: string };
}

export interface MemorySearchStore<TCandidate> {
  searchUserMemories(
    embedding: number[],
    embeddingModel: string,
    minSimilarity: number,
    candidateLimit: number,
    limit: number,
  ): Promise<TCandidate[]>;
}

export function observeMemorySearchMisses<TCandidate, TStore extends MemorySearchStore<TCandidate>>(
  store: TStore,
  onMiss: (result: {
    embedding: number[];
    embeddingModel: string;
    minSimilarity: number;
    candidates: TCandidate[];
    diagnosticError?: unknown;
  }) => void,
): TStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "searchUserMemories") {
        return async (
          embedding: number[],
          embeddingModel: string,
          minSimilarity: number,
          candidateLimit: number,
          limit: number,
        ) => {
          const results = await target.searchUserMemories(
            embedding,
            embeddingModel,
            minSimilarity,
            candidateLimit,
            limit,
          );
          if (results.length === 0) {
            try {
              const candidates = await target.searchUserMemories(
                embedding,
                embeddingModel,
                0,
                candidateLimit,
                limit,
              );
              onMiss({ embedding, embeddingModel, minSimilarity, candidates });
            } catch (diagnosticError) {
              onMiss({
                embedding,
                embeddingModel,
                minSimilarity,
                candidates: [],
                diagnosticError,
              });
            }
          }
          return results;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TStore;
}

export function parsePostgresVector(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "number" && Number.isFinite(item))) {
      return value as number[];
    }
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^\[\s*(.*?)\s*\]$/s);
  if (!match) return undefined;
  if (match[1].trim() === "") return [];
  const vector = match[1].split(",").map((item) => Number(item.trim()));
  return vector.every(Number.isFinite) ? vector : undefined;
}

function cosineSimilarity(left?: number[], right?: number[]): number | undefined {
  if (
    !left ||
    !right ||
    left.length === 0 ||
    left.length !== right.length ||
    !left.every(Number.isFinite) ||
    !right.every(Number.isFinite)
  ) {
    return undefined;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Math.fround(left[index]);
    const rightValue = Math.fround(right[index]);
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return undefined;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function diagnoseMemoryRecall(input: MemoryRecallDiagnosticInput): MemoryRecallDiagnostic {
  const localSimilarity = cosineSimilarity(input.storedVector, input.queryVector);
  const rawSimilarity = Number.isFinite(input.databaseSimilarity)
    ? input.databaseSimilarity
    : localSimilarity;
  const similaritySource: MemoryRecallSimilaritySource = Number.isFinite(input.databaseSimilarity)
    ? "threshold_relaxed_rpc"
    : rawSimilarity === undefined
      ? "unavailable"
      : "local_cosine";
  const storedVectorDimensions = input.storedVector?.length;
  const queryVectorDimensions = input.queryVector?.length;
  const storedDimensionsMatchSchema =
    storedVectorDimensions === undefined ? null : storedVectorDimensions === input.schemaDimensions;
  const queryDimensionsMatchSchema =
    queryVectorDimensions === undefined ? null : queryVectorDimensions === input.schemaDimensions;
  const dimensionsMatch =
    storedVectorDimensions === undefined || queryVectorDimensions === undefined
      ? null
      : storedVectorDimensions === queryVectorDimensions;
  const ownerMatches = input.storedOwnerId
    ? input.storedOwnerId === input.authenticatedUserId
    : null;
  const embeddingModelMatches =
    input.storedEmbeddingModel && input.queryEmbeddingModel
      ? input.storedEmbeddingModel === input.queryEmbeddingModel
      : null;
  const confidenceAtLeastMinimum =
    input.storedConfidence === undefined ? null : input.storedConfidence >= 0.5;
  const modelAndDimensionsComparable = embeddingModelMatches === true && dimensionsMatch === true;
  const similarityMeetsThreshold =
    rawSimilarity === undefined || !modelAndDimensionsComparable
      ? null
      : rawSimilarity >= input.configuredSimilarityThreshold;
  const filters: MemoryRecallDiagnostic["candidateFilters"] = {
    authenticatedIdentityMatchesTemporaryUser: input.authenticatedUserId === input.temporaryUserId,
    authenticatedUserIsNonAnonymous: !input.authenticatedUserIsAnonymous,
    rowVisibleToAuthenticatedUser: input.storedRowVisible ?? null,
    ownerMatchesAuthenticatedUser: ownerMatches,
    isActive: input.storedIsActive ?? null,
    embeddingModelMatches,
    confidenceAtLeastMinimum,
    storedDimensionsMatchSchema,
    queryDimensionsMatchSchema,
    storedAndQueryDimensionsMatch: dimensionsMatch,
    similarityMeetsThreshold,
    expiryFilter: "not_present_in_schema",
    statusFilter: "not_present_in_schema",
  };
  const exclusionReasons: string[] = [];

  if (!filters.authenticatedIdentityMatchesTemporaryUser) {
    exclusionReasons.push("authenticated_identity_does_not_match_temporary_user");
  }
  if (!filters.authenticatedUserIsNonAnonymous) exclusionReasons.push("anonymous_user_is_excluded");
  if (filters.rowVisibleToAuthenticatedUser === false) {
    exclusionReasons.push("memory_row_not_visible_to_authenticated_user");
  }
  if (filters.ownerMatchesAuthenticatedUser === false) exclusionReasons.push("owner_mismatch");
  if (filters.isActive === false) exclusionReasons.push("memory_inactive");
  if (filters.embeddingModelMatches === false) exclusionReasons.push("embedding_model_mismatch");
  if (filters.confidenceAtLeastMinimum === false) {
    exclusionReasons.push("confidence_below_0.5");
  }
  if (filters.storedDimensionsMatchSchema === false) {
    exclusionReasons.push("stored_vector_dimension_mismatch");
  }
  if (filters.queryDimensionsMatchSchema === false) {
    exclusionReasons.push("query_vector_dimension_mismatch");
  }
  if (filters.storedAndQueryDimensionsMatch === false) {
    exclusionReasons.push("stored_and_query_dimensions_differ");
  }
  if (filters.similarityMeetsThreshold === false) {
    exclusionReasons.push("similarity_below_configured_threshold");
  }

  const temporaryMemoryReturnedByThresholdRelaxedRpc = Boolean(
    input.temporaryMemoryReturnedByThresholdRelaxedRpc,
  );
  if (
    exclusionReasons.length === 0 &&
    !temporaryMemoryReturnedByThresholdRelaxedRpc &&
    filters.similarityMeetsThreshold !== false &&
    !input.databaseDiagnosticError
  ) {
    exclusionReasons.push("rpc_returned_no_candidate_despite_observed_filters");
  }

  return {
    temporaryUserId: input.temporaryUserId,
    memoryId: input.memoryId,
    storedEmbeddingModel: input.storedEmbeddingModel,
    queryEmbeddingModel: input.queryEmbeddingModel,
    storedVectorDimensions,
    queryVectorDimensions,
    rawSimilarity,
    similaritySource,
    configuredSimilarityThreshold: input.configuredSimilarityThreshold,
    databaseCandidateCount: input.databaseCandidateCount ?? 0,
    temporaryMemoryReturnedByThresholdRelaxedRpc,
    candidateFilters: filters,
    exclusionReasons,
    finalReason:
      exclusionReasons[0] ??
      (input.databaseDiagnosticError
        ? "threshold_relaxed_rpc_diagnostic_failed"
        : temporaryMemoryReturnedByThresholdRelaxedRpc
          ? "database_candidate_passed_filters_but_original_search_missed_it"
          : input.storedRowReadError
            ? "stored_row_metadata_unavailable"
            : "no_exclusion_identified_from_observed_candidate_filters"),
    storedRowReadError: input.storedRowReadError,
    databaseDiagnosticError: input.databaseDiagnosticError,
  };
}
