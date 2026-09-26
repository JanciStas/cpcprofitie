-- Close the Supabase Data API over every table in `public`.
--
-- No table had row level security, and the Supabase anon key ships in the
-- browser bundle (it is needed by the password-update form). Supabase exposes
-- `public` over PostgREST to the `anon` and `authenticated` roles by default,
-- so anyone could copy that key out of the JS and:
--   GET   /rest/v1/users?select=*            -- every user's e-mail
--   PATCH /rest/v1/subscriptions?user_id=... -- grant themselves a paid plan
--   DELETE from any table
--
-- The app never reads these tables through PostgREST: Drizzle connects
-- directly as the database owner, and the owner bypasses RLS. So enabling RLS
-- with NO policies denies the anon/authenticated API roles everything while
-- the application keeps working unchanged. Auth itself lives in the `auth`
-- schema and is unaffected.
--
-- A loop rather than a list, so a table added later without remembering this
-- migration is caught the next time it runs, and so this cannot silently miss
-- one of the eighteen current tables.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- Belt and braces: the API roles get no table privileges in `public` at all,
-- now or for tables created later.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
