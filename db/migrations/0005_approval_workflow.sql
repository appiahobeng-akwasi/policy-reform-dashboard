-- 0005: the approval workflow promised in 0003. approve_submission() and return_submission()
-- are what the app calls; apply_submission() writes the live tables and is internal.
-- Behaviour follows docs/03_DATA_QUALITY_GATE.md section 6 and docs/01_SPEC.md section 7.
--
-- Payload format (submissions.payload):
--   {"rows": [{"entity": "milestone", "op": "update", "id": "MS-009",
--              "fields": {"status": "on_track", "next_action": "Send the draft to the minister"},
--              "links": [{"object_type": "reform", "object_id": "RA1"}]}]}
--   op is 'create' or 'update'. On 'create' the id may be left out where the entity has an ID
--   generator (workstream, deliverable, activity, milestone, risk, decision, action, evidence_item,
--   indicator_value). 'fields' may only name the columns listed in submission_entities.
--   An 'update' with no fields is a "nothing changed" confirmation: it sets last_confirmed_at.
--   'links' (risk, decision, adaptation, evidence_item only) are added, never removed.
--
-- Errors start with a code so the app can show its own translated message:
--   rule IDs from rules/dq_rules.v1.json (B01, B03, B11, B12) or workflow codes:
--   W01 not found, W02 wrong status, W03 no passing gate run on the current rule set,
--   W04 four-eyes, W05 not allowed to approve, W06 a note or reason is needed,
--   W07 the payload is malformed, W08 the ID already exists, W09 field cannot be changed by a user.
--   The error hint holds JSON: {"code", "row", "field", "value"}.

-- ---------------------------------------------------------------------------
-- What a submission may change
-- ---------------------------------------------------------------------------
create table submission_entities (
  entity           text primary key,
  table_name       text not null unique,
  pk_column        text not null,
  link_table       text,             -- (pk_column, object_type, object_id); links are additive
  writable_columns text[] not null
);
alter table submission_entities enable row level security;
create policy se_read on submission_entities for select using (me() is not null);
create policy se_write_super on submission_entities for all using (my_role() = 'super_admin') with check (my_role() = 'super_admin');

insert into submission_entities (entity, table_name, pk_column, link_table, writable_columns) values
  ('workstream', 'workstreams', 'workstream_id', null, array['reform_id','name','workstream_type','owner_person_id','lead_institution_id','start_date','due_date','forecast_date','actual_date','status','progress_pct','rag_override','rag_override_reason','next_action','blocker','comments']),
  ('deliverable', 'deliverables', 'deliverable_id', null, array['workstream_id','name','description','owner_person_id','start_date','due_date','forecast_date','actual_date','status','progress_pct','evidence_required','evidence_confidence','rag_override','rag_override_reason','next_action','blocker','comments']),
  ('activity', 'activities', 'activity_id', null, array['deliverable_id','name','owner_person_id','start_date','due_date','forecast_date','actual_date','status','progress_pct','next_action','blocker','comments']),
  ('milestone', 'milestones', 'milestone_id', null, array['scope','reform_id','deliverable_id','name','milestone_type','pathway_stage','is_decision_gate','owner_person_id','planned_date','forecast_date','actual_date','status','evidence_required','evidence_confidence','escalation_action','next_action','blocker','comments']),
  ('reform_stage', 'reform_stages', 'stage_record_id', null, array['reform_id','stage','entry_date','exit_date','status','evidence_required','responsible_person_id','escalation_needed','escalation_to','comments']),
  ('risk', 'risks', 'risk_id', 'risk_links', array['category','description','likelihood','impact','mitigation','trigger','owner_person_id','residual_likelihood','residual_impact','treatment','review_date','status']),
  ('decision', 'decisions', 'decision_id', 'decision_links', array['decision_date','decision_type','decision_body','decision_maker','governance_tier','summary','reason','follow_up_action','follow_up_owner_person_id','follow_up_due','status','pathway_stage']),
  ('action', 'actions', 'action_id', null, array['source_type','source_id','description','owner_person_id','due_date','status','completed_at','comments']),
  ('adaptation', 'adaptations', 'adaptation_id', 'adaptation_links', array['trigger_event','trigger_type','original_plan','change_requested','change_approved','approval_date','approved_by','rationale','expected_impact','follow_up_action']),
  ('evidence_item', 'evidence_items', 'evidence_id', 'evidence_links', array['title','evidence_type','source_institution','evidence_date','file_path','file_sha256','file_mime','file_bytes','external_url','access_level','pathway_stage']),
  ('indicator_value', 'indicator_values', 'value_id', null, array['indicator_code','reform_id','period_end','snapshot_type','value','is_proxy','confidence','evidence_basis','comment']),
  ('readiness_assessment', 'readiness_assessments', 'readiness_id', null, array['reform_id','political_commitment','institutional_ownership','technical_readiness','financial_readiness','stakeholder_alignment','implementation_capacity','assessment_date','assessor','comments']);

