-- Supabase only. db:reset and db:migrate run this file when the role
-- 'authenticated' exists; plain Postgres skips it.
-- These grants only let Supabase's API roles reach the tables. Row-level
-- security (0003) still decides what each signed-in user can see and change.
-- Signed-out visitors (anon) get no table access and cannot call any function.

grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;

-- Functions whose comment starts with 'internal:' are for the server and the workflow
-- functions only (convention set in migration 0004).
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and obj_description(p.oid, 'pg_proc') like 'internal:%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
