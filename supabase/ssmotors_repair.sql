-- ======================================================
-- SS Motors User & Organization Repair
-- Run this in your Supabase SQL Editor
-- ======================================================

-- 1. Create the SS Motors Organization if it does not exist
insert into public.organizations (id, name, slug)
values ('11111111-1111-1111-1111-111111111111', 'SS Motors', 'ss-motors')
on conflict (id) do nothing;

-- 2. Create the Admin Profile for your pre-registered user (ssmotorsvrk)
insert into public.profiles (id, organization_id, role, full_name)
values (
  '9915b68a-ddd7-4f38-ba31-d6f8b88d41fa',  -- The UUID of ssmotorsvrk in your auth.users table
  '11111111-1111-1111-1111-111111111111',  -- SS Motors Organization ID
  'admin',                                 -- Role
  'SS Motors VRK'                          -- Full Name
)
on conflict (id) do update
set 
  organization_id = excluded.organization_id, 
  role = excluded.role, 
  full_name = excluded.full_name;
