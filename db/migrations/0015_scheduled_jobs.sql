-- 0015: scheduled jobs (build step 12, spec 01 section 10, decisions 47 to 52).
--
-- Four jobs, each a function of the day it runs for, so tests can run them on fixed dates:
--   job_nightly(day)     stale reminders, P (pathway stalled), resolve escalations that moved
--   job_daily(day)       due soon (level 0), overdue escalations (levels 1 to 3), risk reviews (R),
--                        and the Secretariat's list of reminders for owners without accounts
--   job_weekly(day)      one weekly digest notice per person who owns open items, and per admin
--   job_month_end(day)   freeze one snapshot row per reform (docs/02 section 8)
-- Reminders go out at each step of the ladder, not every day (decision 48). The app sends the
-- emails after the job commits (src/lib/jobs), one per person per day; each is logged as an
-- 'email_sent' row (object_type 'daily' or 'weekly', object_id the day).

-- ---------------------------------------------------------------------------
-- Notices: the day a job raised them, details for the message, and the new kinds.
-- ---------------------------------------------------------------------------
alter table notification_log add column for_date date;
alter table notification_log add column detail jsonb;
alter table notification_log drop constraint notification_log_kind_check;
alter table notification_log add constraint notification_log_kind_check check (kind in (
  'due_soon','overdue','escalation','weekly_digest','approval_needed','submission_approved','submission_returned',
  'gate_rejected','stale_item','training_suggested','entered_on_behalf',
  'risk_review','pathway_stalled','follow_up_list','email_sent'));
-- Once a day per kind, item and person, by the day the job ran for (or the day it was sent).
drop index notification_once_per_day;
create unique index notification_once_per_day on notification_log
  (kind, person_id, object_type, object_id, coalesce(for_date, (sent_at at time zone 'UTC')::date));

-- People can turn off the daily reminder email; notices and the weekly digest stay (decision 51).
alter table people add column email_reminders boolean not null default true;

