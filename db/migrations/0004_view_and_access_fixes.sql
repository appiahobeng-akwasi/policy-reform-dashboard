-- 0004: fixes to 0002 and 0003 found while building step 2.
--   1. Views ran with their owner's rights, so they ignored row-level security: any signed-in
--      user could read every user's data quality figures, and counterparts could read risk counts.
--      Views now run with the rights of the person querying them (security_invoker, Postgres 15+).
--   2. v_reform_summary showed a reform with no items as green, because count(*) over a left
--      join is never 0. It now shows grey. Risk and decision counts are null for people who may
--      not see risks and decisions (counterparts), rather than a misleading 0.
--   3. computed_rag() reads current_date, so it is stable, not immutable.
--   4. is_allowed_email() could be called by signed-out visitors to probe the allowlist.
--      It is now for the server only.
--
-- Convention from here on: a function whose comment starts with 'internal:' is for the server and
-- the workflow functions only. The migration revokes it from PUBLIC; on Supabase,
-- db/platform/supabase_grants.sql also revokes it from the API roles.

alter function computed_rag(text, date, date, date, int) stable;

-- True for the server's own connection (database owner, superuser or a role that bypasses
-- row-level security) and inside security-definer functions; false for a signed-in user.
create or replace function is_privileged_session() returns boolean language sql stable as $$
  select r.rolsuper or r.rolbypassrls or r.oid = (select relowner from pg_class where oid = 'public.reforms'::regclass)
    from pg_roles r where r.rolname = current_user
$$;

create or replace view v_reform_summary with (security_invoker = on) as
  select r.reform_id, r.name_en, r.current_stage,
         count(*) filter (where f.object_type = 'milestone' and f.status not in ('complete','cancelled') and f.due_date <= current_date + 30) as milestones_due_30d,
         count(*) filter (where f.days_overdue > 0) as items_overdue,
         count(*) filter (where f.is_stale and f.status not in ('complete','cancelled')) as items_stale,
         count(*) filter (where f.rag = 'red') as items_red,
         count(*) filter (where f.rag = 'amber') as items_amber,
         case when is_internal() or is_privileged_session() then (select count(*) from risk_links rl join risks k using (risk_id) where rl.object_type = 'reform' and rl.object_id = r.reform_id and k.status <> 'closed') end as risks_open,
         case when is_internal() or is_privileged_session() then (select count(*) from risk_links rl join risks k using (risk_id) where rl.object_type = 'reform' and rl.object_id = r.reform_id and k.status <> 'closed' and k.inherent_score >= 15) end as risks_high,
         case when is_internal() or is_privileged_session() then (select count(*) from decision_links dl join decisions d using (decision_id) where dl.object_type = 'reform' and dl.object_id = r.reform_id and d.status = 'open') end as decisions_open,
         coalesce(r.rag_override,
           case when count(*) filter (where f.rag = 'red') > 0 then 'red'
                when count(*) filter (where f.rag = 'amber') > 0 then 'amber'
                when count(f.object_id) = 0 then 'grey' else 'green' end) as rag
    from reforms r left join v_delivery_flags f on f.reform_id = r.reform_id
   group by r.reform_id;

alter view v_delivery_items set (security_invoker = on);
alter view v_delivery_flags set (security_invoker = on);
alter view v_dq_user_metrics set (security_invoker = on);
alter view v_dq_rule_failures set (security_invoker = on);
alter view v_dq_time_to_fix set (security_invoker = on);

revoke execute on function is_allowed_email(text) from public;
comment on function is_allowed_email(text) is 'internal: sign-in allowlist check, called by the server after the identity provider returns';
