import { createHash } from "node:crypto";

interface OwnerRow {
  owner_id: string;
}

interface OwnershipResearchClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: OwnerRow | null;
          error: unknown | null;
        }>;
      };
    };
  };
}

export interface SessionOwnerLookup {
  ownerId: string | null;
  error: unknown | null;
}

export async function lookupResearchSessionOwner(
  admin: unknown,
  sessionId: string,
): Promise<SessionOwnerLookup> {
  const schemaClient = admin as { schema: (schema: string) => OwnershipResearchClient };
  const { data, error } = await schemaClient
    .schema("research")
    .from("max_research_sessions")
    .select("owner_id")
    .eq("id", sessionId)
    .maybeSingle();

  return {
    ownerId: typeof data?.owner_id === "string" ? data.owner_id : null,
    error,
  };
}

export function summarizeOwnershipLookupError(error: unknown): Record<string, unknown> | null {
  if (error === null || error === undefined) return null;

  const value = typeof error === "object" ? (error as Record<string, unknown>) : {};
  const rawMessage = typeof value.message === "string" ? value.message : undefined;
  const messageSha256 = rawMessage
    ? createHash("sha256").update(rawMessage).digest("hex")
    : undefined;
  const sanitizedMessage = rawMessage
    ?.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/gi, "[redacted-key]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]")
    .replace(/[\r\n\t]+/g, " ");
  const messageIsSafePlainText = Boolean(
    sanitizedMessage &&
    sanitizedMessage.length <= 500 &&
    /^[\x20-\x7e]+$/.test(sanitizedMessage) &&
    !/^\s*[{[<]/.test(sanitizedMessage),
  );

  return {
    name: typeof value.name === "string" ? value.name : undefined,
    code: typeof value.code === "string" ? value.code : undefined,
    status:
      typeof value.status === "number"
        ? value.status
        : typeof value.statusCode === "number"
          ? value.statusCode
          : undefined,
    message: messageIsSafePlainText
      ? sanitizedMessage
      : rawMessage
        ? "[omitted: structured or non-text response]"
        : undefined,
    messageLength: rawMessage?.length,
    messageSha256,
  };
}
