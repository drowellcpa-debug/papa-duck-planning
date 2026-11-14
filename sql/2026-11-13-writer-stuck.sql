-- 2026-11-13 Papa Duck: "3686 has been spinning?" / "will this be fixed in the future" (migration writer_stuck_autofix).
-- First time the writer gives up only on the photo-word check: add a writing note + retry. Still stuck: stop spinning, Launch Pad card.
-- Note: the live price-worker is v25 (repo file price-worker-v22.ts is older; not redeployed here).
create or replace function pipeline.drafts_writer_stuck() returns trigger language plpgsql as $$
declare cf jsonb := coalesce(new.pricing->'checks_failed','[]'::jsonb); photo_only boolean;
begin
  if not (new.price_stale and new.price_attempts >= 3 and coalesce(old.price_attempts,0) < 3) then return new; end if;
  photo_only := jsonb_array_length(cf) > 0 and not exists (select 1 from jsonb_array_elements_text(cf) x where x not like 'Talks about photos%');
  if photo_only and coalesce(new.answers->>'photo_retry','') = '' then
    new.answers := coalesce(new.answers,'{}'::jsonb) || jsonb_build_object('photo_retry','1',
      'tell', trim(coalesce(new.answers->>'tell','') || E'\nWriting rule: in the condition notes never use the words photo, photograph, photographs, pictured or observed - say pictures or illustrations, and state facts plainly.'));
    new.price_attempts := 0;
    return new;
  end if;
  new.price_stale := false;
  perform pipeline.alert_add('Drafts writer', 'Needs a look: ' || coalesce(new.pd, 'draft ' || new.id),
    'Claude could not finish the description for ' || coalesce(new.ident->>'title','this book') || ' after several tries (' || left(cf::text, 200) || '). Open it in Drafts and check the wording, or tell Claude.',
    new.pd, 'draft:' || new.id, 'need', 'writer-stuck:' || new.id);
  return new;
end $$;
drop trigger if exists drafts_writer_stuck on pipeline.drafts;
create trigger drafts_writer_stuck before update of price_attempts, price_stale on pipeline.drafts for each row execute function pipeline.drafts_writer_stuck();
-- Bin cleanup 11/13: duplicate Agent 146 scan (pile 312) taken out of Bin 2; empty claims Bin 3 (test 'sorter') and Bin 4 removed.
