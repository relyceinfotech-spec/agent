import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BillingPlan,
  BillingProvider,
  BillingSubscription,
  BillingSubscriptionSnapshot,
  BillingWebhookEvent,
} from "../src/billing-domain.js";
import {
  BillingProviderNotConfiguredError,
  BillingService,
  BillingSignatureError,
  BillingWebhookValidationError,
} from "../src/billing.js";
import { builtInBillingPlans, InMemoryBillingRepository } from "../src/billing-store.js";
import { QuotaPolicy } from "../src/quota-policy.js";
import { SqliteSessionStore } from "../src/store.js";

const NOW = "2026-09-26T12:00:00.000Z";

function quotaPolicy(planLimits: Record<string, number>, assignedUser?: string): QuotaPolicy {
  const quotas = {
    research: { limit: planLimits.research ?? 2, windowSeconds: 86400 },
    deep_research: { limit: planLimits.deep_research ?? 1, windowSeconds: 86400 },
    followup: { limit: planLimits.followup ?? 1, windowSeconds: 86400 },
  };
  return new QuotaPolicy(
    JSON.stringify({
      pro: {
        enabled: true,
        quotas,
        features: { research: true, deepResearch: true, postFollowUps: true },
      },
    }),
    assignedUser ? JSON.stringify({ [assignedUser]: "pro" }) : "",
  );
}

function plan(overrides: Partial<BillingPlan> = {}): BillingPlan {
  const base = builtInBillingPlans(NOW)[1]!;
  return {
    ...base,
    active: true,
    billingInterval: "month",
    priceMinor: 1200,
    currency: "USD",
    limits: {
      research: 8,
      deep_research: 3,
      followup: 5,
      backgroundJobs: 8,
      activeMemories: 20,
      postAgentRuns: 2,
    },
    features: { research: true, deepResearch: true, postFollowUps: true, postAgent: true },
    ...overrides,
  };
}

