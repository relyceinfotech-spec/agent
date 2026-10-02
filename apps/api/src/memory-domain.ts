export const USER_MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "project",
  "goal",
  "workflow",
] as const;

export type UserMemoryCategory = (typeof USER_MEMORY_CATEGORIES)[number];

export type UserMemorySourceType = "explicit_chat" | "explicit_api";

export interface UserMemoryProvenance {
  sourceType: UserMemorySourceType;
  sourceRef?: string;
  capturedAt: string;
}

export interface UserMemoryRecord {
  id: string;
  category: UserMemoryCategory;
  content: string;
  contentHash: string;
  sourceType: UserMemorySourceType;
  sourceRef?: string;
  provenance: UserMemoryProvenance[];
  confidence: number;
  importance: number;
  embedding: number[];
  embeddingModel: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type UserMemoryPublicRecord = Omit<
  UserMemoryRecord,
  "contentHash" | "embedding" | "embeddingModel"
>;

export interface NewUserMemoryRecord {
  category: UserMemoryCategory;
  content: string;
  contentHash: string;
  sourceType: UserMemorySourceType;
  sourceRef?: string;
  provenance: UserMemoryProvenance[];
  confidence: number;
  importance: number;
  embedding: number[];
  embeddingModel: string;
}

export interface UserMemorySearchResult extends UserMemoryPublicRecord {
  similarity: number;
}

export interface UserMemoryUpdate {
  category?: UserMemoryCategory;
  content?: string;
  contentHash?: string;
  importance?: number;
  embedding?: number[];
  embeddingModel?: string;
  isActive?: boolean;
  updatedAt: string;
}
