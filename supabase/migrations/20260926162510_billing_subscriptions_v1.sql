-- Provider-neutral plans and subscription state for MAX.
-- Quota usage remains in research.max_user_quota_windows.
create schema if not exists billing;

create table billing.plans (
  id text primary key check (id ~ '^[a-z][a-z0-9_-]{0,39}$'),
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  is_active boolean not null default false,
  billing_interval text check (billing_interval in ('month', 'year')),
  price_minor bigint check (price_minor is null or price_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  limits jsonb not null default '{}'::jsonb check (jsonb_typeof(limits) = 'object'),
  features jsonb not null default '{}'::jsonb check (jsonb_typeof(features) = 'object'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (price_minor is null and currency is null and billing_interval is null)
    or (price_minor = 0 and billing_interval is null)
    or (price_minor > 0 and currency is not null and billing_interval is not null)
  )
);

create table billing.customer_accounts (
  owner_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  external_customer_id text not null check (length(external_customer_id) between 1 and 255),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider),
  unique (provider, external_customer_id)
);

create table billing.subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  plan_id text not null references billing.plans (id) on delete restrict,
  status text not null check (status in (
    'incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'expired'
  )),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  external_customer_id text not null check (length(external_customer_id) between 1 and 255),
  external_subscription_id text not null check (length(external_subscription_id) between 1 and 255),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_event_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_subscription_id),
  check (
    current_period_start is null
    or current_period_end is null
    or current_period_end >= current_period_start
  )
);

create index subscriptions_owner_updated_idx
  on billing.subscriptions (owner_id, updated_at desc);
create index subscriptions_plan_id_idx on billing.subscriptions (plan_id);

create table billing.webhook_events (
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  event_id text not null check (length(event_id) between 1 and 255),
  event_type text not null check (length(event_type) between 1 and 120),
  occurred_at timestamptz not null,
  disposition text not null check (disposition in (
    'processing', 'applied', 'duplicate', 'ignored_unknown', 'ignored_stale', 'ignored_unmatched'
  )),
  processed_at timestamptz not null default now(),
  primary key (provider, event_id)
);

alter table billing.plans enable row level security;
alter table billing.customer_accounts enable row level security;
alter table billing.subscriptions enable row level security;
alter table billing.webhook_events enable row level security;

revoke all on schema billing from public, anon, authenticated;
grant usage on schema billing to authenticated, service_role;

revoke all on all tables in schema billing from public, anon, authenticated;
grant select (
  id, display_name, is_active, billing_interval, price_minor, currency,
  limits, features, created_at, updated_at
) on billing.plans to authenticated;
grant select (
  id, owner_id, plan_id, status, current_period_start, current_period_end,
  cancel_at_period_end, last_event_at, created_at, updated_at
) on billing.subscriptions to authenticated;
grant select, insert, update, delete on all tables in schema billing to service_role;

create policy "authenticated users read active plans"
  on billing.plans
  for select
  to authenticated
  using (is_active);

create policy "users read their own subscription summary"
  on billing.subscriptions
  for select
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  );

