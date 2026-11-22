-- 2026-11-21 Papa Duck: PD-0326 "seems to be stuck" -> "is this fixed for the future"
-- The description writer kept writing "photographed in Mexico" (about the book's own cover picture), failed the photo-word check
-- 3 times and the draft stayed stuck. Now, when only the photo-word check keeps failing, the words are swapped automatically
-- (photographs -> pictures, photographed in -> from, pictured -> shown, observed -> noted) and the draft moves on.
-- Any other failure still stops and puts "Needs a look" on the Launch Pad.
CREATE OR REPLACE FUNCTION pipeline.drafts_writer_stuck()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
declare cf jsonb := coalesce(new.pricing->'checks_failed','[]'::jsonb); photo_only boolean; b1 text; b2 text;
begin
  if not (new.price_stale and new.price_attempts >= 3) then return new; end if;
  photo_only := jsonb_array_length(cf) > 0 and not exists (select 1 from jsonb_array_elements_text(cf) x where x not like 'Talks about photos%');
  if coalesce(old.price_attempts,0) < 3 and photo_only and coalesce(new.answers->>'photo_retry','') = '' then
    new.answers := coalesce(new.answers,'{}'::jsonb) || jsonb_build_object('photo_retry','1',
      'tell', trim(coalesce(new.answers->>'tell','') || E'\nWriting rule: in the condition notes never use the words photo, photograph, photographs, pictured or observed - say pictures or illustrations, and state facts plainly.'));
    new.price_attempts := 0;
    return new;
  end if;
  if photo_only and new.pricing is not null then
    b1 := coalesce(new.pricing->>'b1',''); b2 := coalesce(new.pricing->>'b2','');
    b1 := regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(b1, '\mphotographed in\M', 'from', 'gi'), '\mphotographed\M', 'shown', 'gi'), '\mphoto(graph)?s\M', 'pictures', 'gi'), '\mphoto(graph)?\M', 'picture', 'gi'), '\mpictured\M', 'shown', 'gi');
    b2 := regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(b2, '\mphotographed in\M', 'from', 'gi'), '\mphotographed\M', 'shown', 'gi'), '\mphoto(graph)?s\M', 'pictures', 'gi'), '\mphoto(graph)?\M', 'picture', 'gi'), '\mpictured\M', 'shown', 'gi');
    b1 := regexp_replace(b1, '\mobserved\M', 'noted', 'gi'); b2 := regexp_replace(b2, '\mobserved\M', 'noted', 'gi');
    new.pricing := new.pricing || jsonb_build_object('b1', b1, 'b2', b2, 'checks_failed', '[]'::jsonb);
    new.price_stale := false;
    update pipeline.alerts set done_at = now() where dedupe = 'writer-stuck:' || new.id and done_at is null;
    return new;
  end if;
  -- not photo-only: stop retrying and put it on the Launch Pad (dedupe keeps it to one alert)
  new.price_stale := false;
  perform pipeline.alert_add('Drafts writer', 'Needs a look: ' || coalesce(new.pd, 'draft ' || new.id),
    'Claude could not finish the description for ' || coalesce(new.ident->>'title','this book') || ' after several tries (' || left(cf::text, 200) || '). Open it in Drafts and check the wording, or tell Claude.',
    new.pd, 'draft:' || new.id, 'need', 'writer-stuck:' || new.id);
  return new;
end $function$;
drop trigger if exists drafts_writer_stuck on pipeline.drafts;
create trigger drafts_writer_stuck before update of price_attempts, price_stale, pricing on pipeline.drafts
  for each row execute function pipeline.drafts_writer_stuck();
