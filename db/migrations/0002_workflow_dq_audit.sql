-- 0002: submissions (propose then approve), the data quality gate, audit log,
-- notifications, ID generation and computed views.

-- ---------------------------------------------------------------------------
-- Submissions: every change from every route goes through here first.
-- Live tables are written only when a submission is approved.
-- ---------------------------------------------------------------------------
create table upload_batches (
  batch_id       uuid primary key default gen_random_uuid(),
  file_name      text not null,
  file_path      text not null,            -- object storage key of the original file (kept for audit)
  file_sha256    text not null,
  file_bytes     bigint not null,
  template_version text,
  sheets_found   text[],
  uploaded_by    uuid not null references app_users,
  on_behalf_of_person_id uuid references people,
  uploaded_at    timestamptz not null default now()
);

create table dq_rulesets (
  ruleset_version text primary key,          -- e.g. '1.0.0'
  effective_from  date not null,
  rules           jsonb not null,            -- full contents of rules/dq_rules.vX.json
  checksum_sha256 text not null,
  approved_by     text,
  is_current      boolean not null default false
);
create unique index dq_rulesets_one_current on dq_rulesets (is_current) where is_current;

create table submissions (
  submission_id  uuid primary key default gen_random_uuid(),
  route          text not null check (route in ('web_form','bulk_upload','on_behalf')),
  batch_id       uuid references upload_batches,
  submitted_by   uuid not null references app_users,
  on_behalf_of_person_id uuid references people,     -- required when route = on_behalf
  entity         text,                               -- null for multi-sheet bulk uploads
  payload        jsonb not null,                     -- staged rows exactly as they will be applied
  dq_run_id      uuid,                               -- latest run (fk below)
  status         text not null default 'draft' check (status in ('draft','rejected_by_gate','proposed','approved','returned','withdrawn','applied')),
  reviewer       uuid references app_users,
  reviewed_at    timestamptz,
  review_note    text,
  applied_at     timestamptz,
  previous_submission_id uuid references submissions,  -- retry chain after a gate rejection or return
  created_at     timestamptz not null default now(),
  check (route <> 'on_behalf' or on_behalf_of_person_id is not null),
  check (route <> 'bulk_upload' or batch_id is not null)
);

create table dq_runs (
  dq_run_id       uuid primary key default gen_random_uuid(),
  submission_id   uuid not null references submissions on delete cascade,
  attempt_no      int not null,                 -- 1, 2, 3 ... within a retry chain
  previous_run_id uuid references dq_runs,
  ruleset_version text not null references dq_rulesets,
  route           text not null,
  run_by          uuid not null references app_users,
  on_behalf_of_person_id uuid references people,
  started_at      timestamptz not null default now(),
  duration_ms     int,
  rows_total      int not null default 0,
  rows_with_blocking int not null default 0,
  file_failures   int not null default 0,
  blocking_failures int not null default 0,
  scored_checks_applicable numeric not null default 0,  -- weighted
  scored_checks_passed     numeric not null default 0,  -- weighted
  quality_score   numeric(5,1),                          -- 0.0 to 100.0
  threshold       numeric(5,1) not null,
  outcome         text not null check (outcome in ('pass','reject')),
  reject_reason   text check (reject_reason in ('file_rules','blocking_rules','score_below_threshold','blocking_and_score'))
);
alter table submissions add constraint submissions_dq_fk foreign key (dq_run_id) references dq_runs;

create table dq_findings (
  finding_id  bigserial primary key,
  dq_run_id   uuid not null references dq_runs on delete cascade,
  rule_id     text not null,                    -- F01, B03, Q10, X01 ...
  tier        text not null check (tier in ('file','blocking','scored','autofix')),
  severity    text not null check (severity in ('error','warning','fixed')),
  entity      text, sheet text, row_ref int, field text, cell text,
  value_seen  text,
  message_en  text not null,
  message_fr  text not null,
  weight      numeric
);
create index on dq_findings (dq_run_id);
create index on dq_findings (rule_id);

