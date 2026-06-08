begin;

-- ======================================================
-- 1. Drop existing tables if they conflict, to ensure clean rebuild
-- ======================================================
drop table if exists public.organization_members cascade;
drop table if exists public.profiles cascade;
drop table if exists public.organizations cascade;

-- ======================================================
-- 2. Create Organizations Table
-- ======================================================
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  owner_id uuid references auth.users(id) on delete cascade not null,
  created_at timestamptz not null default now()
);

-- ======================================================
-- 3. Create Profiles Table (User Account Info)
-- ======================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  email text not null,
  full_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- ======================================================
-- 4. Create Organization Members Table (RBAC Join Table)
-- ======================================================
create table public.organization_members (
  organization_id uuid references public.organizations(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  role text not null check (role in ('Admin', 'Manager', 'Staff Member')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- ======================================================
-- 5. Modify Insurance Renewals & Followups for Hybrid Workspaces
-- ======================================================
-- Add organization_id as nullable (null = Personal Workspace)
alter table public.insurance_renewals drop column if exists organization_id cascade;
alter table public.insurance_renewals add column organization_id uuid references public.organizations(id) on delete cascade;

alter table public.renewal_followups drop column if exists organization_id cascade;
alter table public.renewal_followups add column organization_id uuid references public.organizations(id) on delete cascade;

-- Ensure created_by is set in renewals
alter table public.insurance_renewals drop column if exists created_by cascade;
alter table public.insurance_renewals add column created_by uuid references auth.users(id) default auth.uid();

-- ======================================================
-- 6. Trigger to Automatically Create Profile on Signup
-- ======================================================
create or replace function public.handle_new_user()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
declare
  v_username text;
  v_full_name text;
begin
  v_username := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));
  v_full_name := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));
  
  -- Make username unique by appending random numbers if it already exists
  while exists (select 1 from public.profiles where username = v_username) loop
    v_username := v_username || floor(random() * 10)::text;
  end loop;

  insert into public.profiles (id, username, email, full_name, avatar_url)
  values (
    new.id,
    v_username,
    new.email,
    v_full_name,
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ======================================================
-- 7. Trigger to Auto-Assign organization_id & created_by on Insert
-- ======================================================
create or replace function public.set_renewal_audit_fields()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists set_renewal_audit on public.insurance_renewals;
create trigger set_renewal_audit
before insert on public.insurance_renewals
for each row execute function public.set_renewal_audit_fields();

-- Auto-populate organization_id on followups
create or replace function public.set_followup_org_id()
returns trigger
language plpgsql
security definer
as $$
begin
  select organization_id into new.organization_id
  from public.insurance_renewals
  where id = new.renewal_id;
  return new;
end;
$$;

drop trigger if exists set_followup_org on public.renewal_followups;
create trigger set_followup_org
before insert on public.renewal_followups
for each row execute function public.set_followup_org_id();

-- ======================================================
-- 7.5 Helper Functions for Row-Level Security (to prevent recursion)
-- ======================================================
create or replace function public.is_organization_member(org_id uuid, usr_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = org_id and user_id = usr_id
  );
$$;

create or replace function public.share_organization(user_a uuid, user_b uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 
    from public.organization_members m1
    join public.organization_members m2 on m1.organization_id = m2.organization_id
    where m1.user_id = user_a and m2.user_id = user_b
  );
$$;

create or replace function public.has_org_role(org_id uuid, usr_id uuid, roles text[])
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = org_id and user_id = usr_id and role = any(roles)
  );
$$;

-- ======================================================
-- 8. Row-Level Security (RLS) Configuration
-- ======================================================
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;
alter table public.insurance_renewals enable row level security;
alter table public.renewal_followups enable row level security;

-- --- Drop old policies to prevent collision/bypass ---
drop policy if exists "Authenticated staff can read renewals" on public.insurance_renewals;
drop policy if exists "Authenticated staff can insert renewals" on public.insurance_renewals;
drop policy if exists "Authenticated staff can update renewals" on public.insurance_renewals;
drop policy if exists "Authenticated staff can read followups" on public.renewal_followups;
drop policy if exists "Authenticated staff can insert followups" on public.renewal_followups;

-- --- Drop new policies if they already exist for idempotence ---
drop policy if exists "Organizations are viewable by members" on public.organizations;
drop policy if exists "Anyone authenticated can create an organization" on public.organizations;
drop policy if exists "Only owner can update organization details" on public.organizations;
drop policy if exists "Only owner can delete organization" on public.organizations;

drop policy if exists "Profiles viewable by self and coworkers" on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;