-- ---------------------------------------------------------------------------
-- Submissions: derived columns, break-glass record, and a guard on what users may change
-- ---------------------------------------------------------------------------
alter table submissions
  add column reform_ids text[] not null default '{}',   -- reforms the payload touches (for who may see it)
  add column entities   text[] not null default '{}',   -- entities in the payload
  add column break_glass boolean not null default false,
  add column break_glass_reason text,
  add check (not break_glass or break_glass_reason is not null);

alter table notification_log drop constraint notification_log_kind_check;
alter table notification_log add constraint notification_log_kind_check check (kind in ('due_soon','overdue','escalation','weekly_digest','approval_needed','submission_approved','submission_returned','gate_rejected','stale_item','training_suggested'));

-- Every status change on a submission, and every link added, goes to the audit log too.
create trigger submissions_audit after insert or update or delete on submissions for each row execute function audit_row('submission_id');
create trigger risk_links_audit after insert or update or delete on risk_links for each row execute function audit_row('risk_id');
create trigger decision_links_audit after insert or update or delete on decision_links for each row execute function audit_row('decision_id');
create trigger adaptation_links_audit after insert or update or delete on adaptation_links for each row execute function audit_row('adaptation_id');
create trigger evidence_links_audit after insert or update or delete on evidence_links for each row execute function audit_row('evidence_id');

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------
create or replace function workflow_error(p_code text, p_row int, p_field text, p_value text, p_text text) returns void
language plpgsql as $$
begin
  raise exception using
    errcode = 'P0001',
    message = p_code || coalesce(format(': row %s', p_row), '') || ': ' || p_text,
    hint = jsonb_build_object('code', p_code, 'row', p_row, 'field', p_field, 'value', p_value)::text;
end $$;

create or replace function table_has_column(p_table text, p_column text) returns boolean language sql stable as $$
  select exists (select 1 from pg_attribute
                  where attrelid = to_regclass(format('public.%I', p_table)) and attname = p_column and attnum > 0 and not attisdropped)
$$;

create or replace function my_reform_ids() returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(reform_id order by reform_id), '{}') from user_reform_scope where user_id = (me()).user_id
$$;

