-- 0012: the approvals screen and in-app notices (build step 9).
--   1. can_i_approve(): may the signed-in person approve this whole submission? The same rules as
--      approve_submission(): every row (user_can_approve_row), not their own, not entered for them
--      (whole submission or any row). super_admin only through break-glass.
--   2. approvable_submissions(): the approvals queue.
--   3. submission_quality(): the score and points of one submission, for its approvers, its
--      submitter and admins only (decision 34). Per-user figures stay private.
--   4. review_files(): the files an approver may open before approving (decision 35).
--   5. Notices: read_at, mark_my_notices_read(), and approval_needed sent to approvers (decision 36).
--   6. user_display_name(): the name of the person behind an account, for internal users, without
--      opening app_users (row-level security keeps accounts to their owner and admins).

create or replace function is_confirmation(p_payload jsonb) returns boolean language sql immutable as $$
  -- "Nothing changed": every row an update with no fields, links, evidence or dependencies.
  select coalesce(jsonb_typeof(p_payload -> 'rows') = 'array' and jsonb_array_length(p_payload -> 'rows') > 0
    and not exists (select 1 from jsonb_array_elements(p_payload -> 'rows') r
                     where r ->> 'op' <> 'update'
                        or coalesce(r -> 'fields', '{}'::jsonb) <> '{}'::jsonb
                        or jsonb_array_length(coalesce(r -> 'links', '[]')) > 0
                        or jsonb_array_length(coalesce(r -> 'evidence_ids', '[]')) > 0
                        or jsonb_array_length(coalesce(r -> 'depends_on', '[]')) > 0), false)
$$;

create or replace function user_may_approve(p_user uuid, p_submission uuid, p_break_glass boolean default false) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  u app_users;
  s submissions;
  r jsonb;
begin
  select * into u from app_users where user_id = p_user and is_active;
  select * into s from submissions where submission_id = p_submission;
  if u.user_id is null or s.submission_id is null or s.status <> 'proposed' then return false; end if;
  if u.app_role = 'super_admin' then return p_break_glass; end if;
  if s.submitted_by = u.user_id or s.on_behalf_of_person_id is not distinct from u.person_id then return false; end if;
  if coalesce(jsonb_typeof(s.payload -> 'rows'), '') <> 'array' then return false; end if;
  for r in select value from jsonb_array_elements(s.payload -> 'rows') loop
    if row_on_behalf(r, s) is not distinct from u.person_id then return false; end if;
    if not user_can_approve_row(u.user_id, r ->> 'entity', payload_row_reforms(r)) then return false; end if;
  end loop;
  return true;
end $$;

create or replace function can_i_approve(p_submission uuid, p_break_glass boolean default false) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(user_may_approve((me()).user_id, p_submission, p_break_glass), false)
$$;

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
   where s.status = 'proposed' and can_i_approve(s.submission_id)
   order by s.created_at
$$;

create or replace function user_display_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select p.full_name from app_users u join people p on p.person_id = u.person_id where u.user_id = p_user and is_internal()
$$;

create or replace function may_see_submission_detail(p_submission uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select can_i_approve(p_submission)
      or (my_role() = 'super_admin' and exists (select 1 from submissions where submission_id = p_submission and status = 'proposed'))
      or is_admin()
      or exists (select 1 from submissions where submission_id = p_submission and submitted_by = (me()).user_id)
$$;

create or replace function submission_quality(p_submission uuid)
returns table (quality_score numeric, threshold numeric, rule_id text, severity text, entity text, sheet text, row_ref int, field text, cell text, message_en text, message_fr text)
language sql stable security definer set search_path = public as $$
  select r.quality_score, r.threshold, f.rule_id, f.severity, f.entity, f.sheet, f.row_ref, f.field, f.cell, f.message_en, f.message_fr
    from submissions s
    join dq_runs r on r.dq_run_id = s.dq_run_id
    left join dq_findings f on f.dq_run_id = r.dq_run_id and f.severity <> 'fixed'
   where s.submission_id = p_submission and may_see_submission_detail(p_submission)
   order by f.finding_id
$$;

-- Files an approver may open: evidence attached in the payload, the proof of the instruction,
-- and the original upload.
create or replace function review_files(p_submission uuid)
returns table (kind text, label text, file_path text)
language sql stable security definer set search_path = public as $$
  select x.kind, x.label, x.file_path from (
    select 'evidence'::text as kind, r -> 'fields' ->> 'title' as label, r -> 'fields' ->> 'file_path' as file_path
      from submissions s, jsonb_array_elements(s.payload -> 'rows') r
     where s.submission_id = p_submission and r ->> 'entity' = 'evidence_item' and r -> 'fields' ->> 'file_path' is not null
    union all
    select 'instruction', u.file_name, u.file_path
      from submissions s join evidence_uploads u on u.upload_id = s.instruction_upload_id
     where s.submission_id = p_submission
    union all
    select 'original', b.file_name, b.file_path
      from submissions s join upload_batches b on b.batch_id = s.batch_id
     where s.submission_id = p_submission
  ) x
  where may_see_submission_detail(p_submission)
$$;

-- Notices
alter table notification_log add column read_at timestamptz;

create or replace function mark_my_notices_read() returns int
language sql security definer set search_path = public as $$
  with done as (
    update notification_log set read_at = now()
     where person_id = (me()).person_id and channel = 'in_app' and read_at is null
    returning 1)
  select count(*)::int from done
$$;

-- When a submission passes the gate: tell everyone who may approve it (decision 36).
create or replace function notify_approvers(p_submission uuid) returns int
language sql security definer set search_path = public as $$
  with sent as (
    insert into notification_log (kind, person_id, channel, object_type, object_id, status)
    select 'approval_needed', u.person_id, 'in_app', 'submission', p_submission::text, 'queued'
      from app_users u
     where u.is_active and u.app_role in ('programme_admin', 'reform_lead', 'merl_officer')
       and user_may_approve(u.user_id, p_submission)
    on conflict do nothing
    returning 1)
  select count(*)::int from sent
$$;

do $$
declare f text;
begin
  foreach f in array array['user_may_approve(uuid, uuid, boolean)', 'notify_approvers(uuid)'] loop
    execute format('revoke execute on function %s from public', f);
    execute format('comment on function %s is %L', f, 'internal: approvals');
  end loop;
end $$;
