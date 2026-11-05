-- 0017: readiness score for the Portfolio view (decision 58).
--
-- The source scores (72, 68, 64) cannot be traced to the ratings (docs/02 section 7). This is the
-- proposed method v1 from docs/02: High = 3, Medium = 2, Low = 1; score = sum of the six ratings
-- / 18 x 100, rounded. It is shown as "proposed, not yet agreed" until the Project Lead agrees it.
-- Null if any rating is missing: a partial assessment has no score (never invent data).

create or replace function readiness_score_v1(VARIADIC p_ratings text[]) returns int
language sql immutable as $$
  select case when count(*) filter (where r in ('high', 'medium', 'low')) = 6
              then round(sum(case r when 'high' then 3 when 'medium' then 2 when 'low' then 1 end) / 18.0 * 100)::int end
    from unnest(p_ratings) as r
$$;

create or replace view v_readiness with (security_invoker = on) as
  select a.readiness_id, a.reform_id, a.assessment_date, a.assessor, a.comments,
         a.political_commitment, a.institutional_ownership, a.technical_readiness, a.financial_readiness,
         a.stakeholder_alignment, a.implementation_capacity,
         readiness_score_v1(a.political_commitment, a.institutional_ownership, a.technical_readiness, a.financial_readiness,
                            a.stakeholder_alignment, a.implementation_capacity) as score_proposed,
         'v1_proposed'::text as score_method,
         a.overall_score_source,
         row_number() over (partition by a.reform_id order by a.assessment_date desc nulls last, a.readiness_id desc) = 1 as is_latest
    from readiness_assessments a;
