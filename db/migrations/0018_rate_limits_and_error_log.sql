-- 0018: rate limits and the error log (build step 14, spec 01 section 11, docs/04 section 6,
-- decisions 63 and 64). Both are written by the server only.

-- ---------------------------------------------------------------------------
-- Rate limits: a fixed window per bucket and key (for example 'sign_in' and an email). Kept in
-- the database so limits hold across several copies of the app (decision 63).
-- ---------------------------------------------------------------------------
create table rate_limit_counters (
  bucket       text not null,
  key_hash     text not null,          -- sha256 of the key, so emails and addresses are not stored
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, key_hash, window_start)
);
alter table rate_limit_counters enable row level security;   -- no policies: the server only

-- Counts one hit and says whether it is within the limit. Old windows are cleared as it goes.
create or replace function hit_rate_limit(p_bucket text, p_key text, p_limit int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
        v_hits int;
begin
  insert into rate_limit_counters (bucket, key_hash, window_start, hits)
  values (p_bucket, encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), v_start, 1)
  on conflict (bucket, key_hash, window_start) do update set hits = rate_limit_counters.hits + 1
  returning hits into v_hits;
  delete from rate_limit_counters where window_start < now() - make_interval(secs => greatest(p_window_seconds, 3600) * 2) and random() < 0.05;
  return v_hits <= p_limit;
end $$;
comment on function hit_rate_limit(text, text, int, int) is 'internal: rate limits';
revoke execute on function hit_rate_limit(text, text, int, int) from public;

-- ---------------------------------------------------------------------------
-- Error log: one row per server error, with the reference shown to the person (decision 64).
-- No request bodies, cookies or query strings; messages are cleaned of emails and tokens first.
-- ---------------------------------------------------------------------------
create table error_log (
  error_id    bigserial primary key,
  reference   text not null unique,    -- shown on the error page, e.g. E-7K2Q9X
  at          timestamptz not null default now(),
  source      text not null check (source in ('request', 'job', 'email')),
  method      text,
  path        text,                    -- path only, never the query string
  status      int,
  user_id     uuid,                    -- who it happened to, if signed in
  error_name  text,
  message     text not null,
  detail      jsonb
);
create index on error_log (at desc);
alter table error_log enable row level security;
create policy error_log_read on error_log for select using (is_admin());

-- Alerts to super administrators about errors: at most one an hour each (the notice index holds it).
alter table notification_log drop constraint notification_log_kind_check;
alter table notification_log add constraint notification_log_kind_check check (kind in (
  'due_soon','overdue','escalation','weekly_digest','approval_needed','submission_approved','submission_returned',
  'gate_rejected','stale_item','training_suggested','entered_on_behalf',
  'risk_review','pathway_stalled','follow_up_list','email_sent','error_alert'));
