import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getApiBaseUrl } from "../app/api-url";

describe("getApiBaseUrl", () => {
  it("accepts the development origin supplied by Next config", () => {
    assert.equal(getApiBaseUrl("http://localhost:8000", "development"), "http://localhost:8000");
  });

  it("requires an API origin when configuration is missing", () => {
    assert.throws(() => getApiBaseUrl(undefined, "development"), /is required outside development/);
    assert.throws(() => getApiBaseUrl(undefined, "production"), /is required outside development/);
    assert.throws(() => getApiBaseUrl(undefined, "test"), /is required outside development/);
  });

  it("accepts and normalizes a secure production origin", () => {
    assert.equal(
      getApiBaseUrl(" https://api.example.com/ ", "production"),
      "https://api.example.com",
    );
  });

  it("rejects insecure or loopback production destinations", () => {
    assert.throws(() => getApiBaseUrl("http://api.example.com", "production"), /must use HTTPS/);
    assert.throws(
      () => getApiBaseUrl("https://localhost:8000", "production"),
      /must not target localhost/,
    );
    assert.throws(
      () => getApiBaseUrl("https://127.0.0.1:8000", "production"),
      /must not target localhost/,
    );
    assert.throws(
      () => getApiBaseUrl("https://127.42.0.1:8000", "production"),
      /must not target localhost/,
    );
  });

  it("rejects malformed URLs and URL components that change the API base", () => {
    assert.throws(() => getApiBaseUrl("api.example.com", "production"), /absolute HTTP\(S\) URL/);
    assert.throws(
      () => getApiBaseUrl("https://user:pass@api.example.com", "production"),
      /must not contain credentials/,
    );
    assert.throws(
      () => getApiBaseUrl("https://api.example.com?tenant=other", "production"),
      /must not contain credentials/,
    );
    assert.throws(
      () => getApiBaseUrl("https://api.example.com/path", "production"),
      /must be an origin/,
    );
  });
});
