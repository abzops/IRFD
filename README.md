# IRFD Insurance Renewal Dashboard

Static HTML/CSS/JS dashboard for insurance renewal follow-up operations, backed by Supabase Auth, Postgres tables, views, RLS policies, and a follow-up RPC.

## Run Locally

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173`.

For a local UI preview without Supabase credentials, open:

```text
http://127.0.0.1:4173/?demo=1
```

## Supabase Setup

1. Create a Supabase project.
2. Open the Supabase SQL editor and run `supabase/schema.sql`.
3. Create staff users manually in Supabase Auth.
4. Open the dashboard and save the project URL plus anon public key.

The browser app uses only the anon public key. Do not put a service-role key in `index.html`, local storage, or any frontend file.

## Checks

```powershell
node tests/logic.test.mjs
git diff --check
```
