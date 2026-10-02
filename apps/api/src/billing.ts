import { config } from "./config.js";
import { QuotaPolicy, type QuotaDefinition, type QuotaPlan } from "./quota-policy.js";
import type { UserQuotaKey } from "./store.js";
import type {
  BillingCustomerAccount,
  BillingLimitKey,
  BillingPlan,
  BillingProvider,
  BillingQuotaUsage,
  BillingRepository,
  BillingSubscription,
  BillingUsageReader,
  BillingWebhookDisposition,
  BillingWebhookEvent,
} from "./billing-domain.js";

const quotaFeature: Record<UserQuotaKey, string> = {
  research: "research",
  deep_research: "deepResearch",
  followup: "postFollowUps",
};

const subscriptionEntitlingStatuses = new Set(["active", "trialing"]);
const quotaKeys: UserQuotaKey[] = ["research", "deep_research", "followup"];

export class BillingProviderNotConfiguredError extends Error {
  constructor(provider?: string) {
    super(
      provider
        ? `Billing provider is not configured: ${provider}`
        : "Billing provider is unavailable",
    );
    this.name = "BillingProviderNotConfiguredError";
  }
}

export class BillingSignatureError extends Error {
  constructor() {
    super("Billing webhook signature is invalid");
    this.name = "BillingSignatureError";
  }
}

export class BillingWebhookVerificationError extends Error {
  constructor() {
    super("Billing webhook verification is unavailable");
    this.name = "BillingWebhookVerificationError";
  }
}

export class BillingWebhookValidationError extends Error {
  constructor() {
    super("Billing webhook event is invalid");
    this.name = "BillingWebhookValidationError";
  }
}

export class BillingPlanUnavailableError extends Error {
  constructor() {
    super("The selected plan is not available for checkout");
    this.name = "BillingPlanUnavailableError";
  }
}

export interface EffectiveEntitlements {
  plan: BillingPlan;
  enabled: boolean;
  limits: Partial<Record<UserQuotaKey, QuotaDefinition>>;
  features: Record<string, boolean>;
  subscription?: BillingSubscription;
}

export interface BillingAccountSummary {
  plan: ReturnType<typeof safePlan>;
  subscription: null | {
    status: BillingSubscription["status"];
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  };
  entitlements: Record<string, boolean>;
  limits: Partial<Record<BillingLimitKey, number>>;
  usage: Partial<Record<UserQuotaKey, BillingQuotaUsage & { limit: number; remaining: number }>>;
}

function safePlan(plan: BillingPlan) {
  return {
    id: plan.id,
    displayName: plan.displayName,
    active: plan.active,
    billingInterval: plan.billingInterval,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    limits: { ...plan.limits },
    features: { ...plan.features },
  };
}

function limitsFromQuotaPlan(plan: QuotaPlan): Partial<Record<UserQuotaKey, number>> {
  return Object.fromEntries(
    Object.entries(plan.quotas).map(([key, definition]) => [key, definition.limit]),
  ) as Partial<Record<UserQuotaKey, number>>;
}

function isEffectiveSubscription(subscription: BillingSubscription, nowMs: number): boolean {
  if (!subscriptionEntitlingStatuses.has(subscription.status)) return false;
  if (!subscription.currentPeriodEnd) return true;
  const end = Date.parse(subscription.currentPeriodEnd);
  return Number.isFinite(end) && end > nowMs;
}

function validIdempotencyKey(value: string): boolean {
  return value.trim().length > 0 && value.length <= 128;
}

function validateReturnUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BillingWebhookValidationError();
  }
  const localHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new BillingWebhookValidationError();
  }
  return parsed.toString();
}

export class BillingService {
  private readonly providers = new Map<string, BillingProvider>();

