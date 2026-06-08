begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.insurance_renewals (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  mobile_number text not null,
  vehicle_number text not null,
  model text,
  variant text,
  registration_date date,
  service_advisor text,
  relationship_manager text,
  current_insurer text,
  policy_number text,
  policy_expiry_date date not null,
  previous_premium numeric(12,2),
  renewal_quote_amount numeric(12,2),
  idv numeric(12,2),
  ncb_percentage numeric(5,2),
  policy_type text default 'Comprehensive' check (policy_type in ('Comprehensive', 'Third Party', 'Own Damage')),
  addons text[] default '{}',
  current_status text not null default 'New Lead' check (
    current_status in (
      'New Lead',
      'Call Pending',
      'Contacted',
      'Not Reachable',
      'Quote Requested',
      'Quote Sent',
      'Follow-up Pending',
      'Interested',
      'Payment Pending',
      'Renewed',
      'Lost',
      'Invalid Data'
    )
  ),
  customer_response text,
  lost_reason text check (
    lost_reason is null or lost_reason in (
      'Premium High',
      'Renewed Elsewhere',
      'Not Interested',
      'Vehicle Sold',
      'Not Reachable',
      'Wrong Number',
      'Only Third Party'
    )
  ),
  last_followup_date date,
  next_followup_date date,
  assigned_executive text,
  payment_status text default 'Not Started' check (payment_status in ('Not Started', 'Pending', 'Collected', 'Failed', 'Refunded')),
  quote_sent_date date,
  renewal_date date,
  remarks text,
  created_by uuid references auth.users(id) default auth.uid(),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.renewal_followups (
  id uuid primary key default gen_random_uuid(),
  renewal_id uuid not null references public.insurance_renewals(id) on delete cascade,
  followup_date date not null default current_date,
  followup_by text not null,
  followup_mode text not null check (followup_mode in ('Call', 'WhatsApp', 'SMS', 'Email', 'In Person')),
  customer_response text,
  remarks text,
  next_action text,
  next_followup_date date,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

drop trigger if exists set_insurance_renewals_updated_at on public.insurance_renewals;
create trigger set_insurance_renewals_updated_at
before update on public.insurance_renewals
for each row execute function public.set_updated_at();

alter table public.insurance_renewals enable row level security;
alter table public.renewal_followups enable row level security;

drop policy if exists "Authenticated staff can read renewals" on public.insurance_renewals;
create policy "Authenticated staff can read renewals"
on public.insurance_renewals for select
to authenticated
using (true);

drop policy if exists "Authenticated staff can insert renewals" on public.insurance_renewals;
create policy "Authenticated staff can insert renewals"
on public.insurance_renewals for insert
to authenticated
with check (auth.role() = 'authenticated');

drop policy if exists "Authenticated staff can update renewals" on public.insurance_renewals;
create policy "Authenticated staff can update renewals"
on public.insurance_renewals for update
to authenticated
using (true)
with check (auth.role() = 'authenticated');

drop policy if exists "Authenticated staff can read followups" on public.renewal_followups;
create policy "Authenticated staff can read followups"
on public.renewal_followups for select
to authenticated
using (true);

drop policy if exists "Authenticated staff can insert followups" on public.renewal_followups;
create policy "Authenticated staff can insert followups"
on public.renewal_followups for insert
to authenticated
with check (auth.role() = 'authenticated');

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

grant usage on schema public to authenticated;
grant select, insert, update on public.insurance_renewals to authenticated;
grant select, insert on public.renewal_followups to authenticated;
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

insert into public.insurance_renewals (
  id,
  customer_name,
  mobile_number,
  vehicle_number,
  model,
  variant,
  registration_date,
  service_advisor,
  relationship_manager,
  current_insurer,
  policy_number,
  policy_expiry_date,
  previous_premium,
  renewal_quote_amount,
  idv,
  ncb_percentage,
  policy_type,
  addons,
  current_status,
  customer_response,
  lost_reason,
  last_followup_date,
  next_followup_date,
  assigned_executive,
  payment_status,
  quote_sent_date,
  renewal_date,
  remarks,
  closed_at
)
values
  ('10000000-0000-4000-8000-000000000001', 'Rajesh Kumar', '9876500011', 'KL 07 AB 1234', 'Swift', 'VXI', current_date - interval '3 years', 'Arun', 'Asha Nair', 'Maruti Insurance', 'POL-KL07AB1234', current_date + interval '6 days', 18500, 17800, 550000, 20, 'Comprehensive', array['Zero Dep', 'RSA'], 'Quote Sent', 'Wants revised premium', null, current_date - interval '1 day', current_date, 'Asha Nair', 'Not Started', current_date - interval '1 day', null, 'Quotation shared on WhatsApp', null),
  ('10000000-0000-4000-8000-000000000002', 'Anil Menon', '9876500022', 'KL 08 CD 7788', 'Baleno', 'ZXI', current_date - interval '4 years', 'Jithin', 'Asha Nair', 'ICICI Lombard', 'POL-KL08CD7788', current_date + interval '1 day', 17200, 16500, 480000, 25, 'Comprehensive', array['Engine Protect'], 'Not Reachable', 'Call not connected', null, current_date - interval '1 day', current_date, 'Asha Nair', 'Not Started', null, null, 'Retry call today', null),
  ('10000000-0000-4000-8000-000000000003', 'Meera Joseph', '9876500033', 'KL 11 XY 2233', 'Brezza', 'VXI', current_date - interval '2 years', 'Ramesh', 'Ravi Kumar', 'HDFC Ergo', 'POL-KL11XY2233', current_date + interval '18 days', 18100, 17200, 620000, 20, 'Comprehensive', array['Zero Dep'], 'New Lead', null, null, null, current_date, 'Ravi Kumar', 'Not Started', null, null, 'First call pending', null),
  ('10000000-0000-4000-8000-000000000004', 'Nisha Varghese', '9876500044', 'KL 05 MN 9090', 'Fronx', 'Alpha', current_date - interval '1 year', 'Arun', 'Ravi Kumar', 'Maruti Insurance', 'POL-KL05MN9090', current_date + interval '3 days', 22200, 21400, 780000, 15, 'Comprehensive', array['Zero Dep', 'RSA'], 'Payment Pending', 'Payment link requested', null, current_date - interval '1 day', current_date, 'Ravi Kumar', 'Pending', current_date - interval '2 days', null, 'Customer agreed', null),
  ('10000000-0000-4000-8000-000000000005', 'Vivek Thomas', '9876500055', 'KL 09 PP 3344', 'Ertiga', 'ZXI', current_date - interval '3 years', 'Jithin', 'Asha Nair', 'Maruti Insurance', 'POL-KL09PP3344', current_date + interval '20 days', 25200, 24500, 730000, 20, 'Comprehensive', array['Zero Dep', 'RSA'], 'Renewed', 'Payment done', null, current_date, null, 'Asha Nair', 'Collected', current_date - interval '1 day', current_date, 'Policy copy shared', now()),
  ('10000000-0000-4000-8000-000000000006', 'Suresh Babu', '9876500066', 'KL 10 AA 1230', 'WagonR', 'LXI', current_date - interval '5 years', 'Ramesh', 'Neha Shah', 'ICICI Lombard', 'POL-KL10AA1230', current_date - interval '2 days', 13600, 12800, 320000, 35, 'Comprehensive', array['RSA'], 'Lost', 'Already renewed outside', 'Renewed Elsewhere', current_date - interval '1 day', null, 'Neha Shah', 'Not Started', null, null, 'Lost to outside quote', now()),
  ('10000000-0000-4000-8000-000000000007', 'Farah Ali', '9876500077', 'KL 13 GH 4545', 'Grand Vitara', 'Alpha', current_date - interval '1 year', 'Arun', 'Neha Shah', 'HDFC Ergo', 'POL-KL13GH4545', current_date + interval '31 days', 32400, 31500, 1180000, 0, 'Comprehensive', array['Zero Dep', 'Engine Protect'], 'Contacted', 'Call later', null, current_date - interval '1 day', current_date + interval '5 days', 'Neha Shah', 'Not Started', null, null, 'Soft reminder done', null),
  ('10000000-0000-4000-8000-000000000008', 'Hari Krishnan', '9876500088', 'KL 06 JK 8721', 'Celerio', 'VXI', current_date - interval '4 years', 'Jithin', 'Asha Nair', 'Maruti Insurance', 'POL-KL06JK8721', current_date + interval '12 days', 14900, 14250, 360000, 25, 'Comprehensive', array['Zero Dep'], 'Follow-up Pending', 'Premium high', null, current_date - interval '1 day', current_date + interval '1 day', 'Asha Nair', 'Not Started', current_date - interval '1 day', null, 'Explain benefits', null),
  ('10000000-0000-4000-8000-000000000009', 'Deepa S', '9876500099', 'KL 01 LM 2301', 'Jimny', 'Alpha', current_date - interval '1 year', 'Ramesh', 'Ravi Kumar', 'Tata AIG', 'POL-KL01LM2301', current_date + interval '8 days', 29700, 28900, 980000, 0, 'Comprehensive', array['Zero Dep', 'Engine Protect', 'RSA'], 'Interested', 'Interested', null, current_date - interval '1 day', current_date, 'Ravi Kumar', 'Not Started', current_date - interval '1 day', null, 'Push for payment', null),
  ('10000000-0000-4000-8000-000000000010', 'Kavya Prasad', '9876500101', 'KL 02 NP 7741', 'Ignis', 'Delta', current_date - interval '2 years', 'Arun', 'Neha Shah', 'HDFC Ergo', 'POL-KL02NP7741', current_date + interval '29 days', 16000, 15400, 410000, 20, 'Comprehensive', array['RSA'], 'Quote Requested', 'Wants quote', null, current_date - interval '1 day', current_date, 'Neha Shah', 'Not Started', null, null, 'Prepare quote', null),
  ('10000000-0000-4000-8000-000000000011', 'Omar Latheef', '9876500111', 'KL 14 RS 5588', 'Brezza', 'ZXI', current_date - interval '3 years', 'Jithin', 'Asha Nair', 'Maruti Insurance', 'POL-KL14RS5588', current_date + interval '5 days', 18900, 18100, 640000, 20, 'Comprehensive', array['Zero Dep'], 'Lost', 'Not Interested', 'Not Interested', current_date, null, 'Asha Nair', 'Not Started', null, null, 'Customer refused renewal support', now()),
  ('10000000-0000-4000-8000-000000000012', 'Latha Devi', '9876500121', 'KL 03 TU 8822', 'Alto K10', 'LXI', current_date - interval '5 years', 'Ramesh', 'Ravi Kumar', 'ICICI Lombard', 'POL-KL03TU8822', current_date - interval '1 day', 10400, 9800, 280000, 35, 'Comprehensive', array['RSA'], 'Call Pending', null, null, null, current_date, 'Ravi Kumar', 'Not Started', null, null, 'Expired yesterday', null)
on conflict (id) do update
set
  customer_name = excluded.customer_name,
  mobile_number = excluded.mobile_number,
  vehicle_number = excluded.vehicle_number,
  model = excluded.model,
  variant = excluded.variant,
  registration_date = excluded.registration_date,
  service_advisor = excluded.service_advisor,
  relationship_manager = excluded.relationship_manager,
  current_insurer = excluded.current_insurer,
  policy_number = excluded.policy_number,
  policy_expiry_date = excluded.policy_expiry_date,
  previous_premium = excluded.previous_premium,
  renewal_quote_amount = excluded.renewal_quote_amount,
  idv = excluded.idv,
  ncb_percentage = excluded.ncb_percentage,
  policy_type = excluded.policy_type,
  addons = excluded.addons,
  current_status = excluded.current_status,
  customer_response = excluded.customer_response,
  lost_reason = excluded.lost_reason,
  last_followup_date = excluded.last_followup_date,
  next_followup_date = excluded.next_followup_date,
  assigned_executive = excluded.assigned_executive,
  payment_status = excluded.payment_status,
  quote_sent_date = excluded.quote_sent_date,
  renewal_date = excluded.renewal_date,
  remarks = excluded.remarks,
  closed_at = excluded.closed_at;

insert into public.renewal_followups (
  id,
  renewal_id,
  followup_date,
  followup_by,
  followup_mode,
  customer_response,
  remarks,
  next_action,
  next_followup_date
)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', current_date - interval '1 day', 'Asha Nair', 'WhatsApp', 'Wants revised premium', 'Quotation shared', 'Call for confirmation', current_date),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', current_date - interval '1 day', 'Asha Nair', 'Call', 'Call not connected', 'Retry required', 'Retry call', current_date),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004', current_date - interval '1 day', 'Ravi Kumar', 'Call', 'Payment link requested', 'Customer agreed', 'Collect payment', current_date),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000005', current_date, 'Asha Nair', 'WhatsApp', 'Payment done', 'Policy issued', 'Share policy copy', null),
  ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000006', current_date - interval '1 day', 'Neha Shah', 'Call', 'Already renewed outside', 'Closed as lost', 'Review lost reason', null),
  ('20000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000009', current_date - interval '1 day', 'Ravi Kumar', 'Call', 'Interested', 'Customer asked for payment details', 'Push for payment', current_date)
on conflict (id) do update
set
  followup_date = excluded.followup_date,
  followup_by = excluded.followup_by,
  followup_mode = excluded.followup_mode,
  customer_response = excluded.customer_response,
  remarks = excluded.remarks,
  next_action = excluded.next_action,
  next_followup_date = excluded.next_followup_date;

commit;