create or replace function object_record(p_type text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e submission_entities; v jsonb;
begin
  select * into e from submission_entities where entity = p_type;
  if not found or p_id is null then return null; end if;
  execute format('select to_jsonb(t) from %I t where t.%I::text = $1', e.table_name, e.pk_column) into v using p_id;
  return v;
end $$;

create or replace function object_exists(p_type text, p_id text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if p_id is null then return false; end if;
  return case p_type
    when 'reform' then exists (select 1 from reforms where reform_id = p_id)
    when 'indicator' then exists (select 1 from indicators where indicator_code = p_id)
    when 'person' then exists (select 1 from people where person_id::text = p_id)
    when 'institution' then exists (select 1 from institutions where institution_id::text = p_id)
    when 'pathway_stage' then exists (select 1 from pathway_stages where code = p_id)
    else object_record(p_type, p_id) is not null end;
end $$;

-- The reforms an existing object belongs to. Risks, decisions, adaptations and evidence get
-- theirs through their links; programme-wide items return an empty array.
create or replace function object_reforms(p_type text, p_id text, p_depth int default 0) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare r text[];
begin
  if p_id is null or p_depth > 3 then return '{}'; end if;
  case p_type
    when 'reform' then select array_agg(reform_id) into r from reforms where reform_id = p_id;
    when 'workstream' then select array_agg(reform_id) into r from workstreams where workstream_id = p_id;
    when 'deliverable' then
      select array_agg(w.reform_id) into r from deliverables d join workstreams w on w.workstream_id = d.workstream_id where d.deliverable_id = p_id;
    when 'activity' then
      select array_agg(w.reform_id) into r from activities a join deliverables d on d.deliverable_id = a.deliverable_id
        join workstreams w on w.workstream_id = d.workstream_id where a.activity_id = p_id;
    when 'milestone' then
      select array_agg(x) into r from (
        select reform_id as x from milestones where milestone_id = p_id and reform_id is not null
        union
        select w.reform_id from milestones m join deliverables d on d.deliverable_id = m.deliverable_id
          join workstreams w on w.workstream_id = d.workstream_id where m.milestone_id = p_id) s;
    when 'reform_stage' then select array_agg(reform_id) into r from reform_stages where stage_record_id = p_id;
    when 'readiness_assessment' then select array_agg(reform_id) into r from readiness_assessments where readiness_id = p_id;
    when 'indicator_value' then select array_agg(reform_id) into r from indicator_values where value_id::text = p_id and reform_id is not null;
    when 'indicator' then select array_agg(reform_id) into r from indicator_reform_links where indicator_code = p_id;
    when 'risk' then
      select array_agg(distinct x) into r from risk_links l, unnest(object_reforms(l.object_type, l.object_id, p_depth + 1)) x where l.risk_id = p_id;
    when 'decision' then
      select array_agg(distinct x) into r from decision_links l, unnest(object_reforms(l.object_type, l.object_id, p_depth + 1)) x where l.decision_id = p_id;
    when 'adaptation' then
      select array_agg(distinct x) into r from adaptation_links l, unnest(object_reforms(l.object_type, l.object_id, p_depth + 1)) x where l.adaptation_id = p_id;
    when 'evidence_item' then
      select array_agg(distinct x) into r from evidence_links l, unnest(object_reforms(l.object_type, l.object_id, p_depth + 1)) x where l.evidence_id = p_id;
    when 'action' then select object_reforms(source_type, source_id, p_depth + 1) into r from actions where action_id = p_id;
    else r := '{}';
  end case;
  return coalesce(r, '{}');
end $$;

-- Like object_reforms, but for a parent that may be created earlier in the same submission:
-- workstream, deliverable and activity IDs carry their reform (WS-RA1-01).
create or replace function parent_reforms(p_type text, p_id text) returns text[]
language sql stable security definer set search_path = public as $$
  select case when cardinality(object_reforms(p_type, p_id)) > 0 then object_reforms(p_type, p_id)
              when p_id ~ '^(WS|DL|AC)-RA[0-9]-' then array[substring(p_id from '^(?:WS|DL|AC)-(RA[0-9])-')]
              when p_type = 'reform' and p_id ~ '^RA[0-9]$' then array[p_id]
              else '{}'::text[] end
$$;

-- The reforms one payload row touches: where the item sits now and where it will sit after
-- the change. Empty means a programme-wide item.
create or replace function payload_row_reforms(p_row jsonb) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare
  v_entity text := p_row ->> 'entity';
  v_id text := nullif(trim(p_row ->> 'id'), '');
  m jsonb;
  r text[] := '{}';
  l jsonb;
begin
  if v_id is not null then r := object_reforms(v_entity, v_id); end if;
  m := coalesce(object_record(v_entity, v_id), '{}')
       || case when jsonb_typeof(p_row -> 'fields') = 'object' then p_row -> 'fields' else '{}' end;
  case v_entity
    when 'workstream', 'reform_stage', 'readiness_assessment', 'indicator_value' then
      r := r || parent_reforms('reform', m ->> 'reform_id');
    when 'milestone' then
      r := r || parent_reforms('reform', m ->> 'reform_id') || parent_reforms('deliverable', m ->> 'deliverable_id');
    when 'deliverable' then r := r || parent_reforms('workstream', m ->> 'workstream_id');
    when 'activity' then r := r || parent_reforms('deliverable', m ->> 'deliverable_id');
    when 'action' then r := r || parent_reforms(m ->> 'source_type', m ->> 'source_id');
    else null;
  end case;
  if jsonb_typeof(p_row -> 'links') = 'array' then
    for l in select value from jsonb_array_elements(p_row -> 'links') loop
      r := r || parent_reforms(l ->> 'object_type', l ->> 'object_id');
    end loop;
  end if;
  return coalesce((select array_agg(distinct x order by x) from unnest(r) x where x is not null), '{}');
end $$;

-- B11: may this user submit this row? (Role table in docs/01_SPEC.md section 3.)
create or replace function user_can_submit(p_user uuid, p_entity text, p_reforms text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case u.app_role
      when 'super_admin' then true
      when 'programme_admin' then true
      when 'merl_officer' then p_entity in ('indicator_value', 'evidence_item')
      when 'reform_lead' then cardinality(p_reforms) > 0
        and not exists (select 1 from unnest(p_reforms) x
                         where not exists (select 1 from user_reform_scope s where s.user_id = u.user_id and s.reform_id = x))
      when 'contributor' then cardinality(p_reforms) > 0
        and not exists (select 1 from unnest(p_reforms) x
                         where not exists (select 1 from user_reform_scope s where s.user_id = u.user_id and s.reform_id = x))
      else false end
    from app_users u where u.user_id = p_user and u.is_active), false)
$$;

-- May this user approve this row? Reform leads need can_approve on every reform the row
-- touches; MERL officers approve indicator values for every reform (decision 14);
-- programme-wide rows need a programme admin. super_admin only through break-glass.
create or replace function user_can_approve_row(p_user uuid, p_entity text, p_reforms text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case u.app_role
      when 'super_admin' then true
      when 'programme_admin' then true
      when 'merl_officer' then p_entity = 'indicator_value'
      when 'reform_lead' then p_entity <> 'indicator_value' and cardinality(p_reforms) > 0
        and not exists (select 1 from unnest(p_reforms) x
                         where not exists (select 1 from user_reform_scope s
                                            where s.user_id = u.user_id and s.reform_id = x and s.can_approve))
      else false end
    from app_users u where u.user_id = p_user and u.is_active), false)
