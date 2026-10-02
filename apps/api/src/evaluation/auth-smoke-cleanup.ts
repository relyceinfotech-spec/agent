interface AuthSmokeUser {
  id: string;
  email?: string | null;
}

interface AuthSmokeAdmin {
  deleteUser(id: string): Promise<{ error: unknown | null }>;
}

type Wait = (milliseconds: number) => Promise<void>;

class DuplicateAuthSmokeUsersError extends Error {}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const lookupRetryDelays = [200, 400] as const;
const reconciliationWaits = [250, 500, 750] as const;

export async function findTemporaryAuthUserIds(
  supabaseUrl: string,
  serverKey: string,
  targetEmails: ReadonlySet<string>,
  request: typeof fetch,
  pause: Wait = wait,
): Promise<string[]> {
  const matchingIds = new Set<string>();
  const pageSize = 1000;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(pageSize));

    let payload: { users: AuthSmokeUser[] } | undefined;
    let lookupError: unknown;
    for (let attempt = 0; attempt <= lookupRetryDelays.length; attempt += 1) {
      try {
        const response = await request(url, {
          method: "GET",
          headers: {
            apikey: serverKey,
            authorization: `Bearer ${serverKey}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Auth fixture lookup failed (HTTP ${response.status})`);
        }

        const body = (await response.json()) as { users?: AuthSmokeUser[] } | null;
        if (!body || !Array.isArray(body.users)) {
          throw new Error("Auth fixture lookup response was malformed");
        }
        payload = { users: body.users };
        break;
      } catch (error) {
        lookupError = error;
        if (attempt < lookupRetryDelays.length) {
          await pause(lookupRetryDelays[attempt]);
        }
      }
    }

    if (!payload) {
      throw lookupError instanceof Error ? lookupError : new Error("Auth fixture lookup failed");
    }

    for (const user of payload.users) {
      if (user.email && targetEmails.has(user.email.toLowerCase())) matchingIds.add(user.id);
    }

    if (payload.users.length < pageSize) return [...matchingIds];
  }

  throw new Error("Auth fixture lookup exceeded its page bound");
}

export async function createAuthUserWithReconciliation(
  createUser: () => Promise<{
    data: { user?: { id: string } | null } | null;
    error: unknown | null;
  }>,
  supabaseUrl: string,
  serverKey: string,
  email: string,
  options: {
    request?: typeof fetch;
    pause?: Wait;
    recoverByIdentity?: () => Promise<{ id: string } | undefined>;
    stopAfterUncertainCreate?: boolean;
    onReconciledUser?: (user: { id: string }) => void;
  } = {},
): Promise<{ id: string }> {
  const request = options.request ?? fetch;
  const pause = options.pause ?? wait;
  let createError: unknown;
  let createResponseIncomplete = false;
  try {
    const result = await createUser();
    if (result.error) throw result.error;
    if (result.data?.user?.id) return { id: result.data.user.id };
    createResponseIncomplete = true;
  } catch (error) {
    createError = error;
  }

  if (options.stopAfterUncertainCreate && (createError || createResponseIncomplete)) {
    try {
      const matches = await findTemporaryAuthUserIds(
        supabaseUrl,
        serverKey,
        new Set([email.toLowerCase()]),
        request,
        pause,
      );
      if (matches.length > 1) {
        throw new DuplicateAuthSmokeUsersError(
          "Auth reconciliation found duplicate exact-email fixtures",
        );
      }
      if (matches.length === 1) options.onReconciledUser?.({ id: matches[0] });
    } catch (error) {
      if (error instanceof DuplicateAuthSmokeUsersError) throw error;
      // Preserve the create failure; final cleanup performs its own exact-email scan.
    }

    throw (
      createError ??
      new Error("Auth create response was incomplete; stopped after exact-user reconciliation")
    );
  }

  if (options.recoverByIdentity) {
    try {
      const recoveredUser = await options.recoverByIdentity();
      if (recoveredUser) return recoveredUser;
    } catch (error) {
      createError ??= error;
    }
  }

  for (let attempt = 0; attempt <= reconciliationWaits.length; attempt += 1) {
    try {
      const matches = await findTemporaryAuthUserIds(
        supabaseUrl,
        serverKey,
        new Set([email.toLowerCase()]),
        request,
        pause,
      );

      if (matches.length === 1) return { id: matches[0] };
      if (matches.length > 1) {
        throw new DuplicateAuthSmokeUsersError(
          "Auth reconciliation found duplicate exact-email fixtures",
        );
      }
    } catch (error) {
      if (error instanceof DuplicateAuthSmokeUsersError) throw error;
      createError ??= error;
    }

    if (attempt < reconciliationWaits.length) {
      await pause(reconciliationWaits[attempt]);
    }
  }

  if (createResponseIncomplete) {
    throw new Error(
      "Auth create response was incomplete and exact-user reconciliation found no user",
    );
  }
  throw (
    createError ??
    new Error("Auth create response was uncertain and exact-user lookup found no user")
  );
}

export async function createAuthSmokeUserPair(
  createUserA: () => Promise<{ id: string }>,
  onUserACreated: (user: { id: string }) => void,
  createUserB: () => Promise<{ id: string }>,
): Promise<{ userA: { id: string }; userB: { id: string } }> {
  const userA = await createUserA();
  onUserACreated(userA);
  const userB = await createUserB();
  return { userA, userB };
}

export async function cleanupTemporaryAuthUsers(
  admin: AuthSmokeAdmin,
  supabaseUrl: string,
  serverKey: string,
  emails: readonly string[],
  knownIds: readonly (string | undefined)[],
  request: typeof fetch = fetch,
): Promise<void> {
  const idsToDelete = new Set(knownIds.filter((id): id is string => Boolean(id)));

  for (const id of idsToDelete) {
    const { error } = await admin.deleteUser(id);
    if (error && (error as { status?: number }).status !== 404) {
      throw new Error("Could not delete a temporary Auth fixture");
    }
  }

  const targetEmails = new Set(emails.map((email) => email.toLowerCase()));
  const recoveredIds = await findTemporaryAuthUserIds(
    supabaseUrl,
    serverKey,
    targetEmails,
    request,
  );

  for (const id of recoveredIds) {
    if (idsToDelete.has(id)) continue;
    const { error } = await admin.deleteUser(id);
    if (error && (error as { status?: number }).status !== 404) {
      throw new Error("Could not delete a recovered temporary Auth fixture");
    }
  }

  const remainingIds = await findTemporaryAuthUserIds(
    supabaseUrl,
    serverKey,
    targetEmails,
    request,
  );
  if (remainingIds.length > 0) {
    throw new Error("Temporary Auth fixtures remain after cleanup");
  }
}
