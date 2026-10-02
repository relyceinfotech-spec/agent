import { describe, expect, it, vi } from "vitest";
import { SupabaseBillingRepository } from "../src/billing-store.js";

type Row = Record<string, unknown>;

class BillingQuery implements PromiseLike<{ data: Row[]; error: null }> {
  private readonly filters: Array<[string, unknown]> = [];
  private maximum = Number.POSITIVE_INFINITY;
  private staged: Row | undefined;

  constructor(
    private readonly rows: Row[],
    private readonly orderState: { column?: string; ascending?: boolean },
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderState.column = column;
    this.orderState.ascending = options?.ascending;
    return this;
  }

  limit(value: number) {
    this.maximum = value;
    return this;
  }

  upsert(value: Row) {
    const conflictColumn = "owner_id";
    const index = this.rows.findIndex(
      (row) => row[conflictColumn] === value[conflictColumn] && row.provider === value.provider,
    );
    if (index < 0) this.rows.push(value);
    else this.rows[index] = { ...this.rows[index], ...value };
    this.staged = this.rows[index < 0 ? this.rows.length - 1 : index];
    return this;
  }

  async maybeSingle() {
    return { data: this.filtered()[0] ?? null, error: null };
  }

  async single() {
    return { data: this.staged ?? this.filtered()[0] ?? null, error: null };
  }

  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?:
      ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.filtered(), error: null }).then(onfulfilled, onrejected);
  }

  private filtered() {
    let result = this.rows.filter((row) =>
      this.filters.every(([column, value]) => row[column] === value),
    );
    if (this.orderState.column) {
      const column = this.orderState.column;
      const direction = this.orderState.ascending === false ? -1 : 1;
      result = [...result].sort(
        (left, right) => direction * String(left[column]).localeCompare(String(right[column])),
      );
    }
    return result.slice(0, this.maximum);
  }
}

function createFakeSupabase() {
  const tables = new Map<string, Row[]>();
  const schema = vi.fn(() => client);
  const rpc = vi.fn(async () => ({ data: { disposition: "applied" }, error: null }));
  const client = {
    schema,
    from(table: string) {
      const rows = tables.get(table) ?? [];
      tables.set(table, rows);
      return new BillingQuery(rows, {});
    },
    rpc,
  };
  return { client, tables, schema, rpc };
}

describe("SupabaseBillingRepository", () => {
  it("uses the billing schema and decodes provider-free plan rows", async () => {
    const fake = createFakeSupabase();
    fake.tables.set("plans", [
      {
        id: "pro",
        display_name: "Pro",
        is_active: false,
        billing_interval: null,
        price_minor: null,
        currency: null,
        limits: { activeMemories: 30, research: 12, ignoredFutureLimit: 999 },
        features: { deepResearch: true },
        metadata: { configurationStatus: "tbd" },
        created_at: "2026-09-26T00:00:00.000Z",
        updated_at: "2026-09-26T00:00:00.000Z",
      },
    ]);
    const repository = new SupabaseBillingRepository(
      "https://example.test",
      "server-key",
      fake.client as never,
    );

    const [row] = await repository.listPlans();
    expect(fake.schema).toHaveBeenCalledWith("billing");
    expect(row).toMatchObject({
      id: "pro",
      active: false,
      priceMinor: null,
      limits: { activeMemories: 30, research: 12 },
      features: { deepResearch: true },
    });
    expect(row?.limits).not.toHaveProperty("ignoredFutureLimit");
  });

  it("owner-filters subscription reads and maps the persisted state", async () => {
    const fake = createFakeSupabase();
    fake.tables.set("subscriptions", [
      {
        id: "row-a",
        owner_id: "user-a",
        plan_id: "pro",
        status: "active",
        provider: "testpay",
        external_customer_id: "customer-a",
        external_subscription_id: "sub-a",
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: true,
        last_event_at: "2026-09-26T12:00:00.000Z",
        created_at: "2026-09-26T12:00:00.000Z",
        updated_at: "2026-09-26T12:00:00.000Z",
      },
      {
        id: "row-b",
        owner_id: "user-b",
        plan_id: "pro",
        status: "active",
        provider: "testpay",
        external_customer_id: "customer-b",
        external_subscription_id: "sub-b",
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        last_event_at: "2026-09-26T12:00:00.000Z",
        created_at: "2026-09-26T12:00:00.000Z",
        updated_at: "2026-09-26T12:00:00.000Z",
      },
    ]);
    const repository = new SupabaseBillingRepository(
      "https://example.test",
      "server-key",
      fake.client as never,
    );

    expect((await repository.getSubscriptionForUser("user-a"))?.externalSubscriptionId).toBe(
      "sub-a",
    );
    expect(await repository.getSubscriptionForUser("user-c")).toBeUndefined();
  });

  it("applies only the normalized webhook RPC and accepts its disposition", async () => {
    const fake = createFakeSupabase();
    const repository = new SupabaseBillingRepository(
      "https://example.test",
      "server-key",
      fake.client as never,
    );
    const input = {
      provider: "testpay",
      eventId: "event-1",
      eventType: "subscription.snapshot",
      occurredAt: "2026-09-26T12:00:00.000Z",
    };

    await expect(repository.applyWebhookEvent(input)).resolves.toBe("applied");
    expect(fake.rpc).toHaveBeenCalledWith("max_apply_subscription_event", { p_event: input });
  });
});
