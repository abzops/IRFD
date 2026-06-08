begin;

-- ======================================================
-- 1. Create Organizations and Profiles Tables
-- ======================================================
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('admin', 'agent')),
  full_name text not null,
  created_at timestamptz not null default now()
);

-- Enable Row-Level Security (RLS)
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;

-- ======================================================
-- 2. Populate Default Organization for Existing Data
-- ======================================================
insert into public.organizations (id, name, slug)
values ('00000000-0000-0000-0000-000000000000', 'Default Organization', 'default-org')
on conflict (id) do nothing;

-- Add organization_id column to business tables
alter table public.insurance_renewals 
add column if not exists organization_id uuid references public.organizations(id) on delete cascade;

alter table public.renewal_followups 
add column if not exists organization_id uuid references public.organizations(id) on delete cascade;

-- Associate any orphaned data with the default organization
update public.insurance_renewals
set organization_id = '00000000-0000-0000-0000-000000000000'
where organization_id is null;

update public.renewal_followups
set organization_id = '00000000-0000-0000-0000-000000000000'
where organization_id is null;

-- Make organization_id NOT NULL now that data is safe
alter table public.insurance_renewals alter column organization_id set not null;
alter table public.renewal_followups alter column organization_id set not null;

-- ======================================================
-- 3. Define Helper Functions & Triggers for Auto-Assignment
-- ======================================================
create or replace function public.get_my_organization_id()
returns uuid
security definer
stable
as $$
  select organization_id from public.profiles where id = auth.uid();
$$ language sql;

create or replace function public.set_organization_id()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.organization_id is null then
    new.organization_id := public.get_my_organization_id();
  end if;
  return new;
end;
$$;

-- Triggers to automatically set organization_id on insert
drop trigger if exists set_renewal_org_id on public.insurance_renewals;
create trigger set_renewal_org_id
before insert on public.insurance_renewals
for each row execute function public.set_organization_id();

drop trigger if exists set_followup_org_id on public.renewal_followups;
create trigger set_followup_org_id
before insert on public.renewal_followups
for each row execute function public.set_organization_id();

-- ======================================================
-- 4. Rebuild RLS Policies with Tenant Isolation
-- ======================================================

-- Organizations Policies
drop policy if exists "Organizations are viewable by members" on public.organizations;
create policy "Organizations are viewable by members"
on public.organizations for select
to authenticated
using (id = public.get_my_organization_id());

drop policy if exists "Any authenticated user can create an organization" on public.organizations;
create policy "Any authenticated user can create an organization"
on public.organizations for insert
to authenticated
with check (true);

-- Profiles Policies
drop policy if exists "Profiles are viewable by coworkers" on public.profiles;
create policy "Profiles are viewable by coworkers"
on public.profiles for select
to authenticated
using (organization_id = public.get_my_organization_id());

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "Profiles can be updated by organization admins" on public.profiles;
create policy "Profiles can be updated by organization admins"
on public.profiles for update
to authenticated
using (
  organization_id = public.get_my_organization_id() 
  and (select role from public.profiles where id = auth.uid()) = 'admin'
);

-- Insurance Renewals Policies
drop policy if exists "Authenticated staff can read renewals" on public.insurance_renewals;
create policy "Authenticated staff can read renewals"
on public.insurance_renewals for select
to authenticated
using (organization_id = public.get_my_organization_id());

drop policy if exists "Authenticated staff can insert renewals" on public.insurance_renewals;
create policy "Authenticated staff can insert renewals"
on public.insurance_renewals for insert
to authenticated
with check (organization_id = public.get_my_organization_id());

drop policy if exists "Authenticated staff can update renewals" on public.insurance_renewals;
create policy "Authenticated staff can update renewals"
on public.insurance_renewals for update
to authenticated
using (organization_id = public.get_my_organization_id())
with check (organization_id = public.get_my_organization_id());

-- Renewal Follow-ups Policies
drop policy if exists "Authenticated staff can read followups" on public.renewal_followups;
create policy "Authenticated staff can read followups"
on public.renewal_followups for select
to authenticated
using (organization_id = public.get_my_organization_id());

drop policy if exists "Authenticated staff can insert followups" on public.renewal_followups;
create policy "Authenticated staff can insert followups"
on public.renewal_followups for insert
to authenticated
with check (organization_id = public.get_my_organization_id());

-- ======================================================
-- 5. Set up Permissions
-- ======================================================
grant select, insert, update on public.organizations to authenticated;
grant select, insert, update on public.profiles to authenticated;

commit;
