-- 0007: sign-in support (build step 3).
--   1. MFA is enforced by the database, not only the app (decision 17): a user whose account
--      needs MFA (super_admin, programme_admin) is nobody until their session has passed the
--      second step, which the identity provider records as aal = 'aal2' in the JWT claims.
--   2. link_auth_user(): on first sign-in the server links the identity provider's user ID to
--      the account with that email, and records each sign-in.
--   3. set_my_language(): a signed-in user may change their own language preference directly
--      (decision 16). It is a preference, not programme data, so it skips submission and approval.

create or replace function current_auth_aal() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claim.aal', true),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal')
$$;

create or replace function me() returns app_users language sql stable security definer set search_path = public as $$
  select u.* from app_users u
   where u.auth_user_id = current_auth_uid() and u.is_active
     and (not u.mfa_required or current_auth_aal() = 'aal2')
$$;

-- Returns the account's user_id, or null when the email is not on the list, the account is
-- inactive, or the email is already linked to a different sign-in identity.
create or replace function link_auth_user(p_email text, p_auth_user_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  update app_users
     set auth_user_id = p_auth_user_id, last_sign_in_at = now()
   where lower(email) = lower(p_email) and is_active
     and (auth_user_id is null or auth_user_id = p_auth_user_id)
  returning user_id into v_user;
  return v_user;
end $$;
revoke execute on function link_auth_user(text, uuid) from public;
comment on function link_auth_user(text, uuid) is 'internal: called by the server after a verified sign-in';

create or replace function set_my_language(p_lang text) returns void
language plpgsql security definer set search_path = public as $$
declare v_person uuid := (me()).person_id;
begin
  if p_lang is null or p_lang not in ('en', 'fr') then
    perform workflow_error('W07', null, 'preferred_language', p_lang, 'language must be en or fr');
  end if;
  if v_person is null then
    perform workflow_error('W05', null, null, null, 'only a signed-in user can save a language');
  end if;
  update people set preferred_language = p_lang where person_id = v_person;
end $$;
