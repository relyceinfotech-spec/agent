import { z } from "zod";
import { config } from "./config.js";
import type { UserQuotaKey } from "./store.js";

const quotaKeys = ["research", "deep_research", "followup"] as const;
const quotaDefinitionSchema = z.object({
  limit: z.number().int().positive().max(10000),
  windowSeconds: z.number().int().min(60).max(604800),
});
const planSchema = z.object({
  enabled: z.boolean().default(true),
  quotas: z.record(z.enum(quotaKeys), quotaDefinitionSchema),
  features: z.record(z.string(), z.boolean()).default({}),
  billingMetadata: z.record(z.string(), z.unknown()).optional(),
});

export interface QuotaDefinition {
  limit: number;
  windowSeconds: number;
}

export interface QuotaPlan {
  id: string;
  enabled: boolean;
  quotas: Record<UserQuotaKey, QuotaDefinition>;
  features: Record<string, boolean>;
  billingMetadata?: Record<string, unknown>;
}

const defaults: Record<UserQuotaKey, QuotaDefinition> = {
  research: {
    limit: config.MAX_USER_RESEARCH_PER_WINDOW,
    windowSeconds: config.USER_QUOTA_WINDOW_SECONDS,
  },
  deep_research: {
    limit: config.MAX_USER_DEEP_RESEARCH_PER_WINDOW,
    windowSeconds: config.USER_QUOTA_WINDOW_SECONDS,
  },
  followup: {
    limit: config.MAX_USER_FOLLOWUPS_PER_WINDOW,
    windowSeconds: config.USER_QUOTA_WINDOW_SECONDS,
  },
};

function parsePlanMap(raw: string): Record<string, QuotaPlan> {
  if (!raw.trim()) {
    return {};
  }

  const rawPlans = JSON.parse(raw) as Record<string, unknown>;
  const plans: Record<string, QuotaPlan> = {};
  for (const [id, rawPlan] of Object.entries(rawPlans)) {
    const plan = planSchema.parse(rawPlan);
    const quotas = { ...defaults, ...plan.quotas };
    plans[id] = { id, ...plan, quotas };
  }
  if (Object.keys(plans).length === 0) throw new Error("At least one quota plan is required");
  return plans;
}

function parseOverrides(raw: string, plans: Record<string, QuotaPlan>): Record<string, string> {
  if (!raw.trim()) return {};
  const overrides = JSON.parse(raw) as Record<string, unknown>;
  for (const [userId, planId] of Object.entries(overrides)) {
    if (typeof planId !== "string" || !plans[planId]) {
      throw new Error(`Invalid quota plan override for user ${userId}`);
    }
  }
  return overrides as Record<string, string>;
}

export class QuotaPolicy {
  private readonly plans: Record<string, QuotaPlan>;
  private readonly userPlanOverrides: Record<string, string>;

  constructor(
    plansJson = config.MAX_QUOTA_PLANS_JSON,
    overridesJson = config.MAX_USER_PLAN_OVERRIDES_JSON,
  ) {
    this.plans = {
      [config.MAX_DEFAULT_QUOTA_PLAN]: {
        id: config.MAX_DEFAULT_QUOTA_PLAN,
        enabled: true,
        quotas: defaults,
        features: { research: true, deepResearch: true, postFollowUps: true },
      },
      ...parsePlanMap(plansJson),
    };
    this.userPlanOverrides = parseOverrides(overridesJson, this.plans);
  }

  forUser(userId: string): QuotaPlan {
    const planId = this.userPlanOverrides[userId] ?? config.MAX_DEFAULT_QUOTA_PLAN;
    const plan = this.plans[planId];
    if (!plan) throw new Error(`Unknown quota plan: ${planId}`);
    return plan;
  }

  forPlan(planId: string): QuotaPlan | undefined {
    const plan = this.plans[planId];
    return plan ? structuredClone(plan) : undefined;
  }

  definition(userId: string, quotaKey: UserQuotaKey): QuotaDefinition | undefined {
    const plan = this.forUser(userId);
    const featureKey = {
      research: "research",
      deep_research: "deepResearch",
      followup: "postFollowUps",
    }[quotaKey];
    if (!plan.enabled || plan.features[featureKey] === false) return undefined;
    return plan.quotas[quotaKey];
  }

  snapshot(): QuotaPlan[] {
    return Object.values(this.plans).map((plan) => structuredClone(plan));
  }
}
