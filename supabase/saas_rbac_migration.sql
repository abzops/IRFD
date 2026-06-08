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
-- 8. Row-Level Security (RLS) Configuration
-- ======================================================
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;
alter table public.insurance_renewals enable row level security;
alter table public.renewal_followups enable row level security;

-- --- Organizations Policies ---
create policy "Organizations are viewable by members"
on public.organizations for select
to authenticated
using (
  owner_id = auth.uid()
  or id in (select organization_id from public.organization_members where user_id = auth.uid())
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
  or id in (
    select user_id from public.organization_members where organization_id in (
      select organization_id from public.organization_members where user_id = auth.uid()
    )
  )
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
  organization_id in (select organization_id from public.organization_members where user_id = auth.uid())
  or organization_id in (select id from public.organizations where owner_id = auth.uid())
);

create policy "Admins/Owners can insert organization members"
on public.organization_members for insert
to authenticated
with check (
  organization_id in (select id from public.organizations where owner_id = auth.uid())
  or organization_id in (select organization_id from public.organization_members where user_id = auth.uid() and role = 'Admin')
);

create policy "Admins/Owners can update organization members"
on public.organization_members for update
to authenticated
using (
  organization_id in (select id from public.organizations where owner_id = auth.uid())
  or organization_id in (select organization_id from public.organization_members where user_id = auth.uid() and role = 'Admin')
);

create policy "Admins/Owners can delete organization members"
on public.organization_members for delete
to authenticated
using (
  organization_id in (select id from public.organizations where owner_id = auth.uid())
  or organization_id in (select organization_id from public.organization_members where user_id = auth.uid() and role = 'Admin')
);

-- --- Insurance Renewals Policies ---
create policy "Select renewals policy"
on public.insurance_renewals for select
to authenticated
using (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and organization_id in (
    select organization_id from public.organization_members where user_id = auth.uid()
  ))
);

create policy "Insert renewals policy"
on public.insurance_renewals for insert
to authenticated
with check (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and organization_id in (
    select organization_id from public.organization_members where user_id = auth.uid()
  ))
);

create policy "Update renewals policy"
on public.insurance_renewals for update
to authenticated
using (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and organization_id in (
    select organization_id from public.organization_members where user_id = auth.uid()
  ))
)
with check (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and organization_id in (
    select organization_id from public.organization_members where user_id = auth.uid()
  ))
);

create policy "Delete renewals policy"
on public.insurance_renewals for delete
to authenticated
using (
  (organization_id is null and created_by = auth.uid())
  or
  (organization_id is not null and organization_id in (
    select organization_id from public.organization_members 
    where user_id = auth.uid() and role in ('Admin', 'Manager')
  ))
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

commit;
