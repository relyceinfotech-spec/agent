# Auth smoke response transport investigation

## Result

No response-body mutation was found in `createAuthSmokeFetch`. The wrapper awaits
its configured `fetchImpl`, reads only `response.clone()`, and returns the same
`Response` object to the Supabase client. It does not reconstruct the response or
rewrite its body or headers.

The wrapper now records `responseObservedAt: "auth-smoke-fetch-wrapper"`, a
safe response-header whitelist, and a hash stage explicitly defined as the
bytes exposed by Fetch to the SDK. When those bytes have a gzip signature, it
also computes a size-bounded decoded hash/JSON-validity summary in memory; it
never writes or logs the response body. Standard Fetch does not expose a
separate raw-wire body stream, so the report does not claim to have a wire hash.

## Evidence

- The installed `@supabase/auth-js` version is 2.117.1. `GoTrueAdminApi`
  resolves the injected fetch and `createUser()` sends `POST /admin/users`
  through it. The request handler then parses `Response.json()`.
- The isolated diagnostic used the same smoke fetch wrapper and received HTTP
  200, `application/json`, `Content-Encoding: gzip`, a 1,017-byte decoded valid
  JSON body, and a successfully parsed user response.
- The later full-smoke report recorded HTTP 200 but only 383 response bytes,
  classified as `binary-or-encoded`; it contains no content-type, content-length,
  or content-encoding values. The SDK consequently surfaced status 0 while
  parsing the response.
- The full smoke previously passed the unbound `globalThis.fetch` function into
  the wrapper, whereas the isolated diagnostic bound it to `globalThis`. The
  full smoke now uses the same bound native-fetch reference to remove that
  harness difference. This parity adjustment is not proven to be the cause of
  the anomalous response.
- If User A's create response is uncertain, the final smoke now captures the
  SDK error, performs one exact-email reconciliation for cleanup, and stops
  before signing in, creating User B, or running ownership/quota checks.
- Deterministic local tests exercise response identity/body availability,
  successful SDK parsing with instrumentation, Node-fetch-style decoded gzip
  responses, malformed JSON, network failure, and abort behavior. No remote
  Auth request is used by these tests.

## Remaining uncertainty

The final bounded live run captured the response metadata without retaining the
Auth body:

- HTTP 200 reached the smoke fetch wrapper in 1,293 ms; no timeout or abort.
- The wrapper received 385 bytes with the gzip signature. Its bounded in-memory
  decode produced 1,016 bytes of valid JSON.
- `Content-Type`, `Content-Encoding`, and `Content-Length` were absent, as were
  the whitelisted origin headers (`server`, `via`, Cloudflare/Kong/Supabase
  request markers).
- The SDK reported `AuthRetryableFetchError` status 0, classified as a response
  body parse failure.

This establishes why the SDK failed: it received gzip bytes without a
`Content-Encoding` header, so `Response.json()` attempted to parse the compressed
bytes rather than JSON. The wrapper observed those bytes before returning the
same response object; its clone/read path is not the source of the corruption.
The missing metadata is present at the Node Fetch `Response` boundary. The
available headers do not identify whether Supabase Auth emitted the malformed
response or an intermediary stripped the headers, so attribution beyond that
boundary remains unresolved.

The E2E stopped at User A; no User B, ownership, or quota checks ran. The
harness's cleanup flag remained false, so the one exact User A fixture was
deleted separately and verified absent by Auth Admin and a timestamp-scoped
database check (zero matching users and sessions). No second create request was
made.
