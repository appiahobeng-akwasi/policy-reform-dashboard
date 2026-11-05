-- 0003: row-level security. The database is the gatekeeper; the UI only hides buttons.
-- Identity: the request's JWT subject. On Supabase this is auth.uid(); the helper below reads
-- the same claim through PostgREST settings so the policies stay portable.
--
-- Write model: NOBODY except super_admin and the server-side "applier" writes live business
-- tables directly. Users write to submissions; an approved submission is applied by a
-- security-definer function (apply_submission) that sets app.actor_user_id for the audit log.

create or replace function current_auth_uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')), '')::uuid
$$;

create or replace function me() returns app_users language sql stable security definer set search_path = public as $$
  select * from app_users where auth_user_id = current_auth_uid() and is_active
$$;

create or replace function my_role() returns text language sql stable as $$ select (me()).app_role $$;
create or replace function is_admin() returns boolean language sql stable as $$ select my_role() in ('super_admin','programme_admin') $$;
create or replace function is_internal() returns boolean language sql stable as $$
  select my_role() in ('super_admin','programme_admin','reform_lead','contributor','merl_officer','viewer_internal') $$;
create or replace function in_reform_scope(p_reform text) returns boolean language sql stable security definer set search_path = public as $$
  select is_admin() or exists (select 1 from user_reform_scope s where s.user_id = (me()).user_id and s.reform_id = p_reform) $$;
create or replace function can_approve_reform(p_reform text) returns boolean language sql stable security definer set search_path = public as $$
  select is_admin() or exists (select 1 from user_reform_scope s where s.user_id = (me()).user_id and s.reform_id = p_reform and s.can_approve) $$;

-- Read rules
--   internal roles: read everything that is not archived
--   viewer_counterpart (government): read only reforms in their scope, and only evidence with access_level in ('external','public')
do $$
declare t text;
begin
  foreach t in array array['reforms','workstreams','deliverables','activities','milestones','reform_stages','risks','risk_links','decisions','decision_links',
                           'actions','adaptations','adaptation_links','evidence_items','evidence_links','indicators','indicator_reform_links','indicator_values',
                           'disaggregation_facts','readiness_assessments','learning_log','governance_raci','reviews','escalations','reform_status_snapshots',
                           'publications','dependencies','lookup_values','pathway_stages','institutions','people','reporting_periods']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_read_internal on %I for select using (is_internal())', t, t);
    execute format('create policy %I_write_super on %I for all using (my_role() = ''super_admin'') with check (my_role() = ''super_admin'')', t, t);
  end loop;
end $$;

-- Counterpart read access, reform-scoped
create policy reforms_read_cp on reforms for select using (my_role() = 'viewer_counterpart' and in_reform_scope(reform_id));
create policy ws_read_cp on workstreams for select using (my_role() = 'viewer_counterpart' and in_reform_scope(reform_id));
create policy dl_read_cp on deliverables for select using (my_role() = 'viewer_counterpart' and exists (select 1 from workstreams w where w.workstream_id = deliverables.workstream_id and in_reform_scope(w.reform_id)));
create policy ac_read_cp on activities for select using (my_role() = 'viewer_counterpart' and exists (select 1 from deliverables d join workstreams w using (workstream_id) where d.deliverable_id = activities.deliverable_id and in_reform_scope(w.reform_id)));
create policy ms_read_cp on milestones for select using (my_role() = 'viewer_counterpart' and (scope = 'programme' or in_reform_scope(reform_id)));
create policy st_read_cp on reform_stages for select using (my_role() = 'viewer_counterpart' and in_reform_scope(reform_id));
create policy ev_read_cp on evidence_items for select using (my_role() = 'viewer_counterpart' and access_level in ('external','public'));
create policy lk_read_all on lookup_values for select using (me() is not null);
create policy ps_read_all on pathway_stages for select using (me() is not null);
-- Risks, decisions, adaptations, readiness and RACI are internal only (political sensitivity). Confirm with Project Lead.

-- Submissions, gate runs and findings
alter table submissions enable row level security;
alter table upload_batches enable row level security;
alter table dq_runs enable row level security;
alter table dq_findings enable row level security;
alter table audit_log enable row level security;
alter table notification_log enable row level security;
alter table app_users enable row level security;
alter table user_reform_scope enable row level security;
alter table dq_rulesets enable row level security;

create policy sub_insert_own on submissions for insert with check (submitted_by = (me()).user_id and my_role() in ('super_admin','programme_admin','reform_lead','contributor','merl_officer'));
create policy sub_read_own on submissions for select using (submitted_by = (me()).user_id or is_admin() or my_role() = 'reform_lead');
create policy sub_withdraw_own on submissions for update using (submitted_by = (me()).user_id and status in ('draft','rejected_by_gate','proposed','returned'))
  with check (status in ('draft','withdrawn'));
-- Approval is done only through approve_submission() (security definer), which checks can_approve_reform for every row.

create policy ub_insert_own on upload_batches for insert with check (uploaded_by = (me()).user_id);
create policy ub_read on upload_batches for select using (uploaded_by = (me()).user_id or is_admin());

-- Per-user data quality detail is visible to the user themself and to admins only. Never to other users.
create policy dq_read on dq_runs for select using (run_by = (me()).user_id or is_admin());
create policy dqf_read on dq_findings for select using (exists (select 1 from dq_runs r where r.dq_run_id = dq_findings.dq_run_id and (r.run_by = (me()).user_id or is_admin())));
create policy rules_read on dq_rulesets for select using (me() is not null);
create policy rules_write on dq_rulesets for all using (my_role() = 'super_admin') with check (my_role() = 'super_admin');

create policy audit_read on audit_log for select using (is_admin());
create policy notif_read on notification_log for select using (is_admin() or person_id = (me()).person_id);
create policy users_read_self on app_users for select using (user_id = (me()).user_id or is_admin());
create policy users_admin on app_users for all using (is_admin()) with check (is_admin() and (app_role <> 'super_admin' or my_role() = 'super_admin'));
create policy scope_read on user_reform_scope for select using (user_id = (me()).user_id or is_admin());
create policy scope_admin on user_reform_scope for all using (is_admin()) with check (is_admin());

-- Admins must use MFA (enforced in the app at sign-in; flag kept in data)
create or replace function force_admin_mfa() returns trigger language plpgsql as $$
begin
  if new.app_role in ('super_admin','programme_admin') then new.mfa_required := true; end if;
  return new;
end $$;
create trigger app_users_force_mfa before insert or update on app_users for each row execute function force_admin_mfa();

-- Sign-in allowlist: the app calls this after the identity provider returns, and signs the
-- user out if it returns false. Personal Gmail accounts are fine as long as they are listed.
create or replace function is_allowed_email(p_email text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where lower(email) = lower(p_email) and is_active)
$$;

-- apply_submission(p_submission uuid) and approve_submission(p_submission uuid, p_note text)
-- are implemented in 0004 by the build (see docs/03_DATA_QUALITY_GATE.md section 6 for the exact behaviour):
--   1. lock the submission row; require status = 'proposed' and a passing dq_run on the CURRENT ruleset
--   2. re-run blocking rules B03, B11, B12 against live data (things may have changed since the gate)
--   3. require can_approve_reform() for every reform touched; approver must not be the submitter (four-eyes)
--      except super_admin in break-glass mode, which is logged
--   4. set local app.actor_user_id / app.on_behalf_of / app.submission_id, then upsert rows, set last_confirmed_at = now()
--   5. mark submission applied; write notification 'approval_needed' resolved; notify submitter
