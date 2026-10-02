import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingPlan, BillingSubscriptionSnapshot } from "../src/billing-domain.js";
import { BillingSignatureError } from "../src/billing.js";
import { builtInBillingPlans, InMemoryBillingRepository } from "../src/billing-store.js";
import { InMemoryDurableJobStore } from "../src/jobs.js";
import { QuotaPolicy } from "../src/quota-policy.js";
import { createServer } from "../src/server.js";
import { SqliteSessionStore } from "../src/store.js";

const servers: Array<Awaited<ReturnType<typeof createServer>>> = [];
let providerCalls = 0;

function proPlan(): BillingPlan {
  return {
    ...builtInBillingPlans()[1]!,
    active: true,
    billingInterval: "month",
    priceMinor: 1200,
    currency: "USD",
    limits: { research: 3, deep_research: 2, followup: 4, activeMemories: 25 },
    features: { research: true, deepResearch: true, postFollowUps: true, postAgent: true },
  };
}

function testPolicy() {
  return new QuotaPolicy(
    JSON.stringify({
      default: {
        enabled: true,
        quotas: {
          research: { limit: 1, windowSeconds: 86400 },
          deep_research: { limit: 1, windowSeconds: 86400 },
          followup: { limit: 1, windowSeconds: 86400 },
        },
        features: { research: true, deepResearch: true, postFollowUps: true },
      },
    }),
  );
}

