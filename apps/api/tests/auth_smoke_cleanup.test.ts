import { describe, expect, it, vi } from "vitest";
import {
  cleanupTemporaryAuthUsers,
  createAuthSmokeUserPair,
  createAuthUserWithReconciliation,
} from "../src/evaluation/auth-smoke-cleanup.js";

const supabaseUrl = "https://example.supabase.co";
const serverKey = "test-server-key";

describe("Auth smoke fixture cleanup", () => {
  it("returns a directly successful one-user create without lookup or retry", async () => {
    const createUser = vi.fn(async () => ({
      data: { user: { id: "created-user-id" } },
      error: null,
    }));
    const request = vi.fn();

    await expect(
      createAuthUserWithReconciliation(
        createUser,
        supabaseUrl,
        serverKey,
        "max-auth-smoke-a@example.com",
        { request: request as typeof fetch },
      ),
    ).resolves.toEqual({ id: "created-user-id" });
    expect(createUser).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("creates User A and User B sequentially and records A before starting B", async () => {
    const events: string[] = [];
    const result = await createAuthSmokeUserPair(
      async () => {
        events.push("A:start");
        await Promise.resolve();
        events.push("A:complete");
        return { id: "user-a" };
      },
      (user) => events.push(`A:recorded:${user.id}`),
      async () => {
        events.push("B:start");
        return { id: "user-b" };
      },
    );

    expect(events).toEqual(["A:start", "A:complete", "A:recorded:user-a", "B:start"]);
    expect(result).toEqual({ userA: { id: "user-a" }, userB: { id: "user-b" } });
  });

  it("reconciles a committed create when the client loses its response", async () => {
    const targetEmail = "max-auth-smoke-a@example.com";
    const createUser = vi.fn(async () => {
      throw new Error("transport response lost");
    });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(
        JSON.stringify({
          users: [
            { id: "unrelated-user-id", email: "someone@example.com" },
            { id: "committed-user-id", email: targetEmail },
          ],
        }),
        { status: 200 },
      );
    });

    await expect(
      createAuthUserWithReconciliation(createUser, supabaseUrl, serverKey, targetEmail, {
        request: request as typeof fetch,
      }),
    ).resolves.toEqual({ id: "committed-user-id" });
    expect(createUser).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("paginates user listing and matches only the exact temporary email", async () => {
    const targetEmail = "max-auth-smoke-a@example.com";
    const createUser = vi.fn(async () => {
      throw new Error("transport response lost");
    });
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: `unrelated-${index}`,
      email: `unrelated-${index}@example.com`,
    }));
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const page = new URL(input.toString()).searchParams.get("page");
      const users = page === "1" ? firstPage : [{ id: "committed-user-id", email: targetEmail }];
      return new Response(JSON.stringify({ users }), { status: 200 });
    });

    await expect(
      createAuthUserWithReconciliation(createUser, supabaseUrl, serverKey, targetEmail, {
        request: request as typeof fetch,
      }),
    ).resolves.toEqual({ id: "committed-user-id" });
    expect(createUser).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(new URL(request.mock.calls[0][0].toString()).searchParams.get("page")).toBe("1");
    expect(new URL(request.mock.calls[1][0].toString()).searchParams.get("page")).toBe("2");
  });

  it("recovers a lost create response by authenticating the exact temporary identity", async () => {
    const createUser = vi.fn(async () => {
      throw new Error("transport response lost");
    });
    const recoverByIdentity = vi.fn(async () => ({ id: "authenticated-user-id" }));
    const request = vi.fn();

    await expect(
      createAuthUserWithReconciliation(
        createUser,
        supabaseUrl,
        serverKey,
        "max-auth-smoke-a@example.com",
        { recoverByIdentity, request: request as typeof fetch },
      ),
    ).resolves.toEqual({ id: "authenticated-user-id" });
    expect(createUser).toHaveBeenCalledOnce();
    expect(recoverByIdentity).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not repeat create when reconciliation confirms absence", async () => {
    const createUser = vi.fn(async () => {
      throw new Error("transport response lost");
    });
    const request = vi.fn(async () => new Response(JSON.stringify({ users: [] }), { status: 200 }));
    const pause = vi.fn(async () => undefined);

    await expect(
      createAuthUserWithReconciliation(
        createUser,
        supabaseUrl,
        serverKey,
        "max-auth-smoke-a@example.com",
        { request: request as typeof fetch, pause },
      ),
    ).rejects.toThrow("transport response lost");
    expect(createUser).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("reconciles an SDK HTTP 0 by exact email without issuing a second create", async () => {
    const targetEmail = "max-auth-smoke-a@example.com";
    const transportError = Object.assign(new Error("fetch failed"), {
      name: "AuthRetryableFetchError",
      status: 0,
    });
    const createUser = vi.fn(async () => {
      throw transportError;
    });
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ users: [{ id: "committed-user-id", email: targetEmail }] }), {
          status: 200,
        }),
    );

    await expect(
      createAuthUserWithReconciliation(createUser, supabaseUrl, serverKey, targetEmail, {
        request: request as typeof fetch,
        pause: async () => undefined,
      }),
    ).resolves.toEqual({ id: "committed-user-id" });
    expect(createUser).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("stops the E2E after an uncertain User A create and one exact-identity reconciliation", async () => {
    const targetEmail = "max-auth-smoke-a@example.com";
    const transportError = Object.assign(new Error("SDK response parse failed"), {
      name: "AuthRetryableFetchError",
      status: 0,
    });
    const createUser = vi.fn(async () => ({ data: null, error: transportError }));
    const recoverByIdentity = vi.fn(async () => ({ id: "must-not-sign-in" }));
    const onReconciledUser = vi.fn();
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ users: [{ id: "committed-user-id", email: targetEmail }] }), {
          status: 200,
        }),
    );

    await expect(
      createAuthUserWithReconciliation(createUser, supabaseUrl, serverKey, targetEmail, {
        request: request as typeof fetch,
        pause: async () => undefined,
        recoverByIdentity,
        stopAfterUncertainCreate: true,
        onReconciledUser,
      }),
    ).rejects.toBe(transportError);

    expect(createUser).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(recoverByIdentity).not.toHaveBeenCalled();
    expect(onReconciledUser).toHaveBeenCalledExactlyOnceWith({ id: "committed-user-id" });
  });

  it("waits for a committed user to become visible without repeating create", async () => {
    const targetEmail = "max-auth-smoke-a@example.com";
    const createUser = vi.fn(async () => {
      throw new Error("transport response lost");
    });
    let lookupCount = 0;
    const request = vi.fn(async () => {
      lookupCount += 1;
      const users = lookupCount === 1 ? [] : [{ id: "committed-user-id", email: targetEmail }];
      return new Response(JSON.stringify({ users }), { status: 200 });
    });
    const pause = vi.fn(async () => undefined);

    await expect(
      createAuthUserWithReconciliation(createUser, supabaseUrl, serverKey, targetEmail, {
        request: request as typeof fetch,
        pause,
      }),
    ).resolves.toEqual({ id: "committed-user-id" });
    expect(createUser).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledExactlyOnceWith(250);
  });

  it("retries a malformed lookup response without repeating the create", async () => {
    const targetEmail = "max-auth-smoke-a@example.com";
    const createUser = vi.fn(async () => {
      throw new Error("transport response lost");
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ users: [{ id: "committed-user-id", email: targetEmail }] }), {
          status: 200,
        }),
      );
    const pause = vi.fn(async () => undefined);

    await expect(
      createAuthUserWithReconciliation(createUser, supabaseUrl, serverKey, targetEmail, {
        request: request as typeof fetch,
        pause,
      }),
    ).resolves.toEqual({ id: "committed-user-id" });
    expect(createUser).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledExactlyOnceWith(200);
  });

  it("recovers and deletes a user whose create response was lost", async () => {
    const targetEmail = "max-auth-smoke-a@example.com";
    let deleted = false;
    const deleteUser = vi.fn(async () => {
      deleted = true;
      return { error: null };
    });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      const users = !deleted ? [{ id: "recovered-user-id", email: targetEmail }] : [];
      return new Response(JSON.stringify({ users }), { status: 200 });
    });

    await cleanupTemporaryAuthUsers(
      { deleteUser },
      supabaseUrl,
      serverKey,
      [targetEmail, "max-auth-smoke-b@example.com"],
      [],
      request as typeof fetch,
    );

    expect(deleteUser).toHaveBeenCalledExactlyOnceWith("recovered-user-id");
    expect(request).toHaveBeenCalledTimes(2);
    for (const [input, init] of request.mock.calls) {
      expect(new URL(input.toString()).searchParams.get("page")).toBe("1");
      expect(new URL(input.toString()).searchParams.get("per_page")).toBe("1000");
      expect(init?.method).toBe("GET");
    }
  });

  it("deletes known users and does not delete unrelated accounts", async () => {
    const deleteUser = vi.fn(async () => ({ error: null }));
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ users: [{ id: "unrelated-user-id", email: "someone@example.com" }] }),
          { status: 200 },
        ),
    );

    await cleanupTemporaryAuthUsers(
      { deleteUser },
      supabaseUrl,
      serverKey,
      ["max-auth-smoke-a@example.com"],
      ["known-user-id", undefined],
      request as typeof fetch,
    );

    expect(deleteUser).toHaveBeenCalledExactlyOnceWith("known-user-id");
  });

  it("fails closed when an exact-email lookup fails", async () => {
    const deleteUser = vi.fn(async () => ({ error: null }));
    const request = vi.fn(async () => new Response("", { status: 503 }));
    const pause = vi.fn(async () => undefined);

    await expect(
      cleanupTemporaryAuthUsers(
        { deleteUser },
        supabaseUrl,
        serverKey,
        ["max-auth-smoke-a@example.com"],
        [],
        request as typeof fetch,
        pause,
      ),
    ).rejects.toThrow("HTTP 503");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
