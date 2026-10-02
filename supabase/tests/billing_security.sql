-- Read-only catalog assertions for billing RLS and privilege boundaries.
-- Run with a migration-capable database role after the billing migration.
do $$
declare
  subscription_read_policy text;
  plan_read_policy text;
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'billing'
      and c.relname in ('plans', 'customer_accounts', 'subscriptions', 'webhook_events')
      and c.relrowsecurity
    group by n.nspname
    having count(*) = 4
  ) then
    raise exception 'All billing tables must have row-level security enabled';
  end if;

  select qual into plan_read_policy
  from pg_policies
  where schemaname = 'billing'
    and tablename = 'plans'
    and policyname = 'authenticated users read active plans'
    and cmd = 'SELECT';
  if plan_read_policy is null or position('is_active' in plan_read_policy) = 0 then
    raise exception 'Authenticated plan reads must be restricted to active plans';
  end if;

  select qual into subscription_read_policy
  from pg_policies
  where schemaname = 'billing'
    and tablename = 'subscriptions'
    and policyname = 'users read their own subscription summary'
    and cmd = 'SELECT';
  if subscription_read_policy is null
     or position('auth.uid' in subscription_read_policy) = 0
     or position('owner_id' in subscription_read_policy) = 0 then
    raise exception 'Subscription reads must be owner scoped';
  end if;

  if has_table_privilege('authenticated', 'billing.subscriptions', 'INSERT')
     or has_table_privilege('authenticated', 'billing.subscriptions', 'UPDATE')
     or has_table_privilege('authenticated', 'billing.subscriptions', 'DELETE') then
    raise exception 'Authenticated users must not mutate subscription rows';
  end if;
  if has_column_privilege(
       'authenticated', 'billing.subscriptions', 'external_subscription_id', 'SELECT'
     ) or has_column_privilege(
       'authenticated', 'billing.subscriptions', 'external_customer_id', 'SELECT'
     ) then
    raise exception 'Provider identifiers must not be readable by authenticated users';
  end if;
  if has_column_privilege('authenticated', 'billing.plans', 'metadata', 'SELECT')
     or has_table_privilege('authenticated', 'billing.plans', 'UPDATE') then
    raise exception 'Plan metadata must stay private and plans must be immutable to users';
  end if;
  if has_table_privilege('authenticated', 'billing.customer_accounts', 'SELECT')
     or has_table_privilege('authenticated', 'billing.webhook_events', 'SELECT') then
    raise exception 'Provider customer mappings and webhook events must be service-only';
  end if;
  if has_function_privilege(
       'authenticated', 'billing.max_apply_subscription_event(jsonb)', 'EXECUTE'
     ) then
    raise exception 'Authenticated users must not invoke subscription webhook processing';
  end if;
  if not has_function_privilege(
       'service_role', 'billing.max_apply_subscription_event(jsonb)', 'EXECUTE'
     ) then
    raise exception 'The service role must be able to process verified subscription events';
  end if;
end;
$$;
