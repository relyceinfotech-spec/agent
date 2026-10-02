import { describe, expect, it } from "vitest";
import { app } from "../src/server.js";
import { config } from "../src/config.js";

describe("platform HTTP surface", () => {
  it("keeps Post Agent model-role configuration out of public readiness responses", async () => {
    const readiness = await app.inject({ method: "GET", url: "/ready" });
    const publicBody = JSON.stringify(readiness.json());

    expect(readiness.statusCode).toBe(200);
    expect(publicBody).not.toContain("POST_AGENT_");
    expect(publicBody).not.toContain("OPENROUTER_MODEL");
    expect(publicBody).not.toContain("OPENROUTER_API_KEY");
  });

  it("exposes Discover publicly while keeping run history admin-only", async () => {
    const discover = await app.inject({ method: "GET", url: "/api/discover" });
    expect(discover.statusCode).toBe(200);
    expect(discover.json()).toEqual([]);

    const runs = await app.inject({ method: "GET", url: "/api/autonomous/runs" });
    expect([401, 503]).toContain(runs.statusCode);
  });

  it("returns 404 for an unknown post and rejects unauthenticated paid work", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/posts/not-found" });
    expect(missing.statusCode).toBe(404);

    const missingFollowUp = await app.inject({
      method: "POST",
      url: "/api/posts/not-found/ask",
      payload: { question: "What evidence supports this?" },
    });
    expect(missingFollowUp.statusCode).toBe(401);

    const trigger = await app.inject({
      method: "POST",
      url: "/api/autonomous/runs",
      payload: {},
    });
    expect(trigger.statusCode).toBe(config.MAX_ADMIN_TOKEN ? 401 : 503);
  });
});
