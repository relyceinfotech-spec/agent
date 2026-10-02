import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { createSupabaseFetch } from "./supabase-store.js";
import type {
  BillingCustomerAccount,
  BillingLimitKey,
  BillingPlan,
  BillingRepository,
  BillingSubscription,
  BillingSubscriptionSnapshot,
  BillingWebhookDisposition,
  BillingWebhookEvent,
} from "./billing-domain.js";
import type { UserQuotaKey } from "./store.js";

type Row = Record<string, unknown>;

const quotaKeys: UserQuotaKey[] = ["research", "deep_research", "followup"];
const billingLimitKeys = new Set<BillingLimitKey>([
  ...quotaKeys,
  "backgroundJobs",
  "activeMemories",
  "postAgentRuns",
]);
const subscriptionStatuses = new Set([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
  "expired",
]);

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function planFromRow(value: unknown): BillingPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Billing persistence returned an invalid plan");
  }
  const row = value as Row;
  const interval = stringOrNull(row.billing_interval);
  if (interval !== null && interval !== "month" && interval !== "year") {
    throw new Error("Billing persistence returned an unsupported billing interval");
  }
  const limits: Partial<Record<BillingLimitKey, number>> = {};
  for (const [key, rawLimit] of Object.entries(jsonObject(row.limits))) {
    if (!billingLimitKeys.has(key as BillingLimitKey)) continue;
    if (!Number.isSafeInteger(rawLimit) || Number(rawLimit) < 1) {
      throw new Error("Billing persistence returned an invalid plan limit");
    }
    limits[key as BillingLimitKey] = Number(rawLimit);
  }
  const features: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(jsonObject(row.features))) {
    if (typeof enabled === "boolean") features[key] = enabled;
  }
  const priceMinor = row.price_minor == null ? null : Number(row.price_minor);
  const currency = stringOrNull(row.currency);
  if (
    (priceMinor !== null && (!Number.isSafeInteger(priceMinor) || priceMinor < 0)) ||
    (currency !== null && !/^[A-Z]{3}$/.test(currency))
  ) {
    throw new Error("Billing persistence returned invalid plan pricing metadata");
  }
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    active: row.is_active === true,
    billingInterval: interval,
    priceMinor,
    currency,
    limits,
    features,
    metadata: jsonObject(row.metadata),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function subscriptionFromRow(value: unknown): BillingSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Billing persistence returned an invalid subscription");
  }
  const row = value as Row;
  const status = String(row.status);
  if (!subscriptionStatuses.has(status)) {
    throw new Error("Billing persistence returned an unsupported subscription status");
  }
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    planId: String(row.plan_id),
    status: status as BillingSubscription["status"],
    provider: String(row.provider),
    externalCustomerId: String(row.external_customer_id),
    externalSubscriptionId: String(row.external_subscription_id),
    currentPeriodStart: stringOrNull(row.current_period_start),
    currentPeriodEnd: stringOrNull(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    lastEventAt: String(row.last_event_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function customerFromRow(value: unknown): BillingCustomerAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Billing persistence returned an invalid customer mapping");
  }
  const row = value as Row;
  return {
    ownerId: String(row.owner_id),
    provider: String(row.provider),
    externalCustomerId: String(row.external_customer_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function raiseIfError(error: { message?: string; code?: string } | null): void {
  if (!error) return;
  const failure = new Error("Billing persistence operation failed") as Error & { code?: string };
  if (error.code) failure.code = error.code;
  throw failure;
}

const PLAN_COLUMNS =
  "id,display_name,is_active,billing_interval,price_minor,currency,limits,features,metadata,created_at,updated_at";

export class SupabaseBillingRepository implements BillingRepository {
  private readonly billing: ReturnType<ReturnType<typeof createClient<any>>["schema"]>;

  constructor(
    url: string,
    secretKey: string,
    injectedClient?: ReturnType<typeof createClient<any>>,
  ) {
    if (!url || !secretKey) {
      throw new Error("Billing persistence requires the backend-only Supabase server key");
    }
    const client =
      injectedClient ??
      createClient<any>(url, secretKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        global: { fetch: createSupabaseFetch() },
      });
    this.billing = client.schema("billing");
  }

  async listPlans(): Promise<BillingPlan[]> {
    const { data, error } = await this.billing
      .from("plans")
      .select(PLAN_COLUMNS)
      .order("id", { ascending: true });
    raiseIfError(error);
    return (data ?? []).map(planFromRow);
  }

  async getPlan(planId: string): Promise<BillingPlan | undefined> {
    const { data, error } = await this.billing
      .from("plans")
      .select(PLAN_COLUMNS)
      .eq("id", planId)
      .maybeSingle();
    raiseIfError(error);
    return data ? planFromRow(data) : undefined;
  }

  async getSubscriptionForUser(ownerId: string): Promise<BillingSubscription | undefined> {
    const { data, error } = await this.billing
      .from("subscriptions")
      .select("*")
      .eq("owner_id", ownerId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    raiseIfError(error);
    return data ? subscriptionFromRow(data) : undefined;
  }

  async getCustomerAccount(
    ownerId: string,
    provider: string,
  ): Promise<BillingCustomerAccount | undefined> {
    const { data, error } = await this.billing
      .from("customer_accounts")
      .select("owner_id,provider,external_customer_id,created_at,updated_at")
      .eq("owner_id", ownerId)
      .eq("provider", provider)
      .maybeSingle();
    raiseIfError(error);
    return data ? customerFromRow(data) : undefined;
  }

  async saveCustomerAccount(account: BillingCustomerAccount): Promise<BillingCustomerAccount> {
    const { data, error } = await this.billing
      .from("customer_accounts")
      .upsert(
        {
          owner_id: account.ownerId,
          provider: account.provider,
          external_customer_id: account.externalCustomerId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "owner_id,provider" },
      )
      .select("owner_id,provider,external_customer_id,created_at,updated_at")
      .single();
    raiseIfError(error);
    return customerFromRow(data);
  }

  async applyWebhookEvent(event: BillingWebhookEvent): Promise<BillingWebhookDisposition> {
    const { data, error } = await this.billing.rpc("max_apply_subscription_event", {
      p_event: event,
    });
    raiseIfError(error);
    const result = (data && typeof data === "object" ? data : {}) as Row;
    const disposition = String(result.disposition) as BillingWebhookDisposition;
    if (
      !["applied", "duplicate", "ignored_unknown", "ignored_stale", "ignored_unmatched"].includes(
        disposition,
      )
    ) {
      throw new Error("Billing persistence returned an invalid webhook disposition");
    }
    return disposition;
  }
}

export function builtInBillingPlans(now = new Date().toISOString()): BillingPlan[] {
  return [
    {
      id: "free",
      displayName: "Free",
      active: true,
      billingInterval: null,
      priceMinor: 0,
      currency: null,
      limits: {},
      features: { research: true, deepResearch: true, postFollowUps: true },
      metadata: { configurationStatus: "uses_existing_quota_configuration" },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "pro",
      displayName: "Pro",
      active: false,
      billingInterval: null,
      priceMinor: null,
      currency: null,
      limits: {},
      features: {},
      metadata: { configurationStatus: "pricing_and_entitlements_tbd" },
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export class InMemoryBillingRepository implements BillingRepository {
  private readonly plans = new Map<string, BillingPlan>();
  private readonly customers = new Map<string, BillingCustomerAccount>();
  private readonly subscriptions = new Map<string, BillingSubscription>();
  private readonly eventDispositions = new Map<string, BillingWebhookDisposition>();

  constructor(plans = builtInBillingPlans()) {
    for (const plan of plans) this.plans.set(plan.id, structuredClone(plan));
  }

  async listPlans(): Promise<BillingPlan[]> {
    return [...this.plans.values()].map((plan) => structuredClone(plan));
  }

  async getPlan(planId: string): Promise<BillingPlan | undefined> {
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan) : undefined;
  }

  async getSubscriptionForUser(ownerId: string): Promise<BillingSubscription | undefined> {
    const subscription = [...this.subscriptions.values()]
      .filter((item) => item.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return subscription ? structuredClone(subscription) : undefined;
  }

  async getCustomerAccount(
    ownerId: string,
    provider: string,
  ): Promise<BillingCustomerAccount | undefined> {
    const account = this.customers.get(`${ownerId}\u0000${provider}`);
    return account ? structuredClone(account) : undefined;
  }

  async saveCustomerAccount(account: BillingCustomerAccount): Promise<BillingCustomerAccount> {
    const key = `${account.ownerId}\u0000${account.provider}`;
    const existingOwner = [...this.customers.values()].find(
      (value) =>
        value.provider === account.provider &&
        value.externalCustomerId === account.externalCustomerId &&
        value.ownerId !== account.ownerId,
    );
    if (existingOwner) throw new Error("Billing customer is already mapped to another account");
    const current = this.customers.get(key);
    const saved = {
      ...account,
      createdAt: current?.createdAt ?? account.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.customers.set(key, structuredClone(saved));
    return structuredClone(saved);
  }

  async applyWebhookEvent(event: BillingWebhookEvent): Promise<BillingWebhookDisposition> {
    const eventKey = `${event.provider}\u0000${event.eventId}`;
    const prior = this.eventDispositions.get(eventKey);
    if (prior) return "duplicate";

    if (event.eventType !== "subscription.snapshot" || !event.subscription) {
      this.eventDispositions.set(eventKey, "ignored_unknown");
      return "ignored_unknown";
    }

    const snapshot: BillingSubscriptionSnapshot = event.subscription;
    const existing = [...this.subscriptions.values()].find(
      (value) =>
        value.provider === event.provider &&
        value.externalSubscriptionId === snapshot.externalSubscriptionId,
    );
    const customer = [...this.customers.values()].find(
      (value) =>
        value.provider === event.provider &&
        value.externalCustomerId === snapshot.externalCustomerId,
    );
    const ownerId = existing?.ownerId ?? customer?.ownerId;
    if (
      !ownerId ||
      (customer && customer.ownerId !== ownerId) ||
      (existing && existing.externalCustomerId !== snapshot.externalCustomerId) ||
      !this.plans.has(snapshot.planId)
    ) {
      this.eventDispositions.set(eventKey, "ignored_unmatched");
      return "ignored_unmatched";
    }
    if (existing && Date.parse(event.occurredAt) <= Date.parse(existing.lastEventAt)) {
      this.eventDispositions.set(eventKey, "ignored_stale");
      return "ignored_stale";
    }

    const now = new Date().toISOString();
    const updated: BillingSubscription = {
      id: existing?.id ?? randomUUID(),
      ownerId,
      planId: snapshot.planId,
      status: snapshot.status,
      provider: event.provider,
      externalCustomerId: snapshot.externalCustomerId,
      externalSubscriptionId: snapshot.externalSubscriptionId,
      currentPeriodStart: snapshot.currentPeriodStart,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      lastEventAt: event.occurredAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.subscriptions.set(`${event.provider}\u0000${snapshot.externalSubscriptionId}`, updated);
    this.eventDispositions.set(eventKey, "applied");
    return "applied";
  }

  setPlan(plan: BillingPlan): void {
    this.plans.set(plan.id, structuredClone(plan));
  }

  setSubscription(subscription: BillingSubscription): void {
    this.subscriptions.set(
      `${subscription.provider}\u0000${subscription.externalSubscriptionId}`,
      structuredClone(subscription),
    );
  }
}
