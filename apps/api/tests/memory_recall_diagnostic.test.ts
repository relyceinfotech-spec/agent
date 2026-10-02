import { describe, expect, it } from "vitest";
import {
  diagnoseMemoryRecall,
  observeMemorySearchMisses,
  parsePostgresVector,
  type MemoryRecallDiagnosticInput,
} from "../src/evaluation/memory-recall-diagnostic.js";

const baseInput: MemoryRecallDiagnosticInput = {
  temporaryUserId: "user-a",
  authenticatedUserId: "user-a",
  authenticatedUserIsAnonymous: false,
  memoryId: "memory-a",
  storedRowVisible: true,
  storedOwnerId: "user-a",
  storedEmbeddingModel: "provider/model-v1",
  queryEmbeddingModel: "provider/model-v1",
  storedConfidence: 1,
  storedIsActive: true,
  storedVector: [1, 0, 0],
  queryVector: [1, 0, 0],
  configuredSimilarityThreshold: 0.45,
  schemaDimensions: 3,
  databaseSimilarity: 1,
  databaseCandidateCount: 1,
  temporaryMemoryReturnedByThresholdRelaxedRpc: true,
};

describe("memory recall diagnostics", () => {
  it("classifies a threshold miss using the database score without changing retrieval policy", () => {
    const result = diagnoseMemoryRecall({
      ...baseInput,
      databaseSimilarity: 0.4,
      temporaryMemoryReturnedByThresholdRelaxedRpc: true,
    });

    expect(result.rawSimilarity).toBe(0.4);
    expect(result.similaritySource).toBe("threshold_relaxed_rpc");
    expect(result.candidateFilters.similarityMeetsThreshold).toBe(false);
    expect(result.finalReason).toBe("similarity_below_configured_threshold");
  });

  it("reports embedding-model mismatch separately from similarity", () => {
    const result = diagnoseMemoryRecall({
      ...baseInput,
      storedEmbeddingModel: "provider/model-v1",
      queryEmbeddingModel: "provider/model-v2",
      temporaryMemoryReturnedByThresholdRelaxedRpc: false,
    });

    expect(result.candidateFilters.embeddingModelMatches).toBe(false);
    expect(result.candidateFilters.similarityMeetsThreshold).toBeNull();
    expect(result.exclusionReasons).toContain("embedding_model_mismatch");
  });

  it("reports owner, anonymous, inactive, and confidence filters independently", () => {
    const result = diagnoseMemoryRecall({
      ...baseInput,
      authenticatedUserId: "user-b",
      authenticatedUserIsAnonymous: true,
      storedOwnerId: "user-a",
      storedIsActive: false,
      storedConfidence: 0.4,
    });

    expect(result.candidateFilters.ownerMatchesAuthenticatedUser).toBe(false);
    expect(result.candidateFilters.authenticatedUserIsNonAnonymous).toBe(false);
    expect(result.candidateFilters.isActive).toBe(false);
    expect(result.candidateFilters.confidenceAtLeastMinimum).toBe(false);
    expect(result.exclusionReasons).toEqual(
      expect.arrayContaining([
        "authenticated_identity_does_not_match_temporary_user",
        "anonymous_user_is_excluded",
        "owner_mismatch",
        "memory_inactive",
        "confidence_below_0.5",
      ]),
    );
  });

  it("reports stored and query dimension failures", () => {
    const result = diagnoseMemoryRecall({
      ...baseInput,
      storedVector: [1, 0],
      queryVector: [1, 0, 0],
      schemaDimensions: 3,
    });

    expect(result.candidateFilters.storedDimensionsMatchSchema).toBe(false);
    expect(result.candidateFilters.storedAndQueryDimensionsMatch).toBe(false);
    expect(result.exclusionReasons).toContain("stored_vector_dimension_mismatch");
  });

  it("distinguishes an absent or RLS-hidden fixture row from a similarity miss", () => {
    const result = diagnoseMemoryRecall({
      ...baseInput,
      storedRowVisible: false,
      storedOwnerId: undefined,
      storedEmbeddingModel: undefined,
      storedConfidence: undefined,
      storedIsActive: undefined,
      storedVector: undefined,
      databaseSimilarity: undefined,
      databaseCandidateCount: 0,
      temporaryMemoryReturnedByThresholdRelaxedRpc: false,
    });

    expect(result.candidateFilters.rowVisibleToAuthenticatedUser).toBe(false);
    expect(result.exclusionReasons).toContain("memory_row_not_visible_to_authenticated_user");
    expect(result.finalReason).toBe("memory_row_not_visible_to_authenticated_user");
    expect(result).not.toHaveProperty("storedVector");
    expect(result).not.toHaveProperty("queryVector");
  });

  it("uses a local cosine score if the threshold-relaxed RPC returns no row", () => {
    const result = diagnoseMemoryRecall({
      ...baseInput,
      databaseSimilarity: undefined,
      databaseCandidateCount: 0,
      temporaryMemoryReturnedByThresholdRelaxedRpc: false,
      queryVector: [0, 1, 0],
    });

    expect(result.rawSimilarity).toBe(0);
    expect(result.similaritySource).toBe("local_cosine");
    expect(result.candidateFilters.expiryFilter).toBe("not_present_in_schema");
    expect(result.candidateFilters.statusFilter).toBe("not_present_in_schema");
  });

  it("parses stored pgvector text without exposing vector contents in the report", () => {
    expect(parsePostgresVector("[1, -0.25, 3.5]")).toEqual([1, -0.25, 3.5]);
    expect(parsePostgresVector("[1, nope]")).toBeUndefined();
    expect(parsePostgresVector([1, 2])).toEqual([1, 2]);
  });

  it("runs one threshold-relaxed read only after a normal search miss and preserves the original result", async () => {
    const calls: number[] = [];
    const onMiss = [] as Array<{ candidates: Array<{ id: string; similarity: number }> }>;
    const store = {
      async searchUserMemories(
        _embedding: number[],
        _model: string,
        threshold: number,
        _candidateLimit: number,
        _limit: number,
      ) {
        calls.push(threshold);
        return threshold === 0 ? [{ id: "memory-a", similarity: 0.4 }] : [];
      },
    };
    const observedStore = observeMemorySearchMisses(store, (result) => onMiss.push(result));

    await expect(
      observedStore.searchUserMemories([1, 0], "provider/model-v1", 0.45, 10, 5),
    ).resolves.toEqual([]);
    expect(calls).toEqual([0.45, 0]);
    expect(onMiss).toEqual([
      {
        embedding: [1, 0],
        embeddingModel: "provider/model-v1",
        minSimilarity: 0.45,
        candidates: [{ id: "memory-a", similarity: 0.4 }],
      },
    ]);
  });

  it("does not issue diagnostic reads when normal retrieval succeeds", async () => {
    let calls = 0;
    let observedMiss = false;
    const store = {
      async searchUserMemories() {
        calls += 1;
        return [{ id: "memory-a", similarity: 0.9 }];
      },
    };
    const observedStore = observeMemorySearchMisses(store, () => {
      observedMiss = true;
    });

    await expect(
      observedStore.searchUserMemories([], "provider/model-v1", 0.45, 10, 5),
    ).resolves.toEqual([{ id: "memory-a", similarity: 0.9 }]);
    expect(calls).toBe(1);
    expect(observedMiss).toBe(false);
  });
});