async function makeServer(options: { provider?: boolean } = {}) {
  const store = new SqliteSessionStore(":memory:");
  const jobStore = new InMemoryDurableJobStore();
  const repository = new InMemoryBillingRepository();
  const free = builtInBillingPlans()[0]!;
  repository.setPlan({ ...free, limits: { research: 1, deep_research: 1, followup: 1 } });
  repository.setPlan(proPlan());
  repository.setSubscription({
    id: "sub-a",
    ownerId: "user-a",
    planId: "pro",
    status: "active",
    provider: "testpay",
    externalCustomerId: "customer-a",
    externalSubscriptionId: "external-sub-a",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2027-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    lastEventAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const app = await createServer({
    store,
    billingRepository: repository,
    jobStore,
    quotaPolicy: testPolicy(),
    authVerifier: {
      verifyAccessToken: async (token) => {
        if (token === "a-token") return { id: "user-a", email: "a@example.test" };
        if (token === "b-token") return { id: "user-b", email: "b@example.test" };
        return undefined;
      },
    },
    searchProvider: {
      search: async () => {
        providerCalls += 1;
        return [];
      },
    },
    llmProvider: {
      enabled: true,
      complete: async () => {
        providerCalls += 1;
        throw new Error("No model calls expected in billing tests");
      },
    } as never,
    billingProviders: options.provider
      ? [
          {
            id: "testpay",
            createCustomer: async () => ({ externalCustomerId: "customer-a" }),
            createCheckoutSession: async () => ({
              sessionId: "unused",
              url: "https://example.test",
            }),
            retrieveSubscription: async () => ({
              externalCustomerId: "customer-a",
              externalSubscriptionId: "external-sub-a",
              planId: "pro",
              status: "active",
              currentPeriodStart: null,
              currentPeriodEnd: null,
              cancelAtPeriodEnd: false,
            }),
            cancelSubscription: async () => undefined,
            resumeSubscription: async () => undefined,
            verifyWebhook: async (rawBody: Uint8Array, signature: string) => {
              if (signature !== "test-signature") throw new BillingSignatureError();
              return JSON.parse(new TextDecoder().decode(rawBody));
            },
          },
        ]
      : [],
  });
  servers.push(app);
  return { app, store, repository, jobStore };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

afterEach(async () => {
  providerCalls = 0;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("billing HTTP contract and plan-derived quota", () => {
  it("returns only safe plan fields and keeps metadata private", async () => {
    const { app } = await makeServer();
    const response = await app.inject({ method: "GET", url: "/api/plans" });
    const body = response.json() as { plans: Array<Record<string, unknown>> };

    expect(response.statusCode).toBe(200);
    expect(body.plans.map((item) => item.id)).toEqual(["free", "pro"]);
    expect(body.plans.find((item) => item.id === "pro")?.active).toBe(true);
    expect(body.plans[0]).not.toHaveProperty("metadata");
    expect(JSON.stringify(body)).not.toContain("externalCustomerId");
  });

  it("requires verified authentication and derives the account from the token, not query input", async () => {
    const { app } = await makeServer();
    const missing = await app.inject({ method: "GET", url: "/api/billing/me" });
    const userA = await app.inject({
      method: "GET",
      url: "/api/billing/me?planId=free&userId=user-b",
      headers: bearer("a-token"),
    });
    const userB = await app.inject({
      method: "GET",
      url: "/api/billing/me?planId=pro",
      headers: bearer("b-token"),
    });

    expect(missing.statusCode).toBe(401);
    expect(userA.statusCode).toBe(200);
    expect(userA.json().plan.id).toBe("pro");
    expect(userA.body).not.toContain("external-sub-a");
    expect(userA.body).not.toContain("customer-a");
    expect(userB.statusCode).toBe(200);
    expect(userB.json().plan.id).toBe("free");
  });

  it("does not expose a user-controlled subscription or plan mutation route", async () => {
    const { app } = await makeServer();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/billing/me",
      headers: bearer("b-token"),
      payload: { planId: "pro", status: "active", externalSubscriptionId: "spoofed" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("uses plan limits with the existing per-user quota ledger before any provider call", async () => {
    const { app, jobStore } = await makeServer();
    await jobStore.enqueueJob({
      id: "quota-seed-user-b",
      kind: "research",
      ownerId: "user-b",
      ownerScope: "user:user-b",
      payload: { question: "Existing research", mode: "quick" },
      maxAttempts: 3,
      quota: { ownerId: "user-b", key: "research", windowSeconds: 86400, limit: 1 },
    });
    const spoofedFreeToPro = await app.inject({
      method: "POST",
      url: "/api/research",
      headers: bearer("b-token"),
      payload: {
        question: "Compare two database indexing strategies",
        mode: "quick",
        planId: "pro",
        userId: "user-a",
      },
    });
    const proUser = await app.inject({
      method: "POST",
      url: "/api/research",
      headers: bearer("a-token"),
      payload: { question: "Compare two database indexing strategies", mode: "quick" },
    });

    expect(spoofedFreeToPro.statusCode).toBe(429);
    expect(spoofedFreeToPro.json().limit).toBe(1);
    expect(proUser.statusCode).toBe(202);
    expect(providerCalls).toBe(0);
  });

  it("preserves raw webhook bytes, verifies the signature before persistence, and returns an idempotent result", async () => {
    const { app, repository } = await makeServer({ provider: true });
    await repository.saveCustomerAccount({
      ownerId: "user-a",
      provider: "testpay",
      externalCustomerId: "customer-a",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const sub: BillingSubscriptionSnapshot = {
      externalCustomerId: "customer-a",
      externalSubscriptionId: "external-sub-a",
      planId: "pro",
      status: "active",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
    const raw = JSON.stringify({
      provider: "testpay",
      eventId: "hook-1",
      eventType: "subscription.snapshot",
      occurredAt: new Date().toISOString(),
      subscription: sub,
    });
    const badSignature = await app.inject({
      method: "POST",
      url: "/api/billing/webhooks/testpay",
      headers: { "content-type": "application/json", "x-billing-signature": "wrong" },
      payload: raw,
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/billing/webhooks/testpay",
      headers: { "content-type": "application/json", "x-billing-signature": "test-signature" },
      payload: raw,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/billing/webhooks/testpay",
      headers: { "content-type": "application/json", "x-billing-signature": "test-signature" },
      payload: raw,
    });

    expect(badSignature.statusCode).toBe(401);
    expect(first.statusCode).toBe(200);
    expect(first.json().disposition).toBe("applied");
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().disposition).toBe("duplicate");
    expect((await repository.getSubscriptionForUser("user-a"))?.planId).toBe("pro");
  });
});
