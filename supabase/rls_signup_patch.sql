-- ======================================================
-- RLS Signup Patch (Updated)
-- Run this in the Supabase SQL Editor to fix the RLS insert error
-- ======================================================

-- 1. Ensure RLS is active
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;

-- 2. Drop any previous conflicting policies
drop policy if exists "Organizations are viewable by members" on public.organizations;
drop policy if exists "Organizations are viewable by everyone" on public.organizations;
drop policy if exists "Any authenticated user can create an organization" on public.organizations;
drop policy if exists "Anyone can create an organization" on public.organizations;

drop policy if exists "Profiles are viewable by coworkers" on public.profiles;
drop policy if exists "Profiles are viewable by coworkers or self" on public.profiles;
drop policy if exists "Users can insert their own profile" on public.profiles;
drop policy if exists "Anyone can insert a profile" on public.profiles;
drop policy if exists "Profiles can be updated by organization admins" on public.profiles;

-- 3. Create public insert & select policies for organizations
-- Note: Select using (true) is required because PostgREST does INSERT RETURNING,
-- which checks the SELECT (USING) policy on the newly inserted row.
create policy "Organizations are viewable by everyone"
on public.organizations for select
using (true);

create policy "Anyone can create an organization"
on public.organizations for insert
with check (true);

-- 4. Create profiles policies (allowing coworkers or self to view, anyone to insert)
create policy "Profiles are viewable by coworkers or self"
on public.profiles for select
using (
  id = auth.uid()
  or organization_id = public.get_my_organization_id()
);

create policy "Anyone can insert a profile"
on public.profiles for insert
with check (true);

create policy "Profiles can be updated by organization admins"
on public.profiles for update
to authenticated
using (
  organization_id = public.get_my_organization_id() 
  and (select role from public.profiles where id = auth.uid()) = 'admin'
);

-- 5. Explicitly grant permissions to both authenticated and anonymous roles
grant select, insert, update on public.organizations to authenticated, anon;
grant select, insert, update on public.profiles to authenticated, anon;
