-- 0021: fixes from the security review of 4 Nov 2026 (decision 91). Forward-only.
--
--   1. Role checks are null-safe: an identity with no active account is nobody, never "maybe".
--      is_admin() and is_internal() were NULL for such an identity, so "if not is_admin()"
--      skipped its refusal (send_training_notice). They now return false.
--   2. Government counterparts see evidence marked public, and evidence marked external only
--      when it is linked to an item in one of their own reforms (spec 01 section 3).
--   3. A file named in a submission must be one the submitter uploaded, or the file the same
--      evidence item already has. Checked when a signed-in person writes the submission, and
--      again when the review lists its files (review_files), so a forged path is never signed.
--   4. Risks stay internal (0003): a counterpart cannot own a risk, and no notice about a risk
--      is ever recorded for a counterpart, so neither the app nor email can show it to them.
--
-- Error codes: E01 a file that is not yours; R01 a counterpart as risk owner.

-- 1. Null-safe role checks ------------------------------------------------------------------
create or replace function is_admin() returns boolean language sql stable as $$
  select coalesce(my_role() in ('super_admin', 'programme_admin'), false) $$;
create or replace function is_internal() returns boolean language sql stable as $$
  select coalesce(my_role() in ('super_admin', 'programme_admin', 'reform_lead', 'contributor', 'merl_officer', 'viewer_internal'), false) $$;

-- 2. Counterpart evidence, scoped to their reforms ------------------------------------------
create or replace function evidence_in_my_reforms(p_evidence text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from unnest(object_reforms('evidence_item', p_evidence)) x
      join user_reform_scope s on s.reform_id = x
     where s.user_id = (me()).user_id)
$$;
comment on function evidence_in_my_reforms(text) is
  'True when the evidence is linked to an item in one of the signed-in person''s reforms (decision 91).';

drop policy ev_read_cp on evidence_items;
-- (select my_role()) runs once per query, as 0019 requires of every policy.
create policy ev_read_cp on evidence_items for select using (
  (select my_role()) = 'viewer_counterpart'
  and (access_level = 'public' or (access_level = 'external' and evidence_in_my_reforms(evidence_id)))
);

-- 3. File provenance in submissions ---------------------------------------------------------
-- A file path in a payload row is allowed when the submitter uploaded it, or when it is the
-- file that same evidence item already holds (an update that keeps its file).
create or replace function payload_file_allowed(p_path text, p_submitter uuid, p_evidence_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_path is null
      or exists (select 1 from evidence_uploads u where u.file_path = p_path and u.uploaded_by = p_submitter)
      or (p_evidence_id is not null and exists (select 1 from evidence_items e where e.evidence_id = p_evidence_id and e.file_path = p_path))
$$;
-- Not marked internal: the trigger below runs as the signed-in person and calls it. It answers
-- only yes or no for one path.
comment on function payload_file_allowed(text, uuid, text) is
  'May this submitter name this file in a submission (decision 91)?';

create or replace function submissions_file_provenance() returns trigger language plpgsql as $$
declare r jsonb;
begin
  if is_privileged_session() then return new; end if;
  if jsonb_typeof(new.payload -> 'rows') = 'array' then
    for r in select value from jsonb_array_elements(new.payload -> 'rows') loop
      if r ->> 'entity' = 'evidence_item'
         and not payload_file_allowed(r -> 'fields' ->> 'file_path', new.submitted_by, nullif(trim(r ->> 'id'), '')) then
        raise exception 'E01: a file in this update was not uploaded by you. Attach the file again.';
      end if;
    end loop;
  end if;
  if new.instruction_upload_id is not null
     and not exists (select 1 from evidence_uploads u where u.upload_id = new.instruction_upload_id and u.uploaded_by = new.submitted_by) then
    raise exception 'E01: the instruction file was not uploaded by you. Attach it again.';
  end if;
  return new;
end $$;
create trigger submissions_file_provenance before insert or update of payload, instruction_upload_id on submissions
  for each row execute function submissions_file_provenance();

-- The review lists only files that pass the same test, whoever wrote the submission.
create or replace function review_files(p_submission uuid)
returns table (kind text, label text, file_path text)
language sql stable security definer set search_path = public as $$
  select x.kind, x.label, x.file_path from (
    select 'evidence'::text as kind, r -> 'fields' ->> 'title' as label, r -> 'fields' ->> 'file_path' as file_path
      from submissions s, jsonb_array_elements(s.payload -> 'rows') r
     where s.submission_id = p_submission and r ->> 'entity' = 'evidence_item' and r -> 'fields' ->> 'file_path' is not null
       and payload_file_allowed(r -> 'fields' ->> 'file_path', s.submitted_by, nullif(trim(r ->> 'id'), ''))
    union all
    select 'instruction', u.file_name, u.file_path
      from submissions s join evidence_uploads u on u.upload_id = s.instruction_upload_id and u.uploaded_by = s.submitted_by
     where s.submission_id = p_submission
    union all
    select 'original', b.file_name, b.file_path
      from submissions s join upload_batches b on b.batch_id = s.batch_id and b.uploaded_by = s.submitted_by
     where s.submission_id = p_submission
  ) x
  where may_see_submission_detail(p_submission)
$$;

-- 4. Risks stay internal --------------------------------------------------------------------
create or replace function is_counterpart_person(p_person uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users u where u.person_id = p_person and u.app_role = 'viewer_counterpart')
$$;
comment on function is_counterpart_person(uuid) is 'Does this person sign in as a government counterpart (decision 91)? Called from triggers.';

create or replace function risks_owner_internal() returns trigger language plpgsql as $$
begin
  if new.owner_person_id is not null and is_counterpart_person(new.owner_person_id) then
    raise exception 'R01: a government counterpart cannot own a risk. Choose a programme owner.';
  end if;
  return new;
end $$;
create trigger risks_owner_internal before insert or update of owner_person_id on risks
  for each row execute function risks_owner_internal();

-- Defence in depth: someone who owns a risk and is later given the counterpart role still gets
-- no notice about it, in the app or by email.
create or replace function notification_no_risk_for_counterparts() returns trigger language plpgsql as $$
begin
  if new.object_type = 'risk' and new.person_id is not null and is_counterpart_person(new.person_id) then
    return null;
  end if;
  return new;
end $$;
create trigger notification_no_risk_for_counterparts before insert on notification_log
  for each row execute function notification_no_risk_for_counterparts();