drop policy if exists "Members list viewable by teammates" on public.organization_members;
drop policy if exists "Admins/Owners can insert organization members" on public.organization_members;
drop policy if exists "Admins/Owners can update organization members" on public.organization_members;
drop policy if exists "Admins/Owners can delete organization members" on public.organization_members;

drop policy if exists "Select renewals policy" on public.insurance_renewals;
drop policy if exists "Insert renewals policy" on public.insurance_renewals;
drop policy if exists "Update renewals policy" on public.insurance_renewals;
drop policy if exists "Delete renewals policy" on public.insurance_renewals;

drop policy if exists "Select followups policy" on public.renewal_followups;
drop policy if exists "Insert followups policy" on public.renewal_followups;

-- --- Organizations Policies ---
create policy "Organizations are viewable by members"
on public.organizations for select
to authenticated
using (
  owner_id = auth.uid()
  or is_organization_member(id, auth.uid())
);

create policy "Anyone authenticated can create an organization"
on public.organizations for insert
to authenticated
with check (owner_id = auth.uid());

create policy "Only owner can update organization details"
on public.organizations for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "Only owner can delete organization"
on public.organizations for delete
to authenticated
using (owner_id = auth.uid());

-- --- Profiles Policies ---
create policy "Profiles viewable by self and coworkers"
on public.profiles for select
to authenticated
using (
  id = auth.uid()
  or share_organization(id, auth.uid())
);

create policy "Users can update their own profile"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- --- Organization Members Policies ---
create policy "Members list viewable by teammates"
on public.organization_members for select
to authenticated
using (
  is_organization_member(organization_id, auth.uid())
  or organization_id in (select id from public.organizations where owner_id = auth.uid())
);

create policy "Admins/Owners can insert organization members"
on public.organization_members for insert
to authenticated
with check (
  organization_id in (select id from public.organizations where owner_id = auth.uid())
  or has_org_role(organization_id, auth.uid(), array['Admin'])
);

create policy "Admins/Owners can update organization members"
on public.organization_members for update
to authenticated
using (
  organization_id in (select id from public.organizations where owner_id = auth.uid())
  or has_org_role(organization_id, auth.uid(), array['Admin'])
);

create policy "Admins/Owners can delete organization members"
on public.organization_members for delete
to authenticated
using (
  organization_id in (select id from public.organizations where owner_id = auth.uid())
  or has_org_role(organization_id, auth.uid(), array['Admin'])
);

-- --- Insurance Renewals Policies ---
create policy "Select renewals policy"
on public.insurance_renewals for select
to authenticated
using (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and is_organization_member(organization_id, auth.uid()))
);

create policy "Insert renewals policy"
on public.insurance_renewals for insert
to authenticated
with check (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and is_organization_member(organization_id, auth.uid()))
);

create policy "Update renewals policy"
on public.insurance_renewals for update
to authenticated
using (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and is_organization_member(organization_id, auth.uid()))
)
with check (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and is_organization_member(organization_id, auth.uid()))
);

create policy "Delete renewals policy"
on public.insurance_renewals for delete
to authenticated
using (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and has_org_role(organization_id, auth.uid(), array['Admin', 'Manager']))
);

-- --- Renewal Follow-ups Policies ---
create policy "Select followups policy"
on public.renewal_followups for select
to authenticated
using (
  exists (
    select 1 from public.insurance_renewals r 
    where r.id = renewal_id
  )
);

create policy "Insert followups policy"
on public.renewal_followups for insert
to authenticated
with check (
  exists (
    select 1 from public.insurance_renewals r 
    where r.id = renewal_id
  )
);

-- ======================================================
-- 9. Set up Permissions
-- ======================================================
grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;

-- ======================================================
-- 10. Recreate Cascaded Views & Functions
-- ======================================================

create or replace view public.insurance_renewals_enriched
with (security_invoker = true)
as
select
  r.*,
  (r.policy_expiry_date - current_date)::int as days_left,
  case
    when r.current_status = 'Renewed' then 'Renewed'
    when r.current_status = 'Lost' then 'Lost'
    when r.current_status = 'Invalid Data' then 'Closed'
    when r.policy_expiry_date < current_date then 'Critical'
    when r.policy_expiry_date <= current_date + interval '7 days' then 'Urgent'
    when r.policy_expiry_date <= current_date + interval '15 days' then 'High'
    when r.policy_expiry_date <= current_date + interval '30 days' then 'Medium'
    else 'Low'
  end as priority,
  (
    r.current_status not in ('Renewed', 'Lost', 'Invalid Data')
    and r.next_followup_date is null
  ) as action_missing
