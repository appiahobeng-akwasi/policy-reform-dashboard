-- 0011: entering updates for someone else (build step 8, spec 01 section 5.3).
--   1. How and when an on-behalf update was received, an optional note, and an optional file
--      showing the instruction (decisions 31 and 32).
--   2. Bulk uploads by the Secretariat may name a different person on each row (decision 33):
--      payload rows carry on_behalf_of_person_id. Approval attributes each row to its own person
--      in the audit log, checks that person's scope (B11), and refuses an approver who is any of
--      the people named (four-eyes). Break-glass does not lift this per-row check.
--   3. item_last_update(): "entered by A for B" for an item, for internal users (acceptance 6).
--   4. A notice kind for telling someone an update was entered for them.
--   5. Only programme admins (and super_admin) enter for someone else (decision 30), enforced
--      here: on-behalf drafts by the insert policy, per-row people at approval.

alter table submissions
  add column on_behalf_channel text check (on_behalf_channel in ('phone', 'whatsapp', 'meeting', 'email', 'letter', 'other')),
  add column on_behalf_received_on date,
  add column on_behalf_note text check (length(on_behalf_note) <= 2000),
  add column instruction_upload_id uuid references evidence_uploads,
  add check (route <> 'on_behalf' or (on_behalf_channel is not null and on_behalf_received_on is not null));

alter table notification_log drop constraint notification_log_kind_check;
alter table notification_log add constraint notification_log_kind_check check (kind in ('due_soon','overdue','escalation','weekly_digest','approval_needed','submission_approved','submission_returned','gate_rejected','stale_item','training_suggested','entered_on_behalf'));

-- The person a row was given by: the row's own (bulk upload) or the submission's.
create or replace function row_on_behalf(p_row jsonb, p_submission submissions) returns uuid
language sql immutable as $$
  select coalesce(
    case when p_row ->> 'on_behalf_of_person_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (p_row ->> 'on_behalf_of_person_id')::uuid end,
    p_submission.on_behalf_of_person_id)
$$;

create or replace function apply_submission(p_submission uuid, p_approver uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  s submissions;
  row_s submissions;
  r jsonb;
  n int := 0;
  v_id text;
  v_person uuid;
  v_approver_person uuid := (select person_id from app_users where user_id = p_approver);
begin
  select * into s from submissions where submission_id = p_submission;
  if not found then perform workflow_error('W01', null, 'submission_id', p_submission::text, 'submission not found'); end if;
  if coalesce(jsonb_typeof(s.payload -> 'rows'), '') <> 'array' or jsonb_array_length(s.payload -> 'rows') = 0 then
    perform workflow_error('W07', null, 'rows', null, 'the payload has no rows');
  end if;
  -- Checks first, before anything is written: versions, and the people rows were entered for.
  for r in select value from jsonb_array_elements(s.payload -> 'rows') loop
    n := n + 1;
    perform check_row_version(r, n);
    -- object_exists compares as text, so an email address left in by the upload is simply not found.
    if nullif(r ->> 'on_behalf_of_person_id', '') is not null and not object_exists('person', r ->> 'on_behalf_of_person_id') then
      perform workflow_error('B03', n, 'on_behalf_of_person_id', r ->> 'on_behalf_of_person_id', 'the person this row was reported by does not exist');
    end if;
    if nullif(r ->> 'on_behalf_of_person_id', '') is not null
       and not exists (select 1 from app_users where user_id = s.submitted_by and app_role in ('super_admin', 'programme_admin')) then
      perform workflow_error('W05', n, 'on_behalf_of_person_id', null, 'only the Secretariat enters updates for someone else');
    end if;
    if v_approver_person is not null and row_on_behalf(r, s) = v_approver_person then
      perform workflow_error('W04', n, 'on_behalf_of_person_id', v_approver_person::text, 'you cannot approve an update entered for you');
    end if;
  end loop;
  n := 0;
  perform set_config('app.actor_user_id', s.submitted_by::text, true);
  perform set_config('app.submission_id', s.submission_id::text, true);
  for r in select value from jsonb_array_elements(s.payload -> 'rows') loop
    n := n + 1;
    -- Each row is attributed to, and scope-checked for, the person it was given by.
    v_person := row_on_behalf(r, s);
    row_s := s;
    row_s.on_behalf_of_person_id := v_person;
    perform set_config('app.on_behalf_of', coalesce(v_person::text, ''), true);
    v_id := apply_payload_row(r, n, row_s, p_approver);
    perform apply_row_relations(r, n, v_id);
  end loop;
  perform set_config('app.on_behalf_of', '', true);
  return n;
end $$;

-- "Last updated 14 Nov 2026, entered by A for B": from the audit log, for internal users only.
create or replace function item_last_update(p_type text, p_id text)
returns table (changed_at timestamptz, entered_by text, entered_for text, channel text)
language sql stable security definer set search_path = public as $$
  select a.at, pe.full_name, pf.full_name, s.on_behalf_channel
    from audit_log a
    join submission_entities e on e.table_name = a.table_name and e.entity = p_type
    left join app_users u on u.user_id = a.actor_user_id
    left join people pe on pe.person_id = u.person_id
    left join people pf on pf.person_id = a.on_behalf_of_person_id
    left join submissions s on s.submission_id = a.submission_id
   where is_internal() and a.record_id = p_id and a.submission_id is not null
   order by a.at desc, a.audit_id desc
   limit 1
$$;

drop policy sub_insert_own on submissions;
create policy sub_insert_own on submissions for insert with check (
  submitted_by = (me()).user_id
  and my_role() in ('super_admin', 'programme_admin', 'reform_lead', 'contributor', 'merl_officer')
  and (route <> 'on_behalf' or my_role() in ('super_admin', 'programme_admin')));

revoke execute on function row_on_behalf(jsonb, submissions) from public;
comment on function row_on_behalf(jsonb, submissions) is 'internal: approval workflow';