-- Persist event IDs and apply normalized subscription snapshots atomically.
create or replace function billing.max_apply_subscription_event(p_event jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_provider text := p_event ->> 'provider';
  v_event_id text := p_event ->> 'eventId';
  v_event_type text := p_event ->> 'eventType';
  v_occurred_at timestamptz;
  v_disposition text;
  v_inserted_event_id text;
  v_snapshot jsonb := p_event -> 'subscription';
  v_owner_id uuid;
  v_existing_owner_id uuid;
  v_customer_owner_id uuid;
  v_existing_customer_id text;
  v_existing_event_at timestamptz;
  v_saved_subscription_id uuid;
  v_status text;
  v_plan_id text;
  v_external_customer_id text;
  v_external_subscription_id text;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_cancel_at_period_end boolean;
begin
  if v_provider is null or v_provider !~ '^[a-z][a-z0-9_-]{0,39}$'
     or v_event_id is null or length(v_event_id) not between 1 and 255
     or v_event_type is null or length(v_event_type) not between 1 and 120
     or nullif(p_event ->> 'occurredAt', '') is null then
    raise exception 'Invalid normalized billing event';
  end if;
  v_occurred_at := (p_event ->> 'occurredAt')::timestamptz;

  insert into billing.webhook_events (
    provider, event_id, event_type, occurred_at, disposition
  ) values (
    v_provider, v_event_id, v_event_type, v_occurred_at, 'processing'
  )
  on conflict (provider, event_id) do nothing
  returning event_id into v_inserted_event_id;

  if v_inserted_event_id is null then
    return jsonb_build_object('disposition', 'duplicate');
  end if;

  if v_event_type <> 'subscription.snapshot' or jsonb_typeof(v_snapshot) <> 'object' then
    v_disposition := 'ignored_unknown';
  else
    v_status := v_snapshot ->> 'status';
    v_plan_id := v_snapshot ->> 'planId';
    v_external_customer_id := v_snapshot ->> 'externalCustomerId';
    v_external_subscription_id := v_snapshot ->> 'externalSubscriptionId';
    v_cancel_at_period_end := coalesce((v_snapshot ->> 'cancelAtPeriodEnd')::boolean, false);

    if v_status not in (
      'incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'expired'
    ) or v_plan_id is null
       or v_external_customer_id is null or length(v_external_customer_id) not between 1 and 255
       or v_external_subscription_id is null or length(v_external_subscription_id) not between 1 and 255 then
      raise exception 'Invalid normalized subscription snapshot';
    end if;
    v_period_start := nullif(v_snapshot ->> 'currentPeriodStart', '')::timestamptz;
    v_period_end := nullif(v_snapshot ->> 'currentPeriodEnd', '')::timestamptz;
    if v_period_start is not null and v_period_end is not null and v_period_end < v_period_start then
      raise exception 'Invalid subscription period';
    end if;

    select s.owner_id, s.external_customer_id, s.last_event_at
      into v_existing_owner_id, v_existing_customer_id, v_existing_event_at
      from billing.subscriptions as s
     where s.provider = v_provider
       and s.external_subscription_id = v_external_subscription_id
     for update;

    select c.owner_id
      into v_customer_owner_id
      from billing.customer_accounts as c
     where c.provider = v_provider
       and c.external_customer_id = v_external_customer_id
     for share;

    v_owner_id := coalesce(v_existing_owner_id, v_customer_owner_id);
    if v_owner_id is null
       or (v_customer_owner_id is not null and v_customer_owner_id <> v_owner_id)
       or (v_existing_customer_id is not null and v_existing_customer_id <> v_external_customer_id)
       or not exists (select 1 from billing.plans as p where p.id = v_plan_id) then
      v_disposition := 'ignored_unmatched';
    elsif v_existing_event_at is not null and v_existing_event_at >= v_occurred_at then
      v_disposition := 'ignored_stale';
    else
      insert into billing.subscriptions (
        owner_id, plan_id, status, provider, external_customer_id,
        external_subscription_id, current_period_start, current_period_end,
        cancel_at_period_end, last_event_at
      ) values (
        v_owner_id, v_plan_id, v_status, v_provider, v_external_customer_id,
        v_external_subscription_id, v_period_start, v_period_end,
        v_cancel_at_period_end, v_occurred_at
      )
      on conflict (provider, external_subscription_id) do update set
        plan_id = excluded.plan_id,
        status = excluded.status,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        last_event_at = excluded.last_event_at,
        updated_at = now()
      where billing.subscriptions.owner_id = excluded.owner_id
        and billing.subscriptions.external_customer_id = excluded.external_customer_id
        and billing.subscriptions.last_event_at < excluded.last_event_at
      returning id into v_saved_subscription_id;

      if v_saved_subscription_id is null then
        select s.owner_id, s.external_customer_id, s.last_event_at
          into v_existing_owner_id, v_existing_customer_id, v_existing_event_at
          from billing.subscriptions as s
         where s.provider = v_provider
           and s.external_subscription_id = v_external_subscription_id;
        if v_existing_owner_id is distinct from v_owner_id
           or v_existing_customer_id is distinct from v_external_customer_id then
          v_disposition := 'ignored_unmatched';
        else
          v_disposition := 'ignored_stale';
        end if;
      else
        v_disposition := 'applied';
      end if;
    end if;
  end if;

  update billing.webhook_events
     set disposition = v_disposition,
         processed_at = now()
   where provider = v_provider and event_id = v_event_id;

  return jsonb_build_object('disposition', v_disposition);
end;
$$;

revoke all on function billing.max_apply_subscription_event(jsonb) from public, anon, authenticated;
grant execute on function billing.max_apply_subscription_event(jsonb) to service_role;

insert into billing.plans (
  id, display_name, is_active, billing_interval, price_minor, currency, limits, features, metadata
) values
  (
    'free', 'Free', true, null, 0, null, '{}'::jsonb,
    '{"research":true,"deepResearch":true,"postFollowUps":true}'::jsonb,
    '{"configurationStatus":"uses_existing_quota_configuration"}'::jsonb
  ),
  (
    'pro', 'Pro', false, null, null, null, '{}'::jsonb, '{}'::jsonb,
    '{"configurationStatus":"pricing_and_entitlements_tbd"}'::jsonb
  )
on conflict (id) do nothing;

alter default privileges for role postgres in schema billing
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema billing
  revoke execute on routines from public, anon, authenticated;

alter role authenticator set pgrst.db_schemas = 'public,graphql_public,research,content,billing';
notify pgrst, 'reload config';