-- ---------------------------------------------------------------------------
-- Audit log: before and after for every change to a business table
-- ---------------------------------------------------------------------------
create table audit_log (
  audit_id    bigserial primary key,
  table_name  text not null,
  record_id   text not null,
  action      text not null check (action in ('insert','update','delete')),
  before      jsonb,
  after       jsonb,
  actor_user_id uuid,
  on_behalf_of_person_id uuid,
  submission_id uuid,
  at          timestamptz not null default now()
);
create index on audit_log (table_name, record_id);

-- The application sets these per transaction when it applies an approved submission:
--   set local app.actor_user_id = '<uuid>'; set local app.on_behalf_of = '<uuid>'; set local app.submission_id = '<uuid>';
create or replace function audit_row() returns trigger language plpgsql security definer set search_path = public as $$
declare pk text; rec jsonb;
begin
  rec := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  pk := coalesce(rec ->> tg_argv[0], '?');
  insert into audit_log (table_name, record_id, action, before, after, actor_user_id, on_behalf_of_person_id, submission_id)
  values (tg_table_name, pk, lower(tg_op),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
          nullif(current_setting('app.actor_user_id', true), '')::uuid,
          nullif(current_setting('app.on_behalf_of', true), '')::uuid,
          nullif(current_setting('app.submission_id', true), '')::uuid);
  return null;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('reforms','reform_id'),('workstreams','workstream_id'),('deliverables','deliverable_id'),('activities','activity_id'),
    ('milestones','milestone_id'),('reform_stages','stage_record_id'),('risks','risk_id'),('decisions','decision_id'),
    ('actions','action_id'),('adaptations','adaptation_id'),('evidence_items','evidence_id'),('indicators','indicator_code'),
    ('indicator_values','value_id'),('readiness_assessments','readiness_id'),('app_users','user_id'),('user_reform_scope','user_id'),
    ('reporting_periods','period_end'),('dq_rulesets','ruleset_version')) as t(tbl, pk)
  loop
    execute format('create trigger %I_audit after insert or update or delete on %I for each row execute function audit_row(%L)', r.tbl, r.tbl, r.pk);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Notifications (reminders, escalations, digests) and their delivery log
-- ---------------------------------------------------------------------------
create table notification_log (
  notification_id uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('due_soon','overdue','escalation','weekly_digest','approval_needed','submission_returned','gate_rejected','stale_item','training_suggested')),
  person_id   uuid references people,
  channel     text not null check (channel in ('email','in_app')),
  object_type text, object_id text,
  subject     text, body_preview text,
  sent_at     timestamptz not null default now(),
  provider_message_id text,
  status      text not null default 'sent' check (status in ('queued','sent','failed'))
);
-- Never send the same reminder kind for the same object to the same person twice in one day.
create unique index notification_once_per_day on notification_log (kind, person_id, object_type, object_id, ((sent_at at time zone 'UTC')::date));

-- ---------------------------------------------------------------------------
-- ID generation for items created without an ID (web form, or blank ID in upload)
-- ---------------------------------------------------------------------------
create or replace function next_child_id(p_entity text, p_reform text) returns text language plpgsql as $$
declare n int;
begin
  if p_entity = 'workstream' then
    select coalesce(max(substring(workstream_id from '..$')::int), 0) + 1 into n from workstreams where reform_id = p_reform;
    return format('WS-%s-%s', p_reform, lpad(n::text, 2, '0'));
  elsif p_entity = 'deliverable' then
    select coalesce(max(substring(deliverable_id from '...$')::int), 0) + 1 into n from deliverables where deliverable_id like 'DL-' || p_reform || '-%';
    return format('DL-%s-%s', p_reform, lpad(n::text, 3, '0'));
  elsif p_entity = 'activity' then
    select coalesce(max(substring(activity_id from '....$')::int), 0) + 1 into n from activities where activity_id like 'AC-' || p_reform || '-%';
    return format('AC-%s-%s', p_reform, lpad(n::text, 4, '0'));
  end if;
  raise exception 'next_child_id: unsupported entity %', p_entity;
