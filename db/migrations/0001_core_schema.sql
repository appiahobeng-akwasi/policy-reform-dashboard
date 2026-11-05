-- GGP Pillar 1 Policy Reform Dashboard
-- 0001: core schema. Plain PostgreSQL 15+. No vendor-only features in this file,
-- so the same schema can run on Supabase, a self-hosted Postgres, or under Directus/NocoDB.
-- Conventions: snake_case; text IDs that people can read (RA1, MS-009); every business
-- table has created_at, updated_at, updated_by, last_confirmed_at; soft delete via archived_at.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Lookups (labels in English and French). Values are also enforced by CHECKs.
-- ---------------------------------------------------------------------------
create table lookup_values (
  list_name   text not null,
  code        text not null,
  label_en    text not null,
  label_fr    text not null,
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  primary key (list_name, code)
);

create table pathway_stages (
  code       text primary key,
  label_en   text not null,
  label_fr   text not null,
  sort_order int  not null unique
);

-- ---------------------------------------------------------------------------
-- People, institutions, users
-- ---------------------------------------------------------------------------
create table institutions (
  institution_id   uuid primary key default gen_random_uuid(),
  name             text not null unique,
  acronym          text,
  institution_type text check (institution_type in ('government','donor','private_sector','consortium','civil_society','other')),
  priority         text check (priority in ('high','medium','low')),
  role_in_programme text,
  engagement_status text,
  notes            text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table people (
  person_id      uuid primary key default gen_random_uuid(),
  full_name      text not null,
  email          text unique,               -- personal Gmail etc. is expected and allowed
  phone          text,
  institution_id uuid references institutions,
  role_title     text,
  preferred_language text not null default 'en' check (preferred_language in ('fr','en')),
  is_active      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per person allowed to sign in. auth_user_id is the identity provider's user id
-- (Supabase auth.users.id in the prototype). Sign-in is refused if the email is not here.
create table app_users (
  user_id      uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  person_id    uuid not null unique references people,
  email        text not null unique,
  app_role     text not null check (app_role in ('super_admin','programme_admin','reform_lead','contributor','merl_officer','viewer_internal','viewer_counterpart')),
  mfa_required boolean not null default false,  -- forced true for super_admin and programme_admin by trigger in 0003
  is_active    boolean not null default true,
  invited_at   timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Delivery spine: Reform -> Workstream -> Deliverable -> Activity, plus Milestones
-- ---------------------------------------------------------------------------
create table reforms (
  reform_id          text primary key check (reform_id ~ '^RA[0-9]$'),
  name_en            text not null,
  name_fr            text,
  name_tor           text,
  title              text,
  objective          text,
  systemic_constraint text,
  hypothesis         text,
  priority           text check (priority in ('high','medium','low')),
  sequence_category  text check (sequence_category in ('quick_win','catalytic','structural')),
  current_stage      text references pathway_stages(code),
  rag_override       text check (rag_override in ('green','amber','red','grey','blue')),
  rag_override_reason text,
  lead_institutions  text,
  technical_focal_point text,
  political_champion text,
  decision_body      text,
  next_milestone     text,
  target_date        date,
  current_bottleneck text,
  scope_note         text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references app_users,
  last_confirmed_at timestamptz
);

-- Which reforms a user may write to (and, for counterparts, read).
create table user_reform_scope (
  user_id   uuid not null references app_users on delete cascade,
  reform_id text not null references reforms,
  can_approve boolean not null default false,
  primary key (user_id, reform_id)
);

create table workstreams (
  workstream_id   text primary key check (workstream_id ~ '^WS-RA[0-9]-[0-9]{2}$'),
  reform_id       text not null references reforms,
  name            text not null,
  workstream_type text not null check (workstream_type in ('policy','technical','stakeholder','implementation')),
  owner_person_id uuid references people,
  lead_institution_id uuid references institutions,
  start_date date, due_date date, forecast_date date, actual_date date,
  status        text not null default 'not_started' check (status in ('not_started','on_track','at_risk','delayed','blocked','complete','cancelled')),
  progress_pct  int check (progress_pct between 0 and 100),
  rag_override  text check (rag_override in ('green','amber','red','grey','blue')),
  rag_override_reason text,
  next_action text, blocker text, comments text,
  archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users, last_confirmed_at timestamptz,
  check (start_date is null or due_date is null or start_date <= due_date)
);

create table deliverables (
  deliverable_id  text primary key check (deliverable_id ~ '^DL-RA[0-9]-[0-9]{3}$'),
  workstream_id   text not null references workstreams,
  name            text not null,
  description     text,
  owner_person_id uuid references people,
  start_date date, due_date date, forecast_date date, actual_date date,
  status        text not null default 'not_started' check (status in ('not_started','on_track','at_risk','delayed','blocked','complete','cancelled')),
  progress_pct  int check (progress_pct between 0 and 100),
  evidence_required text,
  evidence_confidence text check (evidence_confidence in ('high','medium','low')),
  rag_override  text check (rag_override in ('green','amber','red','grey','blue')),
  rag_override_reason text,
  next_action text, blocker text, comments text,
  archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users, last_confirmed_at timestamptz,
  check (start_date is null or due_date is null or start_date <= due_date)
);

create table activities (
  activity_id     text primary key check (activity_id ~ '^AC-RA[0-9]-[0-9]{4}$'),
  deliverable_id  text not null references deliverables,
  name            text not null,
  owner_person_id uuid references people,
  start_date date, due_date date, forecast_date date, actual_date date,
  status        text not null default 'not_started' check (status in ('not_started','on_track','at_risk','delayed','blocked','complete','cancelled')),
  progress_pct  int check (progress_pct between 0 and 100),
  next_action text, blocker text, comments text,
  archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users, last_confirmed_at timestamptz,
  check (start_date is null or due_date is null or start_date <= due_date)
);

-- Milestones are decision or completion gates. Programme-wide milestones have scope='programme'
-- and no reform_id. A reform milestone may sit under a deliverable once that level exists.
create table milestones (
  milestone_id    text primary key check (milestone_id ~ '^MS-[0-9]{3}$'),
  scope           text not null default 'reform' check (scope in ('reform','programme')),
  reform_id       text references reforms,
  deliverable_id  text references deliverables,
  name            text not null,
  milestone_type  text check (milestone_type in ('legal','technical','consultation','approval','operational')),
  pathway_stage   text references pathway_stages(code),
  is_decision_gate boolean not null default false,
  owner_person_id uuid references people,
  owner_text      text,     -- legacy free text from source; replace with owner_person_id
  planned_date date, forecast_date date, actual_date date,
  status        text not null default 'not_started' check (status in ('not_started','on_track','at_risk','delayed','blocked','complete','cancelled')),
  evidence_required text,
  evidence_confidence text check (evidence_confidence in ('high','medium','low')),
  escalation_action text,
  next_action text, blocker text, comments text,
  source      text,
  needs_refresh boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users, last_confirmed_at timestamptz,
  check ((scope = 'programme' and reform_id is null) or (scope = 'reform' and reform_id is not null)),
  check (status <> 'not_started' or actual_date is null)
);

-- Reform pathway: one row per reform per stage (Pathway_Tracker).
create table reform_stages (
  stage_record_id text primary key check (stage_record_id ~ '^PT-[0-9]{3}$'),
  reform_id   text not null references reforms,
  stage       text not null references pathway_stages(code),
  entry_date date, exit_date date,
  status      text not null default 'not_started' check (status in ('not_started','in_progress','complete','blocked')),
  evidence_required text,
  validation_status text not null default 'pending' check (validation_status in ('pending','validated','rejected')),
  responsible_person_id uuid references people,
  responsible_text text,
  escalation_needed boolean not null default false,
  escalation_to text,
  comments text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users, last_confirmed_at timestamptz,
  unique (reform_id, stage),
  check (entry_date is null or exit_date is null or entry_date <= exit_date)
);

-- Generic "object reference" used by links: (object_type, object_id).
-- object_type values: reform, workstream, deliverable, activity, milestone, reform_stage,
-- risk, decision, action, adaptation, indicator, indicator_value, evidence_item.

create table dependencies (
  from_type text not null, from_id text not null,   -- the item that waits
  to_type   text not null, to_id   text not null,   -- the item it waits for
  dependency_type text not null default 'finish_to_start' check (dependency_type in ('finish_to_start','start_to_start','informs')),
  note text,
  created_at timestamptz not null default now(),
  primary key (from_type, from_id, to_type, to_id),
  check (not (from_type = to_type and from_id = to_id))
);

-- ---------------------------------------------------------------------------
-- Risks, decisions, actions, adaptations
-- ---------------------------------------------------------------------------
create table risks (
  risk_id     text primary key check (risk_id ~ '^RK-[0-9]{3}$'),
  category    text not null check (category in ('political','institutional','legal','financial','operational','data','security','stakeholder','climate','political_economy','delivery_capacity','regulatory')),
  description text not null,
  likelihood  int check (likelihood between 1 and 5),
  impact      int check (impact between 1 and 5),
  inherent_score int generated always as (likelihood * impact) stored,
  mitigation  text,
  trigger     text,
  owner_person_id uuid references people,
  owner_text  text,
  residual_likelihood int check (residual_likelihood between 1 and 5),
  residual_impact     int check (residual_impact between 1 and 5),
  residual_score int generated always as (residual_likelihood * residual_impact) stored,
  treatment   text check (treatment in ('treat','transfer','tolerate','terminate')),
  review_date date,
  status      text not null default 'open' check (status in ('open','monitoring','closed')),
  source      text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users, last_confirmed_at timestamptz
);
create table risk_links (
  risk_id text not null references risks on delete cascade,
  object_type text not null, object_id text not null,
  primary key (risk_id, object_type, object_id)
);

create table decisions (
  decision_id   text primary key check (decision_id ~ '^DC-[0-9]{3}$'),
  decision_date date not null,
  decision_type text not null check (decision_type in ('continue','adapt','escalate','pause','stop','resequence')),
  decision_body text,
  decision_maker text,
  governance_tier int check (governance_tier in (1,2,3)),   -- 1 informed, 2 reviews/endorses, 3 approves
  summary       text not null,
  reason        text,
  follow_up_action text,
  follow_up_owner_person_id uuid references people,
  follow_up_owner_text text,
  follow_up_due date,
  status        text not null default 'open' check (status in ('open','implemented','closed','cancelled')),
  pathway_stage text references pathway_stages(code),
  review_id     uuid,   -- set when taken at a review meeting (fk added below)
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users
);
create table decision_links (
  decision_id text not null references decisions on delete cascade,
  object_type text not null, object_id text not null,
  primary key (decision_id, object_type, object_id)
);

create table actions (
  action_id   text primary key check (action_id ~ '^AN-[0-9]{4}$'),
  source_type text not null check (source_type in ('decision','review','risk','escalation','adaptation','other')),
  source_id   text,
  description text not null,
  owner_person_id uuid references people,
  due_date    date,
  status      text not null default 'open' check (status in ('open','done','cancelled')),
  completed_at timestamptz,
  comments    text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users
);

create table adaptations (
  adaptation_id   text primary key check (adaptation_id ~ '^AD-[0-9]{3}$'),
  trigger_event   text not null,
  trigger_type    text check (trigger_type in ('delay','political_change','new_opportunity','risk_escalation','evidence_change','other')),
  original_plan   text,
  change_requested text not null,
  change_approved boolean,
  approval_date   date,
  approved_by     text,
  rationale       text,
  expected_impact text,
  follow_up_action text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid references app_users
);
create table adaptation_links (
  adaptation_id text not null references adaptations on delete cascade,
  object_type text not null, object_id text not null,
  primary key (adaptation_id, object_type, object_id)
);

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------
create table evidence_items (
  evidence_id   text primary key check (evidence_id ~ '^EV-[0-9]{3,4}$'),
  title         text not null,
  evidence_type text not null check (evidence_type in ('meeting_minutes','letter','draft_law','circular','memo','report','screenshot','email','signed_agreement','other')),
  source_type   text,          -- original label from source data, kept for traceability
  source_institution text,
  evidence_date date,
  file_path     text,          -- object storage key; null if external_url or reference only
  file_sha256   text unique,
  file_mime     text,
  file_bytes    bigint,
  external_url  text,
  reference_text text,         -- legacy: title-only reference from source workbook
  validation_status text not null default 'pending' check (validation_status in ('pending','validated','rejected')),
  validated_by  uuid references app_users,
  validated_at  timestamptz,
  rejection_reason text,
  access_level  text not null default 'restricted' check (access_level in ('internal','restricted','external','public')),
  pathway_stage text references pathway_stages(code),
  uploaded_by   uuid references app_users,
  uploaded_by_text text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table evidence_links (
  evidence_id text not null references evidence_items on delete cascade,
  object_type text not null, object_id text not null,
  relevance_note text,
  primary key (evidence_id, object_type, object_id)
);

-- ---------------------------------------------------------------------------
-- MERL: indicators (all pillars in the logframe), values, disaggregation, learning
-- ---------------------------------------------------------------------------
create table indicators (
  indicator_code text primary key check (indicator_code ~ '^[OP][0-9]\.[0-9]{1,2}$'),
  result_level   text not null check (result_level in ('output','outcome','process','readiness','uptake')),
  name_en        text not null,
  name_fr        text,
  definition     text,
  programme_area text not null check (programme_area in ('pillar_1','pillar_2_3','cross_cutting')),
  reform_link_text text,
  kpi_link       text,
  unit           text,
  frequency      text check (frequency in ('weekly','monthly','quarterly','annual')),
  baseline       text,
  target_y1      numeric,
  target_y1_text text,          -- 'TBC' / 'N/A' kept as text until confirmed
  target_lop     numeric,
  target_lop_confirmed boolean not null default false,
  data_source    text,
  responsible_unit text,
  evidence_standard text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table indicator_reform_links (
  indicator_code text not null references indicators on delete cascade,
  reform_id text not null references reforms,
  primary key (indicator_code, reform_id)
);

create table reporting_periods (
  period_end date primary key,
  frequency  text not null check (frequency in ('monthly','quarterly','annual')),
  label      text,
  is_locked  boolean not null default false,
  locked_at  timestamptz, locked_by uuid references app_users
);

create table indicator_values (
  value_id       uuid primary key default gen_random_uuid(),
  indicator_code text not null references indicators,
  reform_id      text references reforms,         -- null = programme total
  period_end     date not null,
  snapshot_type  text,                             -- e.g. 'Inception Close', 'Monthly', 'Quarterly'
  value          numeric,
  target_value_text text,
  status_text    text,
  is_proxy       boolean not null default false,
  confidence     text check (confidence in ('high','medium','low')),
  evidence_basis text,
  comment        text,
  approval_status text not null default 'proposed' check (approval_status in ('proposed','approved','rejected')),
  approved_by uuid references app_users, approved_at timestamptz,
  created_at timestamptz not null default now(), updated_by uuid references app_users,
  unique (indicator_code, reform_id, period_end, snapshot_type)
);

create table disaggregation_facts (
  fact_id uuid primary key default gen_random_uuid(),
  metric text not null, dimension_type text not null, province text, sex text, age_group text, disability_status text,
  value_low numeric, value_high numeric, unit text, reference text, source_note text
);

create table readiness_assessments (
  readiness_id text primary key check (readiness_id ~ '^RD-[0-9]{3}$'),
  reform_id text not null references reforms,
  political_commitment text check (political_commitment in ('high','medium','low')),
  institutional_ownership text check (institutional_ownership in ('high','medium','low')),
  technical_readiness text check (technical_readiness in ('high','medium','low')),
  financial_readiness text check (financial_readiness in ('high','medium','low')),
  stakeholder_alignment text check (stakeholder_alignment in ('high','medium','low')),
  implementation_capacity text check (implementation_capacity in ('high','medium','low')),
  overall_score_source numeric,   -- as given in source; method unknown
  overall_score_computed numeric, -- from the agreed method (see docs/02_DATA_MODEL.md)
  method_version text,
  assessment_date date, assessor text, comments text,
  created_at timestamptz not null default now()
);

create table learning_log (
  learning_id uuid primary key default gen_random_uuid(),
  learning_date date, theme text not null, key_learning text not null, implication text,
  owner_text text, review_cycle text, evidence_basis text, next_action_date date,
  created_at timestamptz not null default now()
);

create table governance_raci (
  raci_id text primary key, reform_id text references reforms, activity text not null,
  responsible text, accountable text, consulted text, informed text, approval_gate text, review_forum text
);

-- ---------------------------------------------------------------------------
-- Governance cycle: reviews (monthly, QSR), escalations, snapshots, publications
-- ---------------------------------------------------------------------------
create table reviews (
  review_id uuid primary key default gen_random_uuid(),
  review_type text not null check (review_type in ('weekly_check_in','monthly_pillar_review','quarterly_strategy_review','steerco','after_action_review','other')),
  review_date date not null,
  title text,
  governance_tier int check (governance_tier in (1,2,3)),
  pack_generated_at timestamptz,
  minutes_evidence_id text references evidence_items,
  created_at timestamptz not null default now()
);
alter table decisions add constraint decisions_review_fk foreign key (review_id) references reviews;

create table escalations (
  escalation_id uuid primary key default gen_random_uuid(),
  object_type text not null, object_id text not null,
  level int not null check (level between 0 and 4),   -- see docs/01_SPEC.md escalation ladder
  reason text not null,
  raised_at timestamptz not null default now(),
  notified_person_ids uuid[],
  review_id uuid references reviews,
  resolved_at timestamptz, resolution_note text
);
create unique index escalations_open_one_per_level on escalations (object_type, object_id, level) where resolved_at is null;

create table reform_status_snapshots (
  snapshot_date date not null,
  reform_id text not null references reforms,
  current_stage text, status_rag text, progress_pct numeric,
  milestones_due int, milestones_overdue int, risks_open int, risks_high int, decisions_pending int,
  milestones_due_text text, trust_note text,
  frozen_at timestamptz not null default now(),
  primary key (snapshot_date, reform_id)
);

create table publications (
  publication_id text primary key, report_name text not null, version text, publication_date date,
  published_by text, audience text, hosting_platform text,
  access_level text check (access_level in ('internal','restricted','external','public')),
  approval_status text check (approval_status in ('pending','approved','rejected')),
  approved_by text, approval_date date, file_path text
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['institutions','people','app_users','reforms','workstreams','deliverables','activities','milestones',
                           'reform_stages','risks','decisions','actions','adaptations','evidence_items','indicators']
  loop
    execute format('create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- Helpful indexes
create index on workstreams (reform_id);
create index on deliverables (workstream_id);
create index on activities (deliverable_id);
create index on milestones (reform_id);
create index on milestones (deliverable_id);
create index on evidence_links (object_type, object_id);
create index on risk_links (object_type, object_id);
create index on decision_links (object_type, object_id);
create index on indicator_values (indicator_code, period_end);
