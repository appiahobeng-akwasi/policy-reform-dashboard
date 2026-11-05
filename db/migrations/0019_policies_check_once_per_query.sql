-- 0019: row-level security checks who is asking once per query, not once per row (decision 68).
--
-- The policies call is_internal(), is_admin(), my_role() and me(), and each call reads the
-- account and parses the sign-in claims. Written plainly, Postgres repeats them for every row
-- (several times per row), which made pages slow on small servers. Wrapped in a scalar
-- subquery, `(select is_internal())`, the planner runs them once per query (an InitPlan).
-- The rules themselves do not change; the RLS tests for every role prove it.
--
-- New policies must use the same form; tests/db/rls-performance.test.ts fails if one does not.

do $$
declare
  p record;
  helpers constant text := '\m(is_internal|is_admin|my_role|me)\(\)';
  wrapped text;
  checked text;
begin
  for p in
    select schemaname, tablename, policyname, cmd, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (qual ~ helpers or with_check ~ helpers)
  loop
    wrapped := regexp_replace(p.qual, helpers, '(select \1())', 'g');
    checked := regexp_replace(p.with_check, helpers, '(select \1())', 'g');
    if p.qual is not null and p.with_check is not null then
      execute format('alter policy %I on %I.%I using (%s) with check (%s)', p.policyname, p.schemaname, p.tablename, wrapped, checked);
    elsif p.qual is not null then
      execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, wrapped);
    else
      execute format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, checked);
    end if;
  end loop;
end $$;

-- The approvals queue (and the count in the header) asked who is signed in once per waiting
-- update. Ask once, then check each update for that person. Same result.
create or replace function approvable_submissions()
returns table (submission_id uuid, route text, created_at timestamptz, submitted_by_name text, on_behalf_name text,
               entities text[], reform_ids text[], row_count int, quality_score numeric, is_confirmation boolean, file_name text)
language sql stable security definer set search_path = public as $$
  select s.submission_id, s.route, s.created_at, ps.full_name, pb.full_name, s.entities, s.reform_ids,
         jsonb_array_length(s.payload -> 'rows'),
         (select r.quality_score from dq_runs r where r.dq_run_id = s.dq_run_id),
         is_confirmation(s.payload), b.file_name
    from submissions s
    join app_users us on us.user_id = s.submitted_by
    join people ps on ps.person_id = us.person_id
    left join people pb on pb.person_id = s.on_behalf_of_person_id
    left join upload_batches b on b.batch_id = s.batch_id
   where s.status = 'proposed'
     and coalesce(user_may_approve((select (me()).user_id), s.submission_id, false), false)
   order by s.created_at
$$;
