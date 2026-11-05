-- 0006: French labels for pathway stages (decision 13).
-- The seed's lookup list has the English code as the French label for five stages
-- (problem_identified, reform_agreed, technical_design, validation, institutionalised),
-- while the seed's pathway_stages table has the French labels. pathway_stages becomes the one
-- source for stage labels, and lookup_values copies from it. No label is written here by hand.
--
-- The seed loads after the migrations on a fresh database (and loads lookup_values before
-- pathway_stages), so a one-off update alone would miss it. The trigger keeps the two in step
-- whenever pathway_stages is loaded or edited; the update fixes databases seeded already.

create or replace function sync_pathway_stage_labels() returns trigger language plpgsql as $$
begin
  update lookup_values set label_en = new.label_en, label_fr = new.label_fr
   where list_name = 'pathway_stage' and code = new.code;
  return null;
end $$;

create trigger pathway_stages_sync_labels after insert or update on pathway_stages
  for each row execute function sync_pathway_stage_labels();

update lookup_values l set label_en = p.label_en, label_fr = p.label_fr
  from pathway_stages p
 where l.list_name = 'pathway_stage' and l.code = p.code;