from public.insurance_renewals r;

create or replace view public.renewal_dashboard_counts
with (security_invoker = true)
as
select 'total_renewal_leads' as metric, count(*)::int as value from public.insurance_renewals_enriched
union all
select 'expiring_this_month', count(*)::int from public.insurance_renewals_enriched
where current_status not in ('Renewed', 'Lost', 'Invalid Data')
and date_trunc('month', policy_expiry_date) = date_trunc('month', current_date)
union all
select 'expiring_in_7_days', count(*)::int from public.insurance_renewals_enriched
where current_status not in ('Renewed', 'Lost', 'Invalid Data') and days_left between 0 and 7
union all
select 'followup_due_today', count(*)::int from public.insurance_renewals_enriched
where current_status not in ('Renewed', 'Lost', 'Invalid Data')
and (next_followup_date <= current_date or action_missing)
union all
select 'quote_sent', count(*)::int from public.insurance_renewals_enriched
where current_status = 'Quote Sent' or quote_sent_date is not null
union all
select 'interested_customers', count(*)::int from public.insurance_renewals_enriched
where current_status in ('Interested', 'Payment Pending', 'Renewed')
union all
select 'not_interested', count(*)::int from public.insurance_renewals_enriched
where current_status = 'Lost' and (lost_reason = 'Not Interested' or customer_response = 'Not Interested')
union all
select 'renewed', count(*)::int from public.insurance_renewals_enriched
where current_status = 'Renewed'
union all
select 'lost', count(*)::int from public.insurance_renewals_enriched
where current_status = 'Lost'
union all
select 'pending_followup', count(*)::int from public.insurance_renewals_enriched
where current_status not in ('Renewed', 'Lost', 'Invalid Data')
and current_status in ('Follow-up Pending', 'Quote Sent', 'Interested', 'Not Reachable')
union all
select 'action_missing', count(*)::int from public.insurance_renewals_enriched
where action_missing;

create or replace view public.renewal_today_followups
with (security_invoker = true)
as
select *
from public.insurance_renewals_enriched
where current_status not in ('Renewed', 'Lost', 'Invalid Data')
and (next_followup_date <= current_date or action_missing);

create or replace view public.renewal_expiring_soon
with (security_invoker = true)
as
select *
from public.insurance_renewals_enriched
where current_status not in ('Renewed', 'Lost', 'Invalid Data')
and days_left between 0 and 30;

create or replace view public.renewal_conversion_funnel
with (security_invoker = true)
as
select 1 as sort_order, 'Total Leads' as stage, count(*)::int as count from public.insurance_renewals
union all
select 2, 'Contacted', count(*)::int from public.insurance_renewals
where current_status in ('Contacted', 'Not Reachable', 'Quote Requested', 'Quote Sent', 'Follow-up Pending', 'Interested', 'Payment Pending', 'Renewed', 'Lost')
union all
select 3, 'Quote Sent', count(*)::int from public.insurance_renewals
where current_status in ('Quote Sent', 'Follow-up Pending', 'Interested', 'Payment Pending', 'Renewed') or quote_sent_date is not null
union all
select 4, 'Interested', count(*)::int from public.insurance_renewals
where current_status in ('Interested', 'Payment Pending', 'Renewed')
union all
select 5, 'Payment Pending', count(*)::int from public.insurance_renewals
where current_status in ('Payment Pending', 'Renewed')
union all
select 6, 'Renewed', count(*)::int from public.insurance_renewals
where current_status = 'Renewed'
order by sort_order;

create or replace view public.renewal_staff_performance
with (security_invoker = true)
as
with call_counts as (
  select renewal_id, count(*)::int as calls_done
  from public.renewal_followups
  where followup_mode = 'Call'
  group by renewal_id
)
select
  coalesce(r.assigned_executive, 'Unassigned') as executive,
  count(*)::int as leads_assigned,
  coalesce(sum(c.calls_done), 0)::int as calls_done,
  count(*) filter (where r.current_status = 'Quote Sent' or r.quote_sent_date is not null)::int as quotes_sent,
  count(*) filter (where r.current_status = 'Renewed')::int as renewed,
  count(*) filter (where r.current_status = 'Lost')::int as lost,
  round((count(*) filter (where r.current_status = 'Renewed')::numeric / nullif(count(*), 0)) * 100, 0)::int as conversion_percentage
from public.insurance_renewals r
left join call_counts c on c.renewal_id = r.id
group by coalesce(r.assigned_executive, 'Unassigned')
order by renewed desc, leads_assigned desc;