  constructor(
    private readonly repository: BillingRepository,
    private readonly fallbackQuotaPolicy = new QuotaPolicy(),
    providers: BillingProvider[] = [],
    private readonly usageReader?: BillingUsageReader,
    private readonly clock: () => Date = () => new Date(),
  ) {
    for (const provider of providers) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(provider.id)) {
        throw new Error("Billing provider IDs must be stable lowercase identifiers");
      }
      if (this.providers.has(provider.id)) throw new Error("Duplicate billing provider ID");
      this.providers.set(provider.id, provider);
    }
  }

  async listPlans() {
    const rows = await this.repository.listPlans();
    const defaultPlan = this.fallbackQuotaPolicy.forUser("billing-plan-catalog-default");
    return rows
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((plan) => {
        const configured = this.fallbackQuotaPolicy.forPlan(plan.id);
        const isFree = plan.id === "free";
        return safePlan({
          ...plan,
          limits: {
            ...(isFree ? limitsFromQuotaPlan(defaultPlan) : {}),
            ...(configured ? limitsFromQuotaPlan(configured) : {}),
            ...plan.limits,
          },
          features: {
            ...(isFree ? defaultPlan.features : {}),
            ...(configured?.features ?? {}),
            ...plan.features,
          },
        });
      });
  }

  async getEffectiveEntitlements(userId: string): Promise<EffectiveEntitlements> {
    const now = this.clock();
    const storedSubscription = await this.repository.getSubscriptionForUser(userId, now.getTime());
    const activeSubscription =
      storedSubscription && isEffectiveSubscription(storedSubscription, now.getTime())
        ? storedSubscription
        : undefined;
    const configuredForUser = this.fallbackQuotaPolicy.forUser(userId);
    const hasExplicitStaticPlan =
      configuredForUser.id !== config.MAX_DEFAULT_QUOTA_PLAN && configuredForUser.id !== "free";
    const planId = activeSubscription
      ? activeSubscription.planId
      : hasExplicitStaticPlan
        ? configuredForUser.id
        : "free";

    const storedPlan = await this.repository.getPlan(planId);
    const configuredPlan = this.fallbackQuotaPolicy.forPlan(planId);
    const fallbackFreePlan = await this.repository.getPlan("free");
    const plan =
      (!activeSubscription && hasExplicitStaticPlan && configuredPlan
        ? this.staticPlanRecord(configuredPlan)
        : storedPlan) ??
      (configuredPlan
        ? this.staticPlanRecord(configuredPlan)
        : (fallbackFreePlan ?? this.staticPlanRecord(configuredForUser, "free", "Free")));

    const staticLimits = configuredPlan
      ? limitsFromQuotaPlan(configuredPlan)
      : plan.id === "free"
        ? limitsFromQuotaPlan(configuredForUser)
        : {};
    const limits = { ...staticLimits, ...plan.limits };
    const staticFeatures =
      configuredPlan?.features ?? (plan.id === "free" ? configuredForUser.features : {});
    const features = { ...staticFeatures, ...plan.features };
    const enabled = activeSubscription
      ? (configuredPlan?.enabled ?? true)
      : hasExplicitStaticPlan && configuredPlan
        ? configuredPlan.enabled
        : plan.id === "free"
          ? configuredForUser.enabled && plan.active
          : plan.active;
    const definitions: Partial<Record<UserQuotaKey, QuotaDefinition>> = {};
    for (const key of quotaKeys) {
      const limit = limits[key];
      if (limit === undefined) continue;
      if (!Number.isSafeInteger(limit) || !limit || limit < 1) continue;
      const configuredWindow = configuredPlan?.quotas[key]?.windowSeconds;
      const freeWindow =
        plan.id === "free" ? configuredForUser.quotas[key]?.windowSeconds : undefined;
      definitions[key] = {
        limit,
        // Keep the existing fixed-window semantics stable across subscription changes.
        windowSeconds: freeWindow ?? configuredWindow ?? config.USER_QUOTA_WINDOW_SECONDS,
      };
    }

    return {
      plan: { ...plan, limits, features },
      enabled,
      limits: definitions,
      features,
      subscription: storedSubscription,
    };
  }

  async definition(userId: string, quotaKey: UserQuotaKey): Promise<QuotaDefinition | undefined> {
    const effective = await this.getEffectiveEntitlements(userId);
    if (!effective.enabled || effective.features[quotaFeature[quotaKey]] === false)
      return undefined;
    return effective.limits[quotaKey];
  }

  async accountSummary(userId: string): Promise<BillingAccountSummary> {
    const effective = await this.getEffectiveEntitlements(userId);
    const usage: BillingAccountSummary["usage"] = {};
    for (const [key, definition] of Object.entries(effective.limits) as Array<
      [UserQuotaKey, QuotaDefinition]
    >) {
      const current = this.usageReader
        ? await this.usageReader.getUserQuotaUsage(userId, key, definition.windowSeconds)
        : this.zeroUsage(definition.windowSeconds);
      usage[key] = {
        ...current,
        limit: definition.limit,
        remaining: Math.max(0, definition.limit - current.used),
      };
    }

    return {
      plan: safePlan(effective.plan),
      subscription: effective.subscription
        ? {
            status: effective.subscription.status,
            currentPeriodStart: effective.subscription.currentPeriodStart,
            currentPeriodEnd: effective.subscription.currentPeriodEnd,
            cancelAtPeriodEnd: effective.subscription.cancelAtPeriodEnd,
          }
        : null,
      entitlements: { ...effective.features },
      limits: { ...effective.plan.limits },
      usage,
    };
  }

  async processWebhook(
    providerId: string,
    rawBody: Uint8Array,
    signature: string | undefined,
  ): Promise<BillingWebhookDisposition> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new BillingProviderNotConfiguredError(providerId);
    if (!signature?.trim()) throw new BillingSignatureError();

    let event: BillingWebhookEvent;
    try {
      event = await provider.verifyWebhook(rawBody, signature);
    } catch (error) {
      if (
        error instanceof BillingSignatureError ||
        error instanceof BillingWebhookValidationError
      ) {
        throw error;
      }
      throw new BillingWebhookVerificationError();
    }
    if (!event || typeof event !== "object") throw new BillingWebhookValidationError();
    const eventId = typeof event.eventId === "string" ? event.eventId.trim() : "";
    const eventType = typeof event.eventType === "string" ? event.eventType.trim() : "";
    const occurredAt = typeof event.occurredAt === "string" ? Date.parse(event.occurredAt) : NaN;
    if (
      event.provider !== provider.id ||
      !eventId ||
      eventId.length > 255 ||
      !eventType ||
      eventType.length > 120 ||
      !Number.isFinite(occurredAt)
    ) {
      throw new BillingWebhookValidationError();
    }

    const normalizedEvent: BillingWebhookEvent = {
      ...event,
      eventId,
      eventType,
      occurredAt: new Date(occurredAt).toISOString(),
    };
    if (normalizedEvent.eventType === "subscription.snapshot") {
      const snapshot: unknown = normalizedEvent.subscription;
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new BillingWebhookValidationError();
      }
      const value = snapshot as Record<string, unknown>;
      const start = value.currentPeriodStart;
      const end = value.currentPeriodEnd;
      const supportedStatuses = [
        "incomplete",
        "trialing",
        "active",
        "past_due",
        "canceled",
        "unpaid",
        "paused",
        "expired",
      ];
      if (
        typeof value.status !== "string" ||
        !supportedStatuses.includes(value.status) ||
        typeof value.planId !== "string" ||
        !/^[a-z][a-z0-9_-]{0,39}$/.test(value.planId) ||
        typeof value.externalCustomerId !== "string" ||
        !value.externalCustomerId.trim() ||
        value.externalCustomerId.length > 255 ||
        typeof value.externalSubscriptionId !== "string" ||
        !value.externalSubscriptionId.trim() ||
        value.externalSubscriptionId.length > 255 ||
        typeof value.cancelAtPeriodEnd !== "boolean" ||
        ![start, end].every(
          (date) =>
            date === null || (typeof date === "string" && Number.isFinite(Date.parse(date))),
        ) ||
        (typeof start === "string" &&
          typeof end === "string" &&
          Date.parse(end) < Date.parse(start))
      ) {
        throw new BillingWebhookValidationError();
      }
    }
    const normalized =
      normalizedEvent.eventType === "subscription.snapshot"
        ? normalizedEvent
        : { ...normalizedEvent, subscription: undefined };
    return this.repository.applyWebhookEvent(normalized);
  }

  async createCheckoutSession(input: {
    ownerId: string;
    email?: string;
    planId: string;
    providerId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }) {
    if (!validIdempotencyKey(input.idempotencyKey)) throw new BillingPlanUnavailableError();
    const successUrl = validateReturnUrl(input.successUrl);
    const cancelUrl = validateReturnUrl(input.cancelUrl);
    const plan = await this.repository.getPlan(input.planId);
    if (
      !plan ||
      !plan.active ||
      plan.id === "free" ||
      plan.priceMinor === null ||
      !plan.currency ||
      !plan.billingInterval
    ) {
      throw new BillingPlanUnavailableError();
    }
    const provider = this.providers.get(input.providerId);
    if (!provider) throw new BillingProviderNotConfiguredError(input.providerId);
    let customer = await this.repository.getCustomerAccount(input.ownerId, provider.id);
    if (!customer) {
      const created = await provider.createCustomer({
        ownerId: input.ownerId,
        email: input.email,
        idempotencyKey: `customer:${provider.id}:${input.ownerId}`,
      });
      if (!created.externalCustomerId) throw new BillingWebhookValidationError();
      const now = this.clock().toISOString();
      const inputAccount: BillingCustomerAccount = {
        ownerId: input.ownerId,
        provider: provider.id,
        externalCustomerId: created.externalCustomerId,
        createdAt: now,
        updatedAt: now,
      };
      customer = await this.repository.saveCustomerAccount(inputAccount);
    }
    return provider.createCheckoutSession({
      ownerId: input.ownerId,
      plan,
      externalCustomerId: customer.externalCustomerId,
      successUrl,
      cancelUrl,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async cancelSubscription(
    ownerId: string,
    input: { cancelAtPeriodEnd: boolean; idempotencyKey: string },
  ): Promise<"requested" | "already_scheduled"> {
    if (!validIdempotencyKey(input.idempotencyKey)) throw new BillingWebhookValidationError();
    const subscription = await this.repository.getSubscriptionForUser(
      ownerId,
      this.clock().getTime(),
    );
    if (!subscription || !isEffectiveSubscription(subscription, this.clock().getTime())) {
      throw new BillingPlanUnavailableError();
    }
    if (subscription.cancelAtPeriodEnd && input.cancelAtPeriodEnd) return "already_scheduled";
    const provider = this.providers.get(subscription.provider);
    if (!provider) throw new BillingProviderNotConfiguredError(subscription.provider);
    await provider.cancelSubscription(subscription.externalSubscriptionId, input);
    return "requested";
  }

  async resumeSubscription(
    ownerId: string,
    input: { idempotencyKey: string },
  ): Promise<"requested" | "not_scheduled"> {
    if (!validIdempotencyKey(input.idempotencyKey)) throw new BillingWebhookValidationError();
    const subscription = await this.repository.getSubscriptionForUser(
      ownerId,
      this.clock().getTime(),
    );
    if (!subscription || !subscription.cancelAtPeriodEnd) return "not_scheduled";
    const provider = this.providers.get(subscription.provider);
    if (!provider) throw new BillingProviderNotConfiguredError(subscription.provider);
    await provider.resumeSubscription(subscription.externalSubscriptionId, input);
    return "requested";
  }

  async retrieveSubscription(ownerId: string) {
    const subscription = await this.repository.getSubscriptionForUser(
      ownerId,
      this.clock().getTime(),
    );
    if (!subscription) return undefined;
    const provider = this.providers.get(subscription.provider);
    if (!provider) throw new BillingProviderNotConfiguredError(subscription.provider);
    return provider.retrieveSubscription(subscription.externalSubscriptionId);
  }

  private staticPlanRecord(plan: QuotaPlan, id = plan.id, displayName = plan.id): BillingPlan {
    const now = this.clock().toISOString();
    return {
      id,
      displayName,
      active: plan.enabled,
      billingInterval: null,
      priceMinor: null,
      currency: null,
      limits: limitsFromQuotaPlan(plan),
      features: { ...plan.features },
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  private zeroUsage(windowSeconds: number): BillingQuotaUsage {
    const nowSeconds = Math.floor(this.clock().getTime() / 1000);
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    return { used: 0, resetsAt: new Date((windowStart + windowSeconds) * 1000).toISOString() };
  }
}