end $$;
create sequence action_seq start 1;
create sequence milestone_seq start 200;   -- 001-020 used by master, 101-112 by PoC imports
create sequence evidence_seq start 100;
create sequence risk_seq start 200;
create sequence decision_seq start 100;

-- ---------------------------------------------------------------------------
-- Computed views. RAG is calculated, never typed, unless overridden with a reason.
-- Rule (v1, to confirm with Project Lead):
--   blue  = complete
--   grey  = not_started and start date not reached (or no dates)
--   red   = blocked, or overdue by more than 14 days, or not_started 14+ days after start date
--   amber = at_risk or delayed, or overdue 1 to 14 days, or due within 7 days with progress < 50
--   green = otherwise
-- ---------------------------------------------------------------------------
create or replace function computed_rag(p_status text, p_start date, p_due date, p_forecast date, p_progress int) returns text
language sql immutable as $$
  select case
    when p_status in ('complete') then 'blue'
    when p_status = 'cancelled' then 'grey'
    when p_status = 'blocked' then 'red'
    when p_due is not null and p_status <> 'complete' and current_date - p_due > 14 then 'red'
    when p_status = 'not_started' and p_start is not null and current_date - p_start >= 14 then 'red'
    when p_status in ('at_risk','delayed') then 'amber'
    when p_due is not null and current_date > p_due then 'amber'
    when p_due is not null and p_due - current_date <= 7 and coalesce(p_progress, 0) < 50 then 'amber'
    when p_status = 'not_started' then 'grey'
    else 'green' end
$$;

create or replace view v_delivery_items as
  select 'workstream'::text as object_type, w.workstream_id as object_id, w.reform_id, w.name, w.owner_person_id, w.start_date, w.due_date, w.forecast_date,
         w.actual_date, w.status, w.progress_pct, w.next_action, w.blocker, w.updated_at, w.last_confirmed_at,
         coalesce(w.rag_override, computed_rag(w.status, w.start_date, w.due_date, w.forecast_date, w.progress_pct)) as rag,
         w.workstream_id as workstream_id, null::text as deliverable_id
    from workstreams w where w.archived_at is null
  union all
  select 'deliverable', d.deliverable_id, w.reform_id, d.name, d.owner_person_id, d.start_date, d.due_date, d.forecast_date, d.actual_date, d.status,
         d.progress_pct, d.next_action, d.blocker, d.updated_at, d.last_confirmed_at,
         coalesce(d.rag_override, computed_rag(d.status, d.start_date, d.due_date, d.forecast_date, d.progress_pct)), w.workstream_id, d.deliverable_id
    from deliverables d join workstreams w using (workstream_id) where d.archived_at is null
  union all
  select 'activity', a.activity_id, w.reform_id, a.name, a.owner_person_id, a.start_date, a.due_date, a.forecast_date, a.actual_date, a.status,
         a.progress_pct, a.next_action, a.blocker, a.updated_at, a.last_confirmed_at,
         computed_rag(a.status, a.start_date, a.due_date, a.forecast_date, a.progress_pct), w.workstream_id, d.deliverable_id
    from activities a join deliverables d using (deliverable_id) join workstreams w using (workstream_id) where a.archived_at is null
  union all
  select 'milestone', m.milestone_id, m.reform_id, m.name, m.owner_person_id, null, m.planned_date, m.forecast_date, m.actual_date, m.status,
         case m.status when 'complete' then 100 when 'not_started' then 0 end, m.next_action, m.blocker, m.updated_at, m.last_confirmed_at,
         computed_rag(m.status, null, m.planned_date, m.forecast_date, null), null, m.deliverable_id
    from milestones m where m.archived_at is null;