$$;

create or replace function next_object_id(p_entity text, m jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_reform text;
begin
  case p_entity
    when 'workstream' then v_reform := m ->> 'reform_id';
    when 'deliverable' then v_reform := (parent_reforms('workstream', m ->> 'workstream_id'))[1];
    when 'activity' then v_reform := (parent_reforms('deliverable', m ->> 'deliverable_id'))[1];
    when 'milestone' then return 'MS-' || lpad(nextval('milestone_seq')::text, 3, '0');
    when 'risk' then return 'RK-' || lpad(nextval('risk_seq')::text, 3, '0');
    when 'decision' then return 'DC-' || lpad(nextval('decision_seq')::text, 3, '0');
    when 'evidence_item' then return 'EV-' || lpad(nextval('evidence_seq')::text, 3, '0');
    when 'action' then return 'AN-' || lpad(nextval('action_seq')::text, 4, '0');
    when 'indicator_value' then return gen_random_uuid()::text;
    else return null;
  end case;
  if v_reform is null then return null; end if;
  return next_child_id(p_entity, v_reform);
end $$;

create or replace function notify_submitter(p_submission submissions, p_kind text) returns void
language sql security definer set search_path = public as $$
  insert into notification_log (kind, person_id, channel, object_type, object_id, status)
  select p_kind, u.person_id, 'in_app', 'submission', p_submission.submission_id::text, 'queued'
    from app_users u where u.user_id = p_submission.submitted_by
  on conflict do nothing
$$;

-- ---------------------------------------------------------------------------
-- Triggers on submissions
-- ---------------------------------------------------------------------------
-- reform_ids and entities are always computed here, so nobody can set them by hand.
create or replace function submissions_derive() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_rows jsonb := case when jsonb_typeof(new.payload -> 'rows') = 'array' then new.payload -> 'rows' else '[]' end;
begin
  new.reform_ids := coalesce((select array_agg(distinct x order by x)
                                from jsonb_array_elements(v_rows) as e(v), unnest(payload_row_reforms(e.v)) x), '{}');
  new.entities := coalesce((select array_agg(distinct e.v ->> 'entity' order by e.v ->> 'entity')
                              from jsonb_array_elements(v_rows) as e(v) where e.v ->> 'entity' is not null), '{}');
  return new;
end $$;
create trigger submissions_derive before insert or update on submissions for each row execute function submissions_derive();

-- A signed-in user may create a draft and later change only its payload and status
-- (the RLS policy limits status to draft or withdrawn). The gate and approval set the rest.
-- A changed payload must pass the gate again, so its gate run is cleared.
create or replace function submissions_guard() returns trigger language plpgsql as $$
begin
  if not is_privileged_session() then
    if tg_op = 'INSERT' then
      if new.status <> 'draft' or new.dq_run_id is not null or new.reviewer is not null or new.reviewed_at is not null
         or new.review_note is not null or new.applied_at is not null or new.break_glass or new.break_glass_reason is not null then
        perform workflow_error('W09', null, 'status', new.status, 'a new submission must start as a draft');
      end if;
    elsif (new.submission_id, new.route, new.batch_id, new.submitted_by, new.on_behalf_of_person_id, new.reviewer, new.reviewed_at,
           new.review_note, new.applied_at, new.previous_submission_id, new.created_at, new.break_glass, new.break_glass_reason)
          is distinct from
          (old.submission_id, old.route, old.batch_id, old.submitted_by, old.on_behalf_of_person_id, old.reviewer, old.reviewed_at,
           old.review_note, old.applied_at, old.previous_submission_id, old.created_at, old.break_glass, old.break_glass_reason)
       or (new.dq_run_id is distinct from old.dq_run_id and new.dq_run_id is not null) then
      perform workflow_error('W09', null, null, null, 'only the payload and status of a submission can be changed by its submitter');
    end if;
  end if;
  if tg_op = 'UPDATE' and new.payload is distinct from old.payload then
    new.dq_run_id := null;
  end if;
  return new;
end $$;
create trigger submissions_guard before insert or update on submissions for each row execute function submissions_guard();

-- Decision 15: reform leads see only submissions touching their own reforms.
-- MERL officers see submissions with indicator values, which they approve (decision 14).
drop policy sub_read_own on submissions;
create policy sub_read on submissions for select using (
  submitted_by = (me()).user_id
  or is_admin()
  or (my_role() = 'reform_lead' and reform_ids && my_reform_ids())
  or (my_role() = 'merl_officer' and 'indicator_value' = any (entities)));

-- ---------------------------------------------------------------------------
-- Apply one payload row: live-data checks (B01, B03, B11, B12), the approver's right to
-- approve it, then the write. Rows are applied in order, so a later row may refer to an
-- item created by an earlier one.
-- ---------------------------------------------------------------------------
create or replace function apply_payload_row(p_row jsonb, p_n int, p_submission submissions, p_approver uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_entity text := p_row ->> 'entity';
  v_op text := p_row ->> 'op';
  v_id text := nullif(trim(p_row ->> 'id'), '');
  f jsonb := coalesce(p_row -> 'fields', '{}');
  e submission_entities;
  v_merged jsonb;
  v_reforms text[];
  v_rec jsonb;
  v_cols text;
  v_bad text;
  v_field text;
  v_type text;
  v_value text;
  v_on_behalf_user uuid;
  l jsonb;
begin
  select * into e from submission_entities where entity = v_entity;
  if not found then perform workflow_error('W07', p_n, 'entity', v_entity, 'unknown entity'); end if;
  if v_op is null or v_op not in ('create', 'update') then perform workflow_error('W07', p_n, 'op', v_op, 'op must be create or update'); end if;
  if jsonb_typeof(f) <> 'object' then perform workflow_error('W07', p_n, 'fields', null, 'fields must be an object'); end if;
  select k into v_bad from jsonb_object_keys(f) k where not (k = any (e.writable_columns)) limit 1;
  if v_bad is not null then perform workflow_error('W07', p_n, v_bad, null, 'this field cannot be changed by a submission'); end if;
  if p_row ? 'links' and (e.link_table is null or jsonb_typeof(p_row -> 'links') <> 'array') then
    perform workflow_error('W07', p_n, 'links', null, 'links are only accepted as a list on risks, decisions, adaptations and evidence');
  end if;

  -- B01 and existence of the item itself
  if v_op = 'update' then
    if v_id is null then perform workflow_error('B01', p_n, e.pk_column, null, 'an update needs the ID of the item'); end if;
    if not object_exists(v_entity, v_id) then perform workflow_error('B03', p_n, e.pk_column, v_id, 'the item does not exist'); end if;
  elsif v_id is not null and object_exists(v_entity, v_id) then
    perform workflow_error('W08', p_n, e.pk_column, v_id, 'an item with this ID already exists');
  end if;
  v_merged := coalesce(object_record(v_entity, v_id), '{}') || f;

  -- B03: every reference exists
  for v_field, v_type in
    select * from (values ('reform_id','reform'), ('workstream_id','workstream'), ('deliverable_id','deliverable'),
                          ('indicator_code','indicator'), ('owner_person_id','person'), ('responsible_person_id','person'),
                          ('follow_up_owner_person_id','person'), ('lead_institution_id','institution'),
                          ('pathway_stage','pathway_stage'), ('stage','pathway_stage')) t(field, type)
  loop
    v_value := f ->> v_field;
    if v_value is not null and not object_exists(v_type, v_value) then
      perform workflow_error('B03', p_n, v_field, v_value, 'the referenced item does not exist');
    end if;
  end loop;
  if v_entity = 'action' and v_merged ->> 'source_type' in ('decision', 'risk', 'adaptation')
     and v_merged ->> 'source_id' is not null and not object_exists(v_merged ->> 'source_type', v_merged ->> 'source_id') then
    perform workflow_error('B03', p_n, 'source_id', v_merged ->> 'source_id', 'the referenced item does not exist');
  end if;
  if p_row ? 'links' then
    for l in select value from jsonb_array_elements(p_row -> 'links') loop
      if jsonb_typeof(l) <> 'object' or l ->> 'object_type' is null or l ->> 'object_id' is null then
        perform workflow_error('W07', p_n, 'links', l::text, 'each link needs object_type and object_id');
      end if;
      if not object_exists(l ->> 'object_type', l ->> 'object_id') then
        perform workflow_error('B03', p_n, 'links', concat(l ->> 'object_type', ' ', l ->> 'object_id'), 'the linked item does not exist');
      end if;
    end loop;
  end if;

  -- B11: the submitter, and the person entered for if they have an account, may write here
  v_reforms := payload_row_reforms(p_row);
  if not user_can_submit(p_submission.submitted_by, v_entity, v_reforms) then
    perform workflow_error('B11', p_n, 'reform_id', array_to_string(v_reforms, ', '), 'the submitter may not change this reform');
  end if;
  if p_submission.on_behalf_of_person_id is not null then
    select user_id into v_on_behalf_user from app_users where person_id = p_submission.on_behalf_of_person_id and is_active;
    if v_on_behalf_user is not null and not user_can_submit(v_on_behalf_user, v_entity, v_reforms) then
      perform workflow_error('B11', p_n, 'reform_id', array_to_string(v_reforms, ', '), 'the person entered for may not change this reform');
    end if;
  end if;

  if not user_can_approve_row(p_approver, v_entity, v_reforms) then
    perform workflow_error('W05', p_n, 'reform_id', array_to_string(v_reforms, ', '), 'you may not approve this row');
  end if;

  -- B12: closed reporting periods cannot be changed
  if v_entity = 'indicator_value' and exists (select 1 from reporting_periods p
                                               where p.period_end = (v_merged ->> 'period_end')::date and p.is_locked) then
    perform workflow_error('B12', p_n, 'period_end', v_merged ->> 'period_end', 'the reporting period is closed');
  end if;

  -- Write
  v_rec := f;
  if table_has_column(e.table_name, 'updated_by') then v_rec := v_rec || jsonb_build_object('updated_by', p_submission.submitted_by); end if;
  if table_has_column(e.table_name, 'last_confirmed_at') then v_rec := v_rec || jsonb_build_object('last_confirmed_at', now()); end if;
  if v_entity = 'indicator_value' then
    v_rec := v_rec || jsonb_build_object('approval_status', 'approved', 'approved_by', p_approver, 'approved_at', now());
  end if;

  if v_op = 'create' then
    if v_id is null then
      v_id := next_object_id(v_entity, v_merged);
      if v_id is null then perform workflow_error('B01', p_n, e.pk_column, null, 'an ID is needed for this item'); end if;
    end if;
    v_rec := v_rec || jsonb_build_object(e.pk_column, v_id);
    if v_entity = 'evidence_item' then v_rec := v_rec || jsonb_build_object('uploaded_by', p_submission.submitted_by); end if;
    select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_rec) k;
    execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)', e.table_name, v_cols, v_cols, e.table_name)
      using v_rec;
  else
    select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_rec) k;
    if v_cols is not null then
      execute format('update %I t set (%s) = (select %s from jsonb_populate_record(null::%I, $1)) where t.%I::text = $2',
                     e.table_name, v_cols, v_cols, e.table_name, e.pk_column)
        using v_rec, v_id;
    end if;
  end if;

  if p_row ? 'links' then
    for l in select value from jsonb_array_elements(p_row -> 'links') loop
      execute format('insert into %I (%I, object_type, object_id) values ($1, $2, $3) on conflict do nothing', e.link_table, e.pk_column)
        using v_id, l ->> 'object_type', l ->> 'object_id';
    end loop;
  end if;
  return v_id;
