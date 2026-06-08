-- ======================================================
-- RLS Signup Patch
-- Run this in the Supabase SQL Editor to fix the RLS insert error
-- ======================================================

-- 1. Ensure RLS is active
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;

-- 2. Drop any previous conflicting policies
drop policy if exists "Any authenticated user can create an organization" on public.organizations;
drop policy if exists "Anyone can create an organization" on public.organizations;
drop policy if exists "Users can insert their own profile" on public.profiles;
drop policy if exists "Anyone can insert a profile" on public.profiles;

-- 3. Create open insert policies (necessary for signup when email verification is active)
create policy "Anyone can create an organization"
on public.organizations for insert
with check (true);

create policy "Anyone can insert a profile"
on public.profiles for insert
with check (true);

-- 4. Explicitly grant permissions to both authenticated and anonymous roles
grant select, insert, update on public.organizations to authenticated, anon;
grant select, insert, update on public.profiles to authenticated, anon;
