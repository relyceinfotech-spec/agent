/**
 * Request identity-encoded responses only from Supabase Auth endpoints.
 * This avoids relying on intermediaries to preserve compression metadata while
 * leaving unrelated Supabase and application fetches unchanged.
 */
export function createSupabaseAuthFetch(fetchImplementation: typeof fetch): typeof fetch {
  return (input, init) => {
    const inputUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;

    let isAuthRequest = false;
    try {
      isAuthRequest = /(?:^|\/)auth\/v1(?:\/|$)/.test(new URL(inputUrl).pathname);
    } catch {
      // Leave malformed or relative URLs to the underlying fetch implementation.
    }

    if (!isAuthRequest) return fetchImplementation(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("accept-encoding", "identity");

    return fetchImplementation(input, { ...init, headers });
  };
}
