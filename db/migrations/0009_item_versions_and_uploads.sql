-- 0009: build step 6 (update form and evidence upload).
--   1. No silent overwrites. An update row may carry base_updated_at: the item's updated_at
--      when the person opened the form. If someone else's change was applied since, approval
--      refuses with W10 and the submitter must look again.
--   2. evidence_uploads: files the server has received and checked (type from the file's own
--      bytes, size, fingerprint). A submission refers to an upload by its ID; the server fills in
--      the file details from here, so a browser cannot claim a file it did not upload.

create or replace function check_row_version(p_row jsonb, p_n int) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_entity text := p_row ->> 'entity';
  v_id text := nullif(trim(p_row ->> 'id'), '');
  v_stored timestamptz;
begin
  if p_row ->> 'op' <> 'update' or v_id is null or nullif(p_row ->> 'base_updated_at', '') is null then return; end if;
  v_stored := (object_record(v_entity, v_id) ->> 'updated_at')::timestamptz;
  if v_stored is not null and v_stored <> (p_row ->> 'base_updated_at')::timestamptz then
    perform workflow_error('W10', p_n, 'updated_at', v_stored::text, 'the item changed after this update was started');
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
  -- Version checks first, before anything is written.
  for r in select value from jsonb_array_elements(s.payload -> 'rows') loop
    n := n + 1;
    perform check_row_version(r, n);
  end loop;
  n := 0;
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

revoke execute on function check_row_version(jsonb, int) from public;
comment on function check_row_version(jsonb, int) is 'internal: approval workflow';

create table evidence_uploads (
  upload_id    uuid primary key default gen_random_uuid(),
  uploaded_by  uuid not null references app_users,
  file_name    text not null,             -- the name on the person's device, for display
  file_path    text not null,             -- storage key: evidence/{yyyy}/{sha256}.{ext}
  file_sha256  text not null,
  file_mime    text not null,
  file_bytes   bigint not null check (file_bytes > 0),
  created_at   timestamptz not null default now()
);
create index on evidence_uploads (uploaded_by);
create index on evidence_uploads (file_sha256);

-- Written only by the server after it has checked the file; people see their own uploads.
alter table evidence_uploads enable row level security;
create policy eu_read_own on evidence_uploads for select using (uploaded_by = (me()).user_id or is_admin());
