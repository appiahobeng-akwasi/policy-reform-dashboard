-- 0008: submission rows can carry evidence and dependencies, like the upload template's
-- evidence_ids and depends_on columns (build step 5). The gate checks them (B03, B09, Q09);
-- approval saves them.
--
--   {"entity": "milestone", "op": "update", "id": "MS-009", "fields": {...},
--    "evidence_ids": ["EV-004"], "depends_on": ["MS-008"]}
--
--   evidence_ids: any entity except evidence_item (evidence uses "links" instead).
--   depends_on: workstream, deliverable, activity and milestone. The type of each item
--   waited for is read from its ID. Both are added, never removed.

-- The entity an ID belongs to, from the ID patterns in rules/dq_rules.v1.json.
create or replace function id_object_type(p_id text) returns text language sql immutable as $$
  select case
    when p_id ~ '^RA[0-9]$' then 'reform'
    when p_id ~ '^WS-RA[0-9]-[0-9]{2}$' then 'workstream'
    when p_id ~ '^DL-RA[0-9]-[0-9]{3}$' then 'deliverable'
    when p_id ~ '^AC-RA[0-9]-[0-9]{4}$' then 'activity'
    when p_id ~ '^MS-[0-9]{3}$' then 'milestone'
    when p_id ~ '^PT-[0-9]{3}$' then 'reform_stage'
    when p_id ~ '^RK-[0-9]{3}$' then 'risk'
    when p_id ~ '^DC-[0-9]{3}$' then 'decision'
    when p_id ~ '^AN-[0-9]{4}$' then 'action'
    when p_id ~ '^EV-[0-9]{3,4}$' then 'evidence_item'
    when p_id ~ '^AD-[0-9]{3}$' then 'adaptation'
    when p_id ~ '^RD-[0-9]{3}$' then 'readiness_assessment'
    when p_id ~ '^[OP][0-9]\.[0-9]{1,2}$' then 'indicator'
  end
$$;

create or replace function apply_row_relations(p_row jsonb, p_n int, p_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_entity text := p_row ->> 'entity';
  v_item text;
  v_type text;
begin
  if p_row ? 'evidence_ids' then
    if v_entity = 'evidence_item' or jsonb_typeof(p_row -> 'evidence_ids') <> 'array' then
      perform workflow_error('W07', p_n, 'evidence_ids', null, 'evidence_ids must be a list, and evidence items use links instead');
    end if;
    for v_item in select trim(value) from jsonb_array_elements_text(p_row -> 'evidence_ids') loop
      if not object_exists('evidence_item', v_item) then
        perform workflow_error('B03', p_n, 'evidence_ids', v_item, 'the evidence does not exist');
      end if;
      insert into evidence_links (evidence_id, object_type, object_id) values (v_item, v_entity, p_id) on conflict do nothing;
    end loop;
  end if;

  if p_row ? 'depends_on' then
    if v_entity not in ('workstream', 'deliverable', 'activity', 'milestone') or jsonb_typeof(p_row -> 'depends_on') <> 'array' then
      perform workflow_error('W07', p_n, 'depends_on', null, 'depends_on must be a list, on workstreams, deliverables, activities or milestones');
    end if;
    for v_item in select trim(value) from jsonb_array_elements_text(p_row -> 'depends_on') loop
      v_type := id_object_type(v_item);
      if v_type is null or not object_exists(v_type, v_item) then
        perform workflow_error('B03', p_n, 'depends_on', v_item, 'the item depended on does not exist');
      end if;
      if v_type = v_entity and v_item = p_id then
        perform workflow_error('W07', p_n, 'depends_on', v_item, 'an item cannot depend on itself');
      end if;
      insert into dependencies (from_type, from_id, to_type, to_id) values (v_entity, p_id, v_type, v_item) on conflict do nothing;
    end loop;
  end if;
end $$;

create or replace function apply_submission(p_submission uuid, p_approver uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s submissions; r jsonb; n int := 0; v_id text;
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
    v_id := apply_payload_row(r, n, s, p_approver);
    perform apply_row_relations(r, n, v_id);
  end loop;
  return n;
end $$;

create trigger dependencies_audit after insert or update or delete on dependencies for each row execute function audit_row('from_id');

revoke execute on function apply_row_relations(jsonb, int, text) from public;
comment on function apply_row_relations(jsonb, int, text) is 'internal: approval workflow';
