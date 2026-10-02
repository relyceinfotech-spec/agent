import type { UserQuotaKey } from "./store.js";

export type BillingLimitKey = UserQuotaKey | "backgroundJobs" | "activeMemories" | "postAgentRuns";

export type BillingInterval = "month" | "year";

export type BillingSubscriptionStatus =
  "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused" | "expired";

export interface BillingPlan {
  id: string;
  displayName: string;
  active: boolean;
  billingInterval: BillingInterval | null;
  priceMinor: number | null;
  currency: string | null;
  limits: Partial<Record<BillingLimitKey, number>>;
  features: Record<string, boolean>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BillingCustomerAccount {
  ownerId: string;
  provider: string;
  externalCustomerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingSubscription {
  id: string;
  ownerId: string;
  planId: string;
  status: BillingSubscriptionStatus;
  provider: string;
  externalCustomerId: string;
  externalSubscriptionId: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  lastEventAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillingSubscriptionSnapshot {
  externalCustomerId: string;
  externalSubscriptionId: string;
  planId: string;
  status: BillingSubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingWebhookEvent {
  provider: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  subscription?: BillingSubscriptionSnapshot;
}

export type BillingWebhookDisposition =
  "applied" | "duplicate" | "ignored_unknown" | "ignored_stale" | "ignored_unmatched";

export interface BillingRepository {
  listPlans(): Promise<BillingPlan[]>;
  getPlan(planId: string): Promise<BillingPlan | undefined>;
  getSubscriptionForUser(ownerId: string, nowMs?: number): Promise<BillingSubscription | undefined>;
  getCustomerAccount(
    ownerId: string,
    provider: string,
  ): Promise<BillingCustomerAccount | undefined>;
  saveCustomerAccount(account: BillingCustomerAccount): Promise<BillingCustomerAccount>;
  applyWebhookEvent(event: BillingWebhookEvent): Promise<BillingWebhookDisposition>;
}

export interface BillingProvider {
  readonly id: string;
  createCustomer(input: {
    ownerId: string;
    email?: string;
    idempotencyKey: string;
  }): Promise<{ externalCustomerId: string }>;
  createCheckoutSession(input: {
    ownerId: string;
    plan: BillingPlan;
    externalCustomerId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ sessionId: string; url: string; expiresAt?: string }>;
  retrieveSubscription(externalSubscriptionId: string): Promise<BillingSubscriptionSnapshot>;
  cancelSubscription(
    externalSubscriptionId: string,
    input: { cancelAtPeriodEnd: boolean; idempotencyKey: string },
  ): Promise<void>;
  resumeSubscription(
    externalSubscriptionId: string,
    input: { idempotencyKey: string },
  ): Promise<void>;
  verifyWebhook(rawBody: Uint8Array, signature: string): Promise<BillingWebhookEvent>;
}

export interface BillingQuotaUsage {
  used: number;
  resetsAt: string;
}

export interface BillingUsageReader {
  getUserQuotaUsage(
    userId: string,
    quotaKey: UserQuotaKey,
    windowSeconds: number,
  ): Promise<BillingQuotaUsage>;
}