end $$;

-- All rows or none: any error rolls the whole transaction back.
create or replace function apply_submission(p_submission uuid, p_approver uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s submissions; r jsonb; n int := 0;
begin
  select * into s from submissions where submission_id = p_submission;
  if not found then perform workflow_error('W01', null, 'submission_id', p_submission::text, 'submission not found'); end if;
  if coalesce(jsonb_typeof(s.payload -> 'rows'), '') <> 'array' or jsonb_array_length(s.payload -> 'rows') = 0 then
    perform workflow_error('W07', null, 'rows', null, 'the payload has no rows');
  end if;
  -- Audit context: the change is the submitter's, entered for the on-behalf person, under this submission.
  perform set_config('app.actor_user_id', s.submitted_by::text, true);
  perform set_config('app.on_behalf_of', coalesce(s.on_behalf_of_person_id::text, ''), true);
  perform set_config('app.submission_id', s.submission_id::text, true);
  for r in select value from jsonb_array_elements(s.payload -> 'rows') loop
    n := n + 1;
    perform apply_payload_row(r, n, s, p_approver);
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- What the app calls
-- ---------------------------------------------------------------------------
create or replace function approve_submission(p_submission uuid, p_note text default null, p_break_glass boolean default false)
returns submissions language plpgsql security definer set search_path = public as $$
declare
  v_me app_users := me();
  s submissions;
  run dq_runs;
  v_note text := nullif(trim(p_note), '');
begin
  if v_me.user_id is null then perform workflow_error('W05', null, null, null, 'only an active user can approve'); end if;
  select * into s from submissions where submission_id = p_submission for update;
  if not found then perform workflow_error('W01', null, 'submission_id', p_submission::text, 'submission not found'); end if;
  if s.status <> 'proposed' then perform workflow_error('W02', null, 'status', s.status, 'only a proposed submission can be approved'); end if;

  select * into run from dq_runs where dq_run_id = s.dq_run_id;
  if run.dq_run_id is null or run.submission_id <> s.submission_id or run.outcome <> 'pass'
     or run.ruleset_version is distinct from (select ruleset_version from dq_rulesets where is_current) then
    perform workflow_error('W03', null, 'dq_run_id', s.dq_run_id::text, 'the submission has no passing gate run on the current rule set');
  end if;

  -- super_admin approves only through break-glass, always with a reason. Nobody else may use it.
  if v_me.app_role = 'super_admin' then
    if not p_break_glass or v_note is null then
      perform workflow_error('W06', null, 'break_glass', null, 'super_admin approval needs break-glass and a reason');
    end if;
  elsif p_break_glass then
    perform workflow_error('W05', null, 'break_glass', null, 'only super_admin may use break-glass');
  end if;

  -- Four-eyes: not the submitter, and not the person the submission was entered for.
  if not p_break_glass and (v_me.user_id = s.submitted_by or v_me.person_id is not distinct from s.on_behalf_of_person_id) then
    perform workflow_error('W04', null, 'submitted_by', s.submitted_by::text, 'you cannot approve your own submission');
  end if;

  perform apply_submission(s.submission_id, v_me.user_id);

  -- The approval itself is the approver's action.
  perform set_config('app.actor_user_id', v_me.user_id::text, true);
  perform set_config('app.on_behalf_of', '', true);
  update submissions
     set status = 'applied', reviewer = v_me.user_id, reviewed_at = now(), review_note = v_note, applied_at = now(),
         break_glass = p_break_glass, break_glass_reason = case when p_break_glass then v_note end
   where submission_id = s.submission_id
  returning * into s;
  perform notify_submitter(s, 'submission_approved');

  perform set_config('app.actor_user_id', '', true);
  perform set_config('app.submission_id', '', true);
  return s;
end $$;

create or replace function return_submission(p_submission uuid, p_note text) returns submissions
language plpgsql security definer set search_path = public as $$
declare
  v_me app_users := me();
  s submissions;
  r jsonb;
  n int := 0;
  v_note text := nullif(trim(p_note), '');
begin
  if v_me.user_id is null then perform workflow_error('W05', null, null, null, 'only an active user can return a submission'); end if;
  if v_note is null then perform workflow_error('W06', null, 'review_note', null, 'say what needs fixing'); end if;
  select * into s from submissions where submission_id = p_submission for update;
  if not found then perform workflow_error('W01', null, 'submission_id', p_submission::text, 'submission not found'); end if;
  if s.status <> 'proposed' then perform workflow_error('W02', null, 'status', s.status, 'only a proposed submission can be returned'); end if;
  if v_me.user_id = s.submitted_by then
    perform workflow_error('W04', null, 'submitted_by', s.submitted_by::text, 'withdraw your own submission instead of returning it');
  end if;
  if coalesce(jsonb_typeof(s.payload -> 'rows'), '') = 'array' then
    for r in select value from jsonb_array_elements(s.payload -> 'rows') loop
      n := n + 1;
      if not user_can_approve_row(v_me.user_id, r ->> 'entity', payload_row_reforms(r)) then
        perform workflow_error('W05', n, 'reform_id', null, 'you may not review this row');
      end if;
    end loop;
  end if;

  perform set_config('app.actor_user_id', v_me.user_id::text, true);
  perform set_config('app.submission_id', s.submission_id::text, true);
  update submissions set status = 'returned', reviewer = v_me.user_id, reviewed_at = now(), review_note = v_note
   where submission_id = s.submission_id
  returning * into s;
  perform notify_submitter(s, 'submission_returned');
  perform set_config('app.actor_user_id', '', true);
  perform set_config('app.submission_id', '', true);
  return s;
end $$;

-- ---------------------------------------------------------------------------
-- Internal functions: not callable by signed-in users (see the convention in 0004)
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'apply_submission(uuid, uuid)', 'apply_payload_row(jsonb, int, submissions, uuid)', 'object_record(text, text)',
    'object_exists(text, text)', 'object_reforms(text, text, int)', 'parent_reforms(text, text)', 'payload_row_reforms(jsonb)',
    'user_can_submit(uuid, text, text[])', 'user_can_approve_row(uuid, text, text[])', 'next_object_id(text, jsonb)',
    'notify_submitter(submissions, text)']
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('comment on function %s is %L', f, 'internal: approval workflow');
  end loop;
end $$;
