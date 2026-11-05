-- 0014: users and access admin, and the data quality page (build step 11, decisions 42 to 46).
--
-- User and access changes are direct admin actions, recorded in the audit log (decision 42):
-- app_users, user_reform_scope and people are access and reference data, not delivery data,
-- so they do not go through the submission gate. The guards below live in the database, so
-- they hold whatever path the change takes.

-- ---------------------------------------------------------------------------
-- An empty claims setting (a server connection after a signed-in request) means nobody is
-- signed in. 0003 cast it to jsonb and failed; the audit log below now asks on every write.
-- ---------------------------------------------------------------------------
create or replace function current_auth_uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- The audit log names the signed-in person when no workflow function has set the actor.
-- ---------------------------------------------------------------------------
create or replace function audit_row() returns trigger language plpgsql security definer set search_path = public as $$
declare pk text; rec jsonb;
begin
  rec := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  pk := coalesce(rec ->> tg_argv[0], '?');
  insert into audit_log (table_name, record_id, action, before, after, actor_user_id, on_behalf_of_person_id, submission_id)
  values (tg_table_name, pk, lower(tg_op),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
          coalesce(nullif(current_setting('app.actor_user_id', true), '')::uuid, (me()).user_id),
          nullif(current_setting('app.on_behalf_of', true), '')::uuid,
          nullif(current_setting('app.submission_id', true), '')::uuid);
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- People: admins add and edit them (decision 24 said "until the users page"); every change is audited.
-- ---------------------------------------------------------------------------
create policy people_admin_insert on people for insert with check (is_admin());
create policy people_admin_update on people for update using (is_admin()) with check (is_admin());
create trigger people_audit after insert or update or delete on people for each row execute function audit_row('person_id');

-- ---------------------------------------------------------------------------
-- Guards on accounts. Codes U01 to U05 map to messages in the app.
--   U01  nobody changes their own role or turns off their own account
--   U02  only a super administrator creates or changes a super administrator
--   U03  the sign-in link (auth_user_id) is set by sign-in, never by hand
--   U04  accounts are turned off, not deleted
--   U05  there must always be one active super administrator
-- U02 to U04 apply to signed-in people; U05 applies to everyone, the server included.
-- ---------------------------------------------------------------------------
create or replace function guard_app_users() returns trigger language plpgsql security definer set search_path = public as $$
declare v_me app_users; v_user_session boolean := current_auth_uid() is not null;
begin
  if v_user_session then
    v_me := me();
    if tg_op = 'DELETE' then
      raise exception 'U04: accounts are turned off, not deleted';
    end if;
    if tg_op = 'UPDATE' and old.user_id = v_me.user_id and (new.app_role <> old.app_role or not new.is_active) then
      raise exception 'U01: you cannot change your own role or turn off your own account';
    end if;
    if (new.app_role = 'super_admin' or (tg_op = 'UPDATE' and old.app_role = 'super_admin'))
       and v_me.app_role is distinct from 'super_admin' then
      raise exception 'U02: only a super administrator can create or change a super administrator';
    end if;
    if tg_op = 'INSERT' and new.auth_user_id is not null
       or tg_op = 'UPDATE' and new.auth_user_id is distinct from old.auth_user_id and new.auth_user_id is not null then
      raise exception 'U03: the sign-in link is set when the person signs in';
    end if;
  end if;

  if tg_op in ('UPDATE', 'DELETE') and old.app_role = 'super_admin' and old.is_active
     and (tg_op = 'DELETE' or new.app_role <> 'super_admin' or not new.is_active)
     and not exists (select 1 from app_users u where u.app_role = 'super_admin' and u.is_active and u.user_id <> old.user_id) then
    raise exception 'U05: there must always be one active super administrator';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  new.email := lower(trim(new.email));
  -- A new address signs in as a new identity: the old one must not keep access.
  if tg_op = 'UPDATE' and new.email <> old.email then
    new.auth_user_id := null;
  end if;
  return new;
end $$;
comment on function guard_app_users() is 'internal: account guards';
create trigger app_users_guard before insert or update or delete on app_users for each row execute function guard_app_users();

-- Only a super administrator changes a super administrator's reforms.
drop policy scope_admin on user_reform_scope;
create policy scope_admin on user_reform_scope for all
  using (is_admin() and (my_role() = 'super_admin' or not exists (select 1 from app_users u where u.user_id = user_reform_scope.user_id and u.app_role = 'super_admin')))
  with check (is_admin() and (my_role() = 'super_admin' or not exists (select 1 from app_users u where u.user_id = user_reform_scope.user_id and u.app_role = 'super_admin')));

-- ---------------------------------------------------------------------------
-- Resetting a lost authenticator app (decision 45): super administrators only, never their own,
-- recorded in the audit log. The app calls this first, then asks the sign-in provider to remove
-- the factor, in the same transaction: if the provider fails, the record is rolled back.
-- Returns the sign-in identity to reset, or null if the person has never signed in.
-- ---------------------------------------------------------------------------
create or replace function record_mfa_reset(p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_me app_users := me(); v_target app_users;
begin
  if v_me.app_role is distinct from 'super_admin' then
    raise exception 'U02: only a super administrator can reset an authenticator app';
  end if;
  if p_user = v_me.user_id then
    raise exception 'U01: you cannot reset your own authenticator app';
  end if;
  select * into v_target from app_users where user_id = p_user;
  if not found then
    raise exception 'U06: there is no such account';
  end if;
  insert into audit_log (table_name, record_id, action, before, after, actor_user_id)
  values ('authenticator_app', p_user::text, 'delete', jsonb_build_object('email', v_target.email), null, v_me.user_id);
  return v_target.auth_user_id;
end $$;

-- ---------------------------------------------------------------------------
-- Training notices (03 section 8, decision 43): an admin sends one in-app notice naming up to
-- three rules. The notice shows each rule's own message in the person's language. Once a day.
-- ---------------------------------------------------------------------------
create or replace function send_training_notice(p_user uuid, p_rules text[]) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_person uuid; v_sent int;
begin
  if not is_admin() then
    raise exception 'U02: only administrators can send training notices';
  end if;
  if coalesce(array_length(p_rules, 1), 0) not between 1 and 3
     or exists (select 1 from unnest(p_rules) r where r !~ '^[A-Z][0-9]{2}$') then
    raise exception 'U07: name one to three rules';
  end if;
  select person_id into v_person from app_users where user_id = p_user and is_active;
  if v_person is null then
    raise exception 'U06: there is no such account';
  end if;
  insert into notification_log (kind, person_id, channel, object_type, object_id, status)
  values ('training_suggested', v_person, 'in_app', 'dq_rules', array_to_string(p_rules, ','), 'queued')
  on conflict do nothing;
  get diagnostics v_sent = row_count;
  return v_sent > 0;
end $$;

-- ---------------------------------------------------------------------------
-- The data quality page filters runs by month, user and submission.
-- ---------------------------------------------------------------------------
create index on dq_runs (started_at);
create index on dq_runs (run_by, started_at);
create index on dq_runs (submission_id);
create index on dq_runs (previous_run_id);