-- Days overdue and staleness, used by escalations, the inbox and Q04/Q23.
create or replace view v_delivery_flags as
  select i.*,
         case when i.status not in ('complete','cancelled') and i.due_date < current_date then current_date - i.due_date else 0 end as days_overdue,
         case when i.status not in ('complete','cancelled') and i.due_date >= current_date then i.due_date - current_date end as days_to_due,
         current_date - coalesce(i.last_confirmed_at, i.updated_at)::date as days_since_update,
         (current_date - coalesce(i.last_confirmed_at, i.updated_at)::date) > 30 as is_stale
    from v_delivery_items i;

-- Reform roll-up for the Executive and Portfolio views.
create or replace view v_reform_summary as
  select r.reform_id, r.name_en, r.current_stage,
         count(*) filter (where f.object_type = 'milestone' and f.status not in ('complete','cancelled') and f.due_date <= current_date + 30) as milestones_due_30d,
         count(*) filter (where f.days_overdue > 0) as items_overdue,
         count(*) filter (where f.is_stale and f.status not in ('complete','cancelled')) as items_stale,
         count(*) filter (where f.rag = 'red') as items_red,
         count(*) filter (where f.rag = 'amber') as items_amber,
         (select count(*) from risk_links rl join risks k using (risk_id) where rl.object_type = 'reform' and rl.object_id = r.reform_id and k.status <> 'closed') as risks_open,
         (select count(*) from risk_links rl join risks k using (risk_id) where rl.object_type = 'reform' and rl.object_id = r.reform_id and k.status <> 'closed' and k.inherent_score >= 15) as risks_high,
         (select count(*) from decision_links dl join decisions d using (decision_id) where dl.object_type = 'reform' and dl.object_id = r.reform_id and d.status = 'open') as decisions_open,
         coalesce(r.rag_override,
           case when count(*) filter (where f.rag = 'red') > 0 then 'red'
                when count(*) filter (where f.rag = 'amber') > 0 then 'amber'
                when count(*) = 0 then 'grey' else 'green' end) as rag
    from reforms r left join v_delivery_flags f on f.reform_id = r.reform_id
   group by r.reform_id;

-- Data quality metrics for the admin page.
create or replace view v_dq_user_metrics as
  select r.run_by as user_id,
         count(*) as attempts,
         count(*) filter (where r.attempt_no = 1) as first_attempts,
         count(*) filter (where r.attempt_no = 1 and r.outcome = 'pass') as first_attempt_passes,
         round(100.0 * count(*) filter (where r.attempt_no = 1 and r.outcome = 'pass') / nullif(count(*) filter (where r.attempt_no = 1), 0), 1) as first_time_pass_rate,
         count(*) filter (where r.outcome = 'reject') as rejects,
         round(avg(r.quality_score), 1) as avg_score,
         max(r.started_at) as last_attempt_at
    from dq_runs r group by r.run_by;

-- pct_of_active_users above 30 means the rule or the template is the problem, not the people.
create or replace view v_dq_rule_failures as
  with active as (
    select date_trunc('month', started_at)::date as month, count(distinct run_by) as active_users from dq_runs group by 1),
  fails as (
    select f.rule_id, f.tier, date_trunc('month', r.started_at)::date as month,
           count(*) as failures, count(distinct r.run_by) as users_affected
      from dq_findings f join dq_runs r using (dq_run_id)
     where f.severity = 'error' group by 1, 2, 3)
  select fails.*, round(100.0 * fails.users_affected / nullif(active.active_users, 0), 1) as pct_of_active_users
    from fails join active using (month);

-- Time to fix: from first rejected attempt to the pass in the same chain.
create or replace view v_dq_time_to_fix as
  with recursive chain as (
    select dq_run_id, dq_run_id as root_id, started_at, outcome from dq_runs where previous_run_id is null
    union all
    select r.dq_run_id, c.root_id, r.started_at, r.outcome from dq_runs r join chain c on r.previous_run_id = c.dq_run_id)
  select root_id, min(started_at) as first_attempt_at,
         min(started_at) filter (where outcome = 'pass') as passed_at,
         count(*) as attempts,
         extract(epoch from (min(started_at) filter (where outcome = 'pass') - min(started_at))) / 3600 as hours_to_fix
    from chain group by root_id;
