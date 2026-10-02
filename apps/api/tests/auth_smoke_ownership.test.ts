import { describe, expect, it, vi } from "vitest";
import {
  lookupResearchSessionOwner,
  summarizeOwnershipLookupError,
} from "../src/evaluation/auth-smoke-ownership.js";

interface QueryResult {
  data: { owner_id: string } | null;
  error: unknown | null;
}

function fakeAdmin(rows: Record<string, string>, error: unknown | null = null) {
  const calls: string[] = [];
  const schema = vi.fn((schemaName: string) => {
    if (schemaName !== "research") throw new Error(`Unexpected schema: ${schemaName}`);

    return {
      from: vi.fn((tableName: string) => {
        calls.push(`from:${tableName}`);
        if (tableName !== "max_research_sessions")
          throw new Error(`Unexpected table: ${tableName}`);

        return {
          select: vi.fn((columns: string) => {
            calls.push(`select:${columns}`);
            if (columns !== "owner_id") throw new Error(`Unexpected columns: ${columns}`);

            return {
              eq: vi.fn((column: string, sessionId: string) => {
                calls.push(`eq:${column}:${sessionId}`);
                if (column !== "id") throw new Error(`Unexpected filter: ${column}`);

                return {
                  maybeSingle: vi.fn(async (): Promise<QueryResult> => ({
                    data: rows[sessionId] ? { owner_id: rows[sessionId] } : null,
                    error,
                  })),
                };
              }),
            };
          }),
        };
      }),
    };
  });

  return { client: { schema }, calls, schema };
}

describe("Auth smoke service-role ownership lookup", () => {
  it("reads each owner's row through the research schema without mutations", async () => {
    const ownerA = "user-a-id";
    const ownerB = "user-b-id";
    const sessionA = "session-a-id";
    const sessionB = "session-b-id";
    const admin = fakeAdmin({ [sessionA]: ownerA, [sessionB]: ownerB });

    const resultA = await lookupResearchSessionOwner(admin.client, sessionA);
    const resultB = await lookupResearchSessionOwner(admin.client, sessionB);

    expect(resultA).toEqual({ ownerId: ownerA, error: null });
    expect(resultB).toEqual({ ownerId: ownerB, error: null });
    expect(admin.schema).toHaveBeenCalledTimes(2);
    expect(admin.schema).toHaveBeenNthCalledWith(1, "research");
    expect(admin.schema).toHaveBeenNthCalledWith(2, "research");
    expect(admin.calls).toEqual([
      "from:max_research_sessions",
      "select:owner_id",
      `eq:id:${sessionA}`,
      "from:max_research_sessions",
      "select:owner_id",
      `eq:id:${sessionB}`,
    ]);
  });

  it("returns a clean no-row result for a missing session ID", async () => {
    const admin = fakeAdmin({});

    await expect(lookupResearchSessionOwner(admin.client, "missing-session")).resolves.toEqual({
      ownerId: null,
      error: null,
    });
  });

  it("surfaces safe structured error details and redacts identity and credentials", () => {
    const error = Object.assign(
      new Error("permission denied for 82d4f034-94f6-47cc-902e-f47f19ac4860 Bearer abc.def.ghi"),
      { code: "42501", status: 403 },
    );

    expect(summarizeOwnershipLookupError(error)).toMatchObject({
      name: "Error",
      code: "42501",
      status: 403,
      message: "permission denied for [uuid] Bearer [redacted]",
      messageLength: error.message.length,
    });
    expect(JSON.stringify(summarizeOwnershipLookupError(error))).not.toContain(
      "82d4f034-94f6-47cc-902e-f47f19ac4860",
    );
    expect(JSON.stringify(summarizeOwnershipLookupError(error))).not.toContain("abc.def.ghi");
  });

  it("omits structured or non-text error bodies but preserves a hash", () => {
    const summary = summarizeOwnershipLookupError({ message: '{"access_token":"private"}' });

    expect(summary).toMatchObject({
      message: "[omitted: structured or non-text response]",
      messageLength: 26,
    });
    expect(summary?.messageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("private");
  });
});
