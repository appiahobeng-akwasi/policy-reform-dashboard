-- 0016: review packs (build step 13, spec 01 sections 8 and 9, decisions 53 to 57).
--
-- A pack is what the Secretariat prepares for a monthly Pillar 1 review or a Quarterly Strategy
-- Review: the facts as they stood when it was prepared, saved as a numbered version that never
-- changes (decision 54). It is a record of what was put in front of the meeting, not business
-- data: decisions taken at the meeting are entered through the usual route and approved.

create table review_packs (
  pack_id       uuid primary key default gen_random_uuid(),
  review_type   text not null check (review_type in ('monthly_pillar_review', 'quarterly_strategy_review')),
  review_date   date not null,
  version       int not null check (version >= 1),
  -- What "since the last review" meant for this pack (decision 56).
  window_start  timestamptz not null,
  generated_at  timestamptz not null default now(),
  generated_by  uuid not null references app_users,
  -- Kept with the pack: readers may not see other accounts, and the pack records who prepared it then.
  generated_by_name text not null,
  data          jsonb not null,
  unique (review_type, review_date, version)
);
create index on review_packs (review_type, generated_at desc);

alter table review_packs enable row level security;
-- Internal users read packs; counterparts do not, as packs hold risks and decisions (decision 55).
create policy review_packs_read on review_packs for select using (is_internal());
-- Admins prepare them, as themselves. Nobody changes or deletes one (no update or delete policy).
create policy review_packs_insert on review_packs for insert
  with check (is_admin() and generated_by = (me()).user_id);

-- Versions number up per review: 1, 2, 3. Set here so two admins preparing at once cannot clash.
create or replace function review_pack_version() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('review_pack:' || new.review_type || ':' || new.review_date));
  select coalesce(max(version), 0) + 1 into new.version
    from review_packs where review_type = new.review_type and review_date = new.review_date;
  new.generated_at := now();
  select coalesce(p.full_name, u.email) into new.generated_by_name
    from app_users u left join people p on p.person_id = u.person_id where u.user_id = new.generated_by;
  return new;
end $$;
comment on function review_pack_version() is 'internal: review packs';
create trigger review_packs_version before insert on review_packs for each row execute function review_pack_version();

-- Once saved, a pack is fixed, even for the server.
create or replace function review_pack_frozen() returns trigger language plpgsql as $$
begin
  raise exception 'R01: a review pack cannot be changed or deleted; prepare a new version instead';
end $$;
comment on function review_pack_frozen() is 'internal: review packs';
create trigger review_packs_frozen before update or delete on review_packs for each row execute function review_pack_frozen();