function subscription(
  ownerId: string,
  overrides: Partial<BillingSubscription> = {},
): BillingSubscription {
  return {
    id: `subscription-${ownerId}`,
    ownerId,
    planId: "pro",
    status: "active",
    provider: "testpay",
    externalCustomerId: `customer-${ownerId}`,
    externalSubscriptionId: `external-sub-${ownerId}`,
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2027-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    lastEventAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<BillingSubscriptionSnapshot> = {},
): BillingSubscriptionSnapshot {
  return {
    externalCustomerId: "customer-user-a",
    externalSubscriptionId: "external-sub-user-a",
    planId: "pro",
    status: "active",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2027-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function event(
  eventId: string,
  occurredAt: string,
  value: BillingSubscriptionSnapshot | undefined = snapshot(),
): BillingWebhookEvent {
  return {
    provider: "testpay",
    eventId,
    eventType: value ? "subscription.snapshot" : "invoice.payment_failed",
    occurredAt,
    ...(value ? { subscription: value } : {}),
  };
}

function fakeProvider(overrides: Partial<BillingProvider> = {}): BillingProvider {
  return {
    id: "testpay",
    createCustomer: vi.fn(async ({ ownerId }) => ({ externalCustomerId: `customer-${ownerId}` })),
    createCheckoutSession: vi.fn(async ({ idempotencyKey }) => ({
      sessionId: `checkout-${idempotencyKey}`,
      url: "https://billing.example.test/session",
    })),
    retrieveSubscription: vi.fn(async () => snapshot()),
    cancelSubscription: vi.fn(async () => undefined),
    resumeSubscription: vi.fn(async () => undefined),
    verifyWebhook: vi.fn(async (rawBody, signature) => {
      if (signature !== "valid-test-signature") throw new BillingSignatureError();
      return JSON.parse(new TextDecoder().decode(rawBody)) as BillingWebhookEvent;
    }),
    ...overrides,
  };
}

function repositoryWithPro(): InMemoryBillingRepository {
  const repository = new InMemoryBillingRepository();
  repository.setPlan(plan());
  return repository;
}

describe("provider-neutral billing and entitlements", () => {
  const stores: SqliteSessionStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("keeps Free on the existing configured quota defaults without inventing prices", async () => {
    const service = new BillingService(new InMemoryBillingRepository(), quotaPolicy({}));
    const free = await service.getEffectiveEntitlements("free-user");

    expect(free.plan.id).toBe("free");
    expect(free.plan.priceMinor).toBe(0);
    expect(free.limits.research?.limit).toBeGreaterThan(0);
    expect(free.limits.deep_research?.limit).toBeGreaterThan(0);
  });

  it("keeps Pro inactive and unpriced until business values are configured", async () => {
    const service = new BillingService(new InMemoryBillingRepository(), new QuotaPolicy("", ""));
    const pro = (await service.listPlans()).find((item) => item.id === "pro");

    expect(pro).toMatchObject({
      active: false,
      priceMinor: null,
      currency: null,
      billingInterval: null,
    });
    expect(pro?.limits).toEqual({});
  });

  it("derives Pro limits and feature access from persisted plan and subscription data", async () => {
    const repository = repositoryWithPro();
    repository.setSubscription(subscription("user-a"));
    const service = new BillingService(repository, quotaPolicy({}));

    const entitlements = await service.getEffectiveEntitlements("user-a");
    expect(entitlements.plan.id).toBe("pro");
    expect(entitlements.limits.research?.limit).toBe(8);
    expect(entitlements.limits.deep_research?.limit).toBe(3);
    expect(entitlements.plan.limits.activeMemories).toBe(20);
    expect(entitlements.features.postAgent).toBe(true);
  });

  it("keeps an existing active subscriber entitled when the plan is no longer for new sales", async () => {
    const repository = repositoryWithPro();
    repository.setPlan(plan({ active: false }));
    repository.setSubscription(subscription("user-a"));
    const service = new BillingService(repository, quotaPolicy({}));

    expect((await service.getEffectiveEntitlements("user-a")).enabled).toBe(true);
    expect((await service.definition("user-a", "research"))?.limit).toBe(8);
  });

  it("uses configured plan quotas as a migration-safe fallback for a Pro plan", async () => {
    const repository = new InMemoryBillingRepository();
    repository.setPlan(plan({ limits: {}, features: {} }));
    repository.setSubscription(subscription("user-a"));
    const service = new BillingService(repository, quotaPolicy({ research: 11, deep_research: 4 }));

    expect((await service.definition("user-a", "research"))?.limit).toBe(11);
    expect((await service.definition("user-a", "deep_research"))?.limit).toBe(4);
  });

  it("preserves trusted server-side static plan overrides without consulting client state", async () => {
    const repository = new InMemoryBillingRepository();
    const service = new BillingService(
      repository,
      quotaPolicy({ research: 10 }, "admin-assigned-user"),
    );

    expect((await service.getEffectiveEntitlements("admin-assigned-user")).plan.id).toBe("pro");
    expect((await service.definition("admin-assigned-user", "research"))?.limit).toBe(10);
  });

  it("does not let one user read another user's subscription through the repository", async () => {
    const repository = repositoryWithPro();
    repository.setSubscription(subscription("user-a"));
    const service = new BillingService(repository, quotaPolicy({}));

    expect((await service.getEffectiveEntitlements("user-b")).plan.id).toBe("free");
    expect((await service.getEffectiveEntitlements("user-a")).plan.id).toBe("pro");
  });

  it("applies upgrade and downgrade snapshots without changing usage records", async () => {
    const repository = repositoryWithPro();
    await repository.saveCustomerAccount({
      ownerId: "user-a",
      provider: "testpay",
      externalCustomerId: "customer-user-a",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const provider = fakeProvider({
      verifyWebhook: vi.fn(async (rawBody) => JSON.parse(new TextDecoder().decode(rawBody))),
    });
    const store = new SqliteSessionStore(":memory:");
    stores.push(store);
    await store.consumeUserQuota("user-a", "research", 86400, 4);
    const service = new BillingService(repository, quotaPolicy({}), [provider], {
      getUserQuotaUsage: (userId, key, windowSeconds) =>
        store.getUserQuotaUsage(userId, key, windowSeconds),
    });

    const upgraded = event("upgrade-1", "2026-09-26T12:01:00.000Z");
    expect(
      await service.processWebhook(
        "testpay",
        new TextEncoder().encode(JSON.stringify(upgraded)),
        "sig",
      ),
    ).toBe("applied");
    expect((await service.getEffectiveEntitlements("user-a")).plan.id).toBe("pro");

    const downgraded = event(
      "downgrade-1",
      "2026-09-26T12:02:00.000Z",
      snapshot({ planId: "free" }),
    );
    expect(
      await service.processWebhook(
        "testpay",
        new TextEncoder().encode(JSON.stringify(downgraded)),
        "sig",
      ),
    ).toBe("applied");
    const summary = await service.accountSummary("user-a");
    expect(summary.plan.id).toBe("free");
    expect(summary.usage.research?.used).toBe(1);
  });

  it("falls back to Free for expired, canceled, and past-due subscriptions", async () => {
    const repository = repositoryWithPro();
    repository.setSubscription(
      subscription("expired", { currentPeriodEnd: "2026-09-25T00:00:00.000Z" }),
    );
    repository.setSubscription(subscription("canceled", { status: "canceled" }));
    repository.setSubscription(subscription("past-due", { status: "past_due" }));
    const service = new BillingService(
      repository,
      quotaPolicy({}),
      [],
      undefined,
      () => new Date(NOW),
    );

    for (const userId of ["expired", "canceled", "past-due"]) {
      expect((await service.getEffectiveEntitlements(userId)).plan.id).toBe("free");
    }
    expect((await service.accountSummary("canceled")).subscription?.status).toBe("canceled");
  });

  it("preserves access through a paid period when cancellation is scheduled at period end", async () => {
    const repository = repositoryWithPro();
    repository.setSubscription(subscription("user-a", { cancelAtPeriodEnd: true }));
    const service = new BillingService(
      repository,
      quotaPolicy({}),
      [],
      undefined,
      () => new Date(NOW),
    );
    expect((await service.getEffectiveEntitlements("user-a")).plan.id).toBe("pro");
  });

  it("does not reset historical quota usage when a plan changes", async () => {
    const store = new SqliteSessionStore(":memory:");
    stores.push(store);
    await store.consumeUserQuota("user-a", "research", 86400, 2);
    const repository = repositoryWithPro();
    repository.setSubscription(subscription("user-a"));
    const service = new BillingService(repository, quotaPolicy({}), [], {
      getUserQuotaUsage: (userId, key, windowSeconds) =>
        store.getUserQuotaUsage(userId, key, windowSeconds),
    });

    expect((await service.accountSummary("user-a")).usage.research?.used).toBe(1);
    expect((await store.consumeUserQuota("user-a", "research", 86400, 8)).used).toBe(2);
  });

  it("deduplicates webhooks and ignores stale subscription snapshots", async () => {
    const repository = repositoryWithPro();
    await repository.saveCustomerAccount({
      ownerId: "user-a",
      provider: "testpay",
      externalCustomerId: "customer-user-a",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const service = new BillingService(repository, quotaPolicy({}), [fakeProvider()]);
    const send = (value: BillingWebhookEvent) =>
      service.processWebhook(
        "testpay",
        new TextEncoder().encode(JSON.stringify(value)),
        "valid-test-signature",
      );
    const newest = event("new-event", "2026-09-26T12:03:00.000Z");

    expect(await send(newest)).toBe("applied");
    expect(await send(newest)).toBe("duplicate");
    expect(
      await send(
        event(
          "renewal-event",
          "2026-09-26T12:04:00.000Z",
          snapshot({ currentPeriodEnd: "2026-11-01T00:00:00.000Z" }),
        ),
      ),
    ).toBe("applied");
    expect(
      await send(
        event("payment-failed-event", "2026-09-26T12:05:00.000Z", snapshot({ status: "past_due" })),
      ),
    ).toBe("applied");
    expect(
      await send(event("old-event", "2026-09-26T12:02:00.000Z", snapshot({ status: "canceled" }))),
    ).toBe("ignored_stale");
    expect((await repository.getSubscriptionForUser("user-a"))?.status).toBe("past_due");
  });

  it("records unknown provider event types without changing subscription state", async () => {
    const repository = repositoryWithPro();
    const service = new BillingService(repository, quotaPolicy({}), [fakeProvider()]);
    const unknown: BillingWebhookEvent = {
      provider: "testpay",
      eventId: "invoice-failed-1",
      eventType: "invoice.payment_failed",
      occurredAt: "2026-09-26T12:03:00.000Z",
    };

    expect(
      await service.processWebhook(
        "testpay",
        new TextEncoder().encode(JSON.stringify(unknown)),
        "valid-test-signature",
      ),
    ).toBe("ignored_unknown");
    expect(await repository.getSubscriptionForUser("user-a")).toBeUndefined();
  });

  it("rejects failed signatures and malformed normalized subscription data", async () => {
    const repository = repositoryWithPro();
    const provider = fakeProvider();
    const service = new BillingService(repository, quotaPolicy({}), [provider]);
    const raw = new TextEncoder().encode(JSON.stringify(event("event-1", NOW)));

    await expect(service.processWebhook("testpay", raw, "bad-signature")).rejects.toBeInstanceOf(
      BillingSignatureError,
    );
    const malformedProvider = fakeProvider({
      verifyWebhook: vi.fn(async () => ({
        ...event("event-2", NOW),
        subscription: snapshot({ status: "not-a-real-status" as never }),
      })),
    });
    const malformedService = new BillingService(repository, quotaPolicy({}), [malformedProvider]);
    await expect(
      malformedService.processWebhook("testpay", raw, "valid-test-signature"),
    ).rejects.toBeInstanceOf(BillingWebhookValidationError);
  });

  it("requires an installed provider before processing a webhook", async () => {
    const service = new BillingService(new InMemoryBillingRepository(), quotaPolicy({}));
    await expect(service.processWebhook("stripe", new Uint8Array(), "sig")).rejects.toBeInstanceOf(
      BillingProviderNotConfiguredError,
    );
  });

  it("keeps checkout behind the provider interface and validates return URLs before side effects", async () => {
    const repository = repositoryWithPro();
    const provider = fakeProvider();
    const service = new BillingService(repository, quotaPolicy({}), [provider]);
    await expect(
      service.createCheckoutSession({
        ownerId: "user-a",
        planId: "pro",
        providerId: "testpay",
        successUrl: "https://user:pass@example.test/return",
        cancelUrl: "https://example.test/cancel",
        idempotencyKey: "checkout-1",
      }),
    ).rejects.toBeInstanceOf(BillingWebhookValidationError);
    expect(provider.createCustomer).not.toHaveBeenCalled();

    const result = await service.createCheckoutSession({
      ownerId: "user-a",
      planId: "pro",
      providerId: "testpay",
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel",
      idempotencyKey: "checkout-1",
    });
    expect(result.url).toBe("https://billing.example.test/session");
    expect(provider.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "checkout-1" }),
    );
  });

  it("does not offer checkout for the unconfigured Pro placeholder", async () => {
    const provider = fakeProvider();
    const service = new BillingService(new InMemoryBillingRepository(), quotaPolicy({}), [
      provider,
    ]);

    await expect(
      service.createCheckoutSession({
        ownerId: "user-a",
        planId: "pro",
        providerId: "testpay",
        successUrl: "https://example.test/success",
        cancelUrl: "https://example.test/cancel",
        idempotencyKey: "checkout-1",
      }),
    ).rejects.toThrow("selected plan is not available");
    expect(provider.createCustomer).not.toHaveBeenCalled();
  });

  it("makes repeated scheduled cancellation idempotent", async () => {
    const repository = repositoryWithPro();
    repository.setSubscription(subscription("user-a", { cancelAtPeriodEnd: true }));
    const provider = fakeProvider();
    const service = new BillingService(repository, quotaPolicy({}), [provider]);
    const result = await service.cancelSubscription("user-a", {
      cancelAtPeriodEnd: true,
      idempotencyKey: "cancel-1",
    });

    expect(result).toBe("already_scheduled");
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });
});
