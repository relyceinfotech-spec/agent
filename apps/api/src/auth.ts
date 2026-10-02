import { createClient } from "@supabase/supabase-js";
import { createSupabaseAuthFetch } from "./supabase-auth-fetch.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: VerifiedUser;
  }
}

export interface VerifiedUser {
  id: string;
  email?: string;
}

export interface AuthVerifier {
  verifyAccessToken(accessToken: string): Promise<VerifiedUser | undefined>;
}

function preserveBadJwtStatus(fetchImplementation: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchImplementation(input, init);
    if (response.status !== 403 || response.headers.get("x-sb-error-code") !== "bad_jwt") {
      return response;
    }

    try {
      await response.clone().json();
      return response;
    } catch {
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");

      return new Response(
        JSON.stringify({
          code: "bad_jwt",
          msg: "Invalid authentication token",
        }),
        {
          status: response.status,
          statusText: response.statusText,
          headers,
        },
      );
    }
  };
}

export class SupabaseAuthVerifier implements AuthVerifier {
  private readonly client: ReturnType<typeof createClient<any>>;

  constructor(
    url: string,
    apiKey: string,
    injectedClient?: ReturnType<typeof createClient<any>>,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.client =
      injectedClient ??
      createClient<any>(url, apiKey, {
        global: {
          fetch: preserveBadJwtStatus(createSupabaseAuthFetch(fetchImplementation)),
        },
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      });
  }

  async verifyAccessToken(accessToken: string): Promise<VerifiedUser | undefined> {
    const { data, error } = await this.client.auth.getClaims(accessToken);
    if (error) {
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 401 || status === 403) return undefined;
      throw error;
    }

    const claims = data?.claims as
      { sub?: unknown; role?: unknown; email?: unknown; is_anonymous?: unknown } | undefined;
    if (
      typeof claims?.sub !== "string" ||
      claims.role !== "authenticated" ||
      claims.is_anonymous === true
    ) {
      return undefined;
    }

    return {
      id: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
    };
  }
}
