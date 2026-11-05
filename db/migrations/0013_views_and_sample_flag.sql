-- 0013: the Executive and Pathway views (build step 10).
--   1. is_sample on delivery items and people (decision 39). Sample records exist only for a demo
--      when real data is missing; every screen shows them as "Sample" (CLAUDE.md rule 11).
--   2. v_delivery_items and v_delivery_flags carry is_sample (added at the end; same rows).
--   3. quality_trend(): the monthly average gate score across everyone, for internal users.
--      Never per person: per-user data quality stays private (docs/03 section 8).

alter table workstreams add column is_sample boolean not null default false;
alter table deliverables add column is_sample boolean not null default false;
alter table activities add column is_sample boolean not null default false;
alter table milestones add column is_sample boolean not null default false;
alter table people add column is_sample boolean not null default false;

create or replace view v_delivery_items with (security_invoker = on) as
  select 'workstream'::text as object_type, w.workstream_id as object_id, w.reform_id, w.name, w.owner_person_id, w.start_date, w.due_date, w.forecast_date,
         w.actual_date, w.status, w.progress_pct, w.next_action, w.blocker, w.updated_at, w.last_confirmed_at,
         coalesce(w.rag_override, computed_rag(w.status, w.start_date, w.due_date, w.forecast_date, w.progress_pct)) as rag,
         w.workstream_id as workstream_id, null::text as deliverable_id, w.is_sample
    from workstreams w where w.archived_at is null
  union all
  select 'deliverable', d.deliverable_id, w.reform_id, d.name, d.owner_person_id, d.start_date, d.due_date, d.forecast_date, d.actual_date, d.status,
         d.progress_pct, d.next_action, d.blocker, d.updated_at, d.last_confirmed_at,
         coalesce(d.rag_override, computed_rag(d.status, d.start_date, d.due_date, d.forecast_date, d.progress_pct)), w.workstream_id, d.deliverable_id, d.is_sample
    from deliverables d join workstreams w using (workstream_id) where d.archived_at is null
  union all
  select 'activity', a.activity_id, w.reform_id, a.name, a.owner_person_id, a.start_date, a.due_date, a.forecast_date, a.actual_date, a.status,
         a.progress_pct, a.next_action, a.blocker, a.updated_at, a.last_confirmed_at,
         computed_rag(a.status, a.start_date, a.due_date, a.forecast_date, a.progress_pct), w.workstream_id, d.deliverable_id, a.is_sample
    from activities a join deliverables d using (deliverable_id) join workstreams w using (workstream_id) where a.archived_at is null
  union all
  select 'milestone', m.milestone_id, m.reform_id, m.name, m.owner_person_id, null, m.planned_date, m.forecast_date, m.actual_date, m.status,
         case m.status when 'complete' then 100 when 'not_started' then 0 end, m.next_action, m.blocker, m.updated_at, m.last_confirmed_at,
         computed_rag(m.status, null, m.planned_date, m.forecast_date, null), null, m.deliverable_id, m.is_sample
    from milestones m where m.archived_at is null;

create or replace view v_delivery_flags with (security_invoker = on) as
  select i.object_type, i.object_id, i.reform_id, i.name, i.owner_person_id, i.start_date, i.due_date, i.forecast_date, i.actual_date,
         i.status, i.progress_pct, i.next_action, i.blocker, i.updated_at, i.last_confirmed_at, i.rag, i.workstream_id, i.deliverable_id,
         case when i.status not in ('complete','cancelled') and i.due_date < current_date then current_date - i.due_date else 0 end as days_overdue,
         case when i.status not in ('complete','cancelled') and i.due_date >= current_date then i.due_date - current_date end as days_to_due,
         current_date - coalesce(i.last_confirmed_at, i.updated_at)::date as days_since_update,
         (current_date - coalesce(i.last_confirmed_at, i.updated_at)::date) > 30 as is_stale,
         i.is_sample
    from v_delivery_items i;

create or replace function quality_trend(p_months int default 12)
returns table (month date, average_score numeric, runs int, first_time_pass_rate numeric)
language sql stable security definer set search_path = public as $$
  select date_trunc('month', r.started_at at time zone 'Africa/Kinshasa')::date,
         round(avg(r.quality_score), 1),
         count(*)::int,
         round(100.0 * count(*) filter (where r.attempt_no = 1 and r.outcome = 'pass') / nullif(count(*) filter (where r.attempt_no = 1), 0), 1)
    from dq_runs r
   where is_internal() and r.quality_score is not null
     and r.started_at >= date_trunc('month', now()) - make_interval(months => p_months - 1)
   group by 1
   order by 1
$$;
