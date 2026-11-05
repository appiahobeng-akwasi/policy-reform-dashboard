-- Supabase only. db:reset and db:migrate run this file when the role 'supabase_auth_admin'
-- exists. supabase/config.toml points the "before user created" hook here.
--
-- The app sends sign-in links only to listed emails, but Supabase's sign-in API is public.
-- This hook stops it creating a sign-in identity for any email that is not on the list, so
-- nobody can use the API directly to get links sent to unlisted addresses.

create or replace function hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if is_allowed_email(event -> 'user' ->> 'email') then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This email address is not registered for the dashboard.'));
end $$;
comment on function hook_before_user_created(jsonb) is 'internal: Supabase sign-in hook';

revoke execute on function hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function hook_before_user_created(jsonb) to supabase_auth_admin;
