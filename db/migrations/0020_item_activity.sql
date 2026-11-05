-- 0020: an item's activity (decision 81, workflow step W3). The item panel's Activity tab lists
-- when updates about the item were sent, approved and returned, by whom, with the approver's
-- note. Only the item's owner, the leads of its reform and admins see it; everyone else gets no
-- rows (other people keep seeing just the last update line, item_last_update in 0011).
-- Read-only; drafts, withdrawn updates and updates the checks stopped are not shown.

create or replace function item_activity(p_type text, p_id text)
returns table (at timestamptz, event text, actor text, for_person text, note text, route text, submission_id uuid)
language sql stable security definer set search_path = public as $$
  with item as (
    select f.owner_person_id, f.reform_id
      from v_delivery_flags f
     where f.object_type = p_type and f.object_id = p_id
  ), allowed as (
    select 1 from item i
     where (select is_admin())
        or i.owner_person_id = (select (me()).person_id)
        or ((select my_role()) = 'reform_lead' and i.reform_id = any (my_reform_ids()))
  ), subs as (
    select s.*
      from submissions s
     where exists (select 1 from allowed)
       and s.status in ('proposed', 'approved', 'returned', 'applied')
       and s.payload -> 'rows' @> jsonb_build_array(jsonb_build_object('entity', p_type, 'id', p_id))
  )
  select e.at, e.event, e.actor, e.for_person, e.note, e.route, e.submission_id from (
    select s.created_at as at, 'sent'::text as event, ps.full_name as actor, pf.full_name as for_person,
           null::text as note, s.route, s.submission_id
      from subs s
      join app_users us on us.user_id = s.submitted_by
      left join people ps on ps.person_id = us.person_id
      left join people pf on pf.person_id = s.on_behalf_of_person_id
    union all
    select s.reviewed_at, case when s.status = 'returned' then 'returned' else 'approved' end, pr.full_name, null,
           s.review_note, s.route, s.submission_id
      from subs s
      join app_users ur on ur.user_id = s.reviewer
      left join people pr on pr.person_id = ur.person_id
     where s.reviewed_at is not null and s.status in ('approved', 'applied', 'returned')
  ) e
  -- At the same moment, a decision comes before the sending it answers.
  order by e.at desc, (e.event = 'sent')
  limit 50
$$;

comment on function item_activity(text, text) is 'An item''s activity for its owner, the leads of its reform and admins (decision 81).';