create or replace view public.renewal_insurer_performance
with (security_invoker = true)
as
select
  coalesce(current_insurer, 'Unknown') as insurance_company,
  count(*)::int as leads,
  count(*) filter (where current_status = 'Quote Sent' or quote_sent_date is not null)::int as quotes_sent,
  count(*) filter (where current_status = 'Renewed')::int as renewed,
  round(avg(renewal_quote_amount), 0)::int as avg_premium,
  round((count(*) filter (where current_status = 'Renewed')::numeric / nullif(count(*), 0)) * 100, 0)::int as conversion_percentage
from public.insurance_renewals
group by coalesce(current_insurer, 'Unknown')
order by renewed desc, leads desc;

create or replace view public.renewal_lost_reason_summary
with (security_invoker = true)
as
select
  coalesce(lost_reason, 'Unspecified') as lost_reason,
  count(*)::int as count
from public.insurance_renewals
where current_status = 'Lost'
group by coalesce(lost_reason, 'Unspecified')
order by count desc;

create or replace view public.renewal_monthly_report
with (security_invoker = true)
as
select
  to_char(date_trunc('month', coalesce(renewal_date, policy_expiry_date)), 'YYYY-MM') as month,
  count(*)::int as leads,
  count(*) filter (where current_status = 'Renewed')::int as renewed,
  count(*) filter (where current_status = 'Lost')::int as lost,
  coalesce(sum(renewal_quote_amount) filter (where current_status = 'Renewed'), 0)::numeric(12,2) as premium_total
from public.insurance_renewals
group by date_trunc('month', coalesce(renewal_date, policy_expiry_date))
order by month;

create or replace function public.record_renewal_followup(
  p_renewal_id uuid,
  p_followup_date date default current_date,
  p_followup_by text default null,
  p_followup_mode text default 'Call',
  p_current_status text default null,
  p_customer_response text default null,
  p_remarks text default null,
  p_next_action text default null,
  p_next_followup_date date default null,
  p_payment_status text default null,
  p_lost_reason text default null,
  p_renewal_date date default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
  v_result jsonb;
begin
  select coalesce(p_current_status, current_status)
  into v_status
  from public.insurance_renewals
  where id = p_renewal_id;

  if v_status is null then
    raise exception 'Renewal lead not found';
  end if;

  insert into public.renewal_followups (
    renewal_id,
    followup_date,
    followup_by,
    followup_mode,
    customer_response,
    remarks,
    next_action,
    next_followup_date
  )
  values (
    p_renewal_id,
    coalesce(p_followup_date, current_date),
    coalesce(p_followup_by, auth.uid()::text, 'Staff'),
    coalesce(p_followup_mode, 'Call'),
    p_customer_response,
    p_remarks,
    p_next_action,
    p_next_followup_date
  );

  update public.insurance_renewals
  set
    current_status = v_status,
    customer_response = coalesce(p_customer_response, customer_response),
    remarks = coalesce(p_remarks, remarks),
    last_followup_date = coalesce(p_followup_date, current_date),
    next_followup_date = case when v_status in ('Renewed', 'Lost', 'Invalid Data') then null else p_next_followup_date end,
    payment_status = coalesce(p_payment_status, payment_status),
    lost_reason = case when v_status = 'Lost' then coalesce(p_lost_reason, lost_reason) else lost_reason end,
    quote_sent_date = case when v_status = 'Quote Sent' and quote_sent_date is null then coalesce(p_followup_date, current_date) else quote_sent_date end,
    renewal_date = case when v_status = 'Renewed' then coalesce(p_renewal_date, p_followup_date, current_date) else renewal_date end,
    closed_at = case when v_status in ('Renewed', 'Lost', 'Invalid Data') then coalesce(closed_at, now()) else null end,
    updated_by = auth.uid()
  where id = p_renewal_id;

  select to_jsonb(r)
  into v_result
  from public.insurance_renewals_enriched r
  where r.id = p_renewal_id;

  return v_result;
end;
$$;

grant select on
  public.insurance_renewals_enriched,
  public.renewal_dashboard_counts,
  public.renewal_today_followups,
  public.renewal_expiring_soon,
  public.renewal_conversion_funnel,
  public.renewal_staff_performance,
  public.renewal_insurer_performance,
  public.renewal_lost_reason_summary,
  public.renewal_monthly_report
to authenticated;

grant execute on function public.record_renewal_followup(uuid, date, text, text, text, text, text, text, date, text, text, date) to authenticated;

commit;