create or replace function set_my_email_reminders(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_person uuid := (me()).person_id;
begin
  if v_person is null or p_on is null then
    perform workflow_error('W05', null, null, null, 'only a signed-in user can change their email setting');
  end if;
  update people set email_reminders = p_on, updated_at = now() where person_id = v_person;
end $$;

-- ---------------------------------------------------------------------------
-- The job log. Written by the server only; admins read it on the Jobs page.
-- ---------------------------------------------------------------------------
create table job_runs (
  job_run_id   uuid primary key default gen_random_uuid(),
  job          text not null check (job in ('nightly','daily','weekly','month_end')),
  run_for      date not null,
  triggered_by text not null check (triggered_by in ('schedule','admin')),
  triggered_by_user uuid references app_users,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','succeeded','failed','skipped')),
  counts       jsonb,
  error        text
);
create index on job_runs (started_at desc);
alter table job_runs enable row level security;
create policy job_runs_read on job_runs for select using (is_admin());

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Open delivery items as they stand on a given day (v_delivery_flags uses today's date).
create or replace function job_open_items(p_today date)
returns table (object_type text, object_id text, reform_id text, name text, owner_person_id uuid, workstream_id text,
               due_date date, days_overdue int, days_since_update int)
language sql stable security definer set search_path = public as $$
  select i.object_type, i.object_id, i.reform_id, i.name, i.owner_person_id, i.workstream_id, i.due_date,
         greatest(p_today - i.due_date, 0), p_today - coalesce(i.last_confirmed_at, i.updated_at)::date
    from v_delivery_items i
   where i.status not in ('complete', 'cancelled')
$$;

-- Escalation level for days overdue (spec 01 section 10): 1 day, 7 days, 14 days.
create or replace function overdue_level(p_days int) returns int language sql immutable as $$
  select case when p_days >= 14 then 3 when p_days >= 7 then 2 when p_days >= 1 then 1 else 0 end
$$;

-- Who hears about an item one step up: the workstream owner, or the reform leads for a
-- workstream (or when the workstream has no other owner), or programme admins for
-- programme-wide milestones. Never the item's own owner.
create or replace function item_leads(p_object_type text, p_workstream text, p_reform text, p_owner uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  with ws as (
    select w.owner_person_id from workstreams w
     where p_object_type <> 'workstream' and w.workstream_id = p_workstream and w.owner_person_id is distinct from p_owner)
  select owner_person_id from ws where owner_person_id is not null
  union
  select u.person_id from app_users u join user_reform_scope s using (user_id)
   where p_reform is not null and not exists (select 1 from ws where owner_person_id is not null)
     and u.is_active and u.app_role = 'reform_lead' and s.reform_id = p_reform and u.person_id is distinct from p_owner
  union
  select u.person_id from app_users u
   where p_reform is null and u.is_active and u.app_role = 'programme_admin' and u.person_id is distinct from p_owner
$$;

create or replace function job_notify(p_kind text, p_person uuid, p_object_type text, p_object_id text, p_today date, p_detail jsonb)
returns int language sql security definer set search_path = public as $$
  with sent as (
    insert into notification_log (kind, person_id, channel, object_type, object_id, status, for_date, detail)
    select p_kind, p_person, 'in_app', p_object_type, p_object_id, 'queued', p_today, p_detail
     where p_person is not null and exists (select 1 from people p where p.person_id = p_person and p.is_active)
    on conflict do nothing
    returning 1)
  select count(*)::int from sent
$$;

-- ---------------------------------------------------------------------------
-- Nightly: staleness, pathway stalled (P), and resolving escalations whose item has moved.
-- ---------------------------------------------------------------------------
create or replace function job_nightly(p_today date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_stale int := 0; v_stalled int := 0; v_resolved int := 0; v_reviews boolean; r record;
begin
  -- S: not confirmed for over 30 days. Remind at the first night, then weekly.
  for r in
    select i.* from job_open_items(p_today) i
     where i.days_since_update > 30 and i.owner_person_id is not null
       and not exists (select 1 from notification_log n
                        where n.kind = 'stale_item' and n.person_id = i.owner_person_id and n.object_type = i.object_type
                          and n.object_id = i.object_id and n.for_date > p_today - 7)
  loop
    v_stale := v_stale + job_notify('stale_item', r.owner_person_id, r.object_type, r.object_id, p_today, jsonb_build_object('days', r.days_since_update));
  end loop;

  -- P: a stage in progress across two monthly reviews, or for 60 days while no review is recorded.
  v_reviews := exists (select 1 from reviews where review_type = 'monthly_pillar_review' and review_date <= p_today);
  for r in
    select s.stage_record_id, s.responsible_person_id from reform_stages s
     where s.status in ('in_progress', 'blocked') and s.exit_date is null and s.entry_date is not null
       and case when v_reviews
                then (select count(*) from reviews v where v.review_type = 'monthly_pillar_review' and v.review_date > s.entry_date and v.review_date <= p_today) >= 2
                else s.entry_date <= p_today - 60 end
  loop
    insert into escalations (object_type, object_id, level, reason, notified_person_ids)
    values ('reform_stage', r.stage_record_id, 2, 'pathway_stalled', array_remove(array[r.responsible_person_id], null))
    on conflict do nothing;
    if found then
      v_stalled := v_stalled + 1;
      perform job_notify('pathway_stalled', r.responsible_person_id, 'reform_stage', r.stage_record_id, p_today, null);
    end if;
  end loop;

  -- Resolve: the item is done, re-planned or no longer at that level; the stage has moved on.
  with moved as (
    update escalations e set resolved_at = now(), resolution_note = 'moved'
     where e.resolved_at is null and e.reason like 'overdue_%'
       and not exists (select 1 from job_open_items(p_today) i
                        where i.object_type = e.object_type and i.object_id = e.object_id and overdue_level(i.days_overdue) >= e.level)
    returning 1)
  select count(*) into v_resolved from moved;
  with moved as (
    update escalations e set resolved_at = now(), resolution_note = 'moved'
     where e.resolved_at is null and e.reason = 'pathway_stalled'
       and not exists (select 1 from reform_stages s where s.stage_record_id = e.object_id
                          and s.status in ('in_progress', 'blocked') and s.exit_date is null)
    returning 1)
  select v_resolved + count(*) into v_resolved from moved;

  return jsonb_build_object('stale_reminders', v_stale, 'stages_stalled', v_stalled, 'escalations_resolved', v_resolved);
end $$;

-- ---------------------------------------------------------------------------
-- Daily: due soon (0), overdue escalations (1 to 3), risk reviews (R), the Secretariat's list.
-- ---------------------------------------------------------------------------
create or replace function job_daily(p_today date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_due int := 0; v_raised int := 0; v_notices int := 0; v_risks int := 0; v_lists int := 0;
        v_level int; v_lead uuid; v_notified uuid[]; v_follow int; r record;
begin
  -- 0: due within 3 days. Once per due date.
  for r in
    select i.* from job_open_items(p_today) i
     where i.due_date between p_today and p_today + 3 and i.owner_person_id is not null
       and not exists (select 1 from notification_log n
                        where n.kind = 'due_soon' and n.person_id = i.owner_person_id and n.object_type = i.object_type
                          and n.object_id = i.object_id and n.detail ->> 'due_date' = i.due_date::text)
  loop
    v_due := v_due + job_notify('due_soon', r.owner_person_id, r.object_type, r.object_id, p_today, jsonb_build_object('due_date', r.due_date));
  end loop;

  -- 1 to 3: one open escalation per item, at its current level. Owner and lead hear at each step.
  for r in select i.* from job_open_items(p_today) i where overdue_level(i.days_overdue) > 0 loop
    v_level := overdue_level(r.days_overdue);
    continue when exists (select 1 from escalations e where e.object_type = r.object_type and e.object_id = r.object_id
                             and e.resolved_at is null and e.reason like 'overdue_%' and e.level >= v_level);
    update escalations set resolved_at = now(), resolution_note = 'raised to level ' || v_level
     where object_type = r.object_type and object_id = r.object_id and resolved_at is null and reason like 'overdue_%' and level < v_level;
    v_notified := array_remove(array[r.owner_person_id], null);
    v_notices := v_notices + job_notify('overdue', r.owner_person_id, r.object_type, r.object_id, p_today,
                                        jsonb_build_object('level', v_level, 'days', r.days_overdue));
    for v_lead in select * from item_leads(r.object_type, r.workstream_id, r.reform_id, r.owner_person_id) loop
      v_notified := v_notified || v_lead;
      v_notices := v_notices + job_notify('escalation', v_lead, r.object_type, r.object_id, p_today,
                                          jsonb_build_object('level', v_level, 'days', r.days_overdue));
    end loop;
    insert into escalations (object_type, object_id, level, reason, notified_person_ids)
    values (r.object_type, r.object_id, v_level, 'overdue_' || (array[1, 7, 14])[v_level], v_notified);
    v_raised := v_raised + 1;
  end loop;

  -- R: open risks past their review date. Weekly.
  for r in
    select k.risk_id, k.owner_person_id, k.review_date from risks k
     where k.status <> 'closed' and k.review_date < p_today and k.owner_person_id is not null
       and not exists (select 1 from notification_log n where n.kind = 'risk_review' and n.person_id = k.owner_person_id
                          and n.object_type = 'risk' and n.object_id = k.risk_id and n.for_date > p_today - 7)
  loop
    v_risks := v_risks + job_notify('risk_review', r.owner_person_id, 'risk', r.risk_id, p_today, jsonb_build_object('review_date', r.review_date));
  end loop;

  -- Owners without an account cannot read their notices: the Secretariat follows up (decision 49).
  select count(*) into v_follow from notification_log n
   where n.for_date = p_today and n.channel = 'in_app'
     and n.kind in ('due_soon', 'overdue', 'escalation', 'stale_item', 'risk_review', 'pathway_stalled')
     and not exists (select 1 from app_users u where u.person_id = n.person_id and u.is_active);
  if v_follow > 0 then
    for r in select u.person_id from app_users u where u.is_active and u.app_role = 'programme_admin' loop
      v_lists := v_lists + job_notify('follow_up_list', r.person_id, 'date', p_today::text, p_today, jsonb_build_object('reminders', v_follow));
    end loop;
  end if;

  return jsonb_build_object('due_soon', v_due, 'escalations_raised', v_raised, 'escalation_notices', v_notices,
                            'risk_reviews', v_risks, 'follow_up_lists', v_lists);
end $$;

-- ---------------------------------------------------------------------------
-- Weekly digest: one notice per person who owns open items or is an admin (spec 01 section 10).
-- The app writes the digest itself when it sends the email.
-- ---------------------------------------------------------------------------
create or replace function job_weekly(p_today date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sent int := 0; r record;
begin
  for r in
    select u.person_id from app_users u
     where u.is_active and (u.app_role in ('super_admin', 'programme_admin')
                            or exists (select 1 from job_open_items(p_today) i where i.owner_person_id = u.person_id))
  loop
    v_sent := v_sent + job_notify('weekly_digest', r.person_id, 'date', p_today::text, p_today, null);
  end loop;
  return jsonb_build_object('digests', v_sent);
end $$;

-- ---------------------------------------------------------------------------
-- Month end: freeze one row per reform. Never overwritten (docs/02 section 8).
-- ---------------------------------------------------------------------------
create or replace function job_month_end(p_month_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_frozen int;
begin
  if p_month_end <> (date_trunc('month', p_month_end) + interval '1 month - 1 day')::date then
    raise exception 'J01: % is not the last day of a month', p_month_end;
  end if;
  with frozen as (
    insert into reform_status_snapshots (snapshot_date, reform_id, current_stage, status_rag, milestones_due, milestones_overdue,
                                         risks_open, risks_high, decisions_pending)
    select p_month_end, s.reform_id, s.current_stage, s.rag, s.milestones_due_30d,
           (select count(*) from v_delivery_flags f where f.reform_id = s.reform_id and f.object_type = 'milestone' and f.days_overdue > 0),
           s.risks_open, s.risks_high, s.decisions_open
      from v_reform_summary s
    on conflict do nothing
    returning 1)
  select count(*) into v_frozen from frozen;
  return jsonb_build_object('snapshots', v_frozen);
end $$;

do $$
declare f text;
begin
  foreach f in array array['job_open_items(date)', 'overdue_level(integer)', 'item_leads(text, text, text, uuid)',
                           'job_notify(text, uuid, text, text, date, jsonb)', 'job_nightly(date)', 'job_daily(date)',
                           'job_weekly(date)', 'job_month_end(date)'] loop
    execute format('revoke execute on function %s from public', f);
    execute format('comment on function %s is %L', f, 'internal: scheduled jobs');
  end loop;
end $$;
