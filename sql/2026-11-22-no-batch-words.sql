-- 2026-11-22 Papa Duck: "I want it not to say anything about batch of X or set unless I indicate Set in our book station"
-- strip_batch_words(t, keep_sets): removes Qty N / BATCH LOT / batch of N / N copies / (x3) / (1 sold ..., 5 left); "set/lot/pack of N" too unless keep_sets.
-- Trigger drafts_no_batch_words: every new draft's eBay title + name is cleaned; a book marked Set in the Book Station keeps its set wording.
-- One-time clean: 31 live Airtable names (PD-0009..PD-2278) had "- Qty N" / BATCH LOT wording removed (Quantity field was already right on each);
--   left alone on purpose: PD-1966 ("Set of 2 Copies" bundle), PD-0950 (2 copies + manipulatives bundle), PD-6123 (only a trailing comma).
--   Real old multi-book sets ("Set of 2" teacher editions etc.) kept their set wording.
-- PD-0047: renamed everywhere back to its old eBay wording "BJU Press Bible Truths 5 Living in God's Love Student Worktext 4th Ed Homeschool".
CREATE OR REPLACE FUNCTION pipeline.strip_batch_words(t text, keep_sets boolean default false) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
declare s text := coalesce(t, '');
begin
  s := regexp_replace(s, '\s*\(\s*(batch(\s+lot)?\s*,?\s*)?(qty|quantity)\.?\s*:?\s*\d+[^)]*\)', '', 'gi');
  s := regexp_replace(s, '\s*\(\s*\d+\s+sold[^)]*\)', '', 'gi');
  s := regexp_replace(s, '\s*[-–—,]?\s*\m(qty|quantity)\.?\s*:?\s*\d+\M', '', 'gi');
  s := regexp_replace(s, '\s*[-–—,]?\s*\mbatch(\s+lot)?(\s+of\s+\d+)?(\s+identical)?(\s+(copies|units))?\M', '', 'gi');
  s := regexp_replace(s, '\s*\(\s*\d+\s+(identical\s+)?(copies|units)[^)]*\)', '', 'gi');
  s := regexp_replace(s, '\s*[-–—,]?\s*\m\d+\s+(identical\s+)?(copies|units)(\s+available)?\M', '', 'gi');
  s := regexp_replace(s, '\s*\(\s*x\s*\d+\s*\)', '', 'gi');
  if not keep_sets then
    s := regexp_replace(s, '\(\s*(lot|set|pack|bundle)\s+of\s+\d+\s*\)', '', 'gi');
    s := regexp_replace(s, '\(\s*(lot|set|pack|bundle)\s+of\s+\d+\s*,\s*', '(', 'gi');
    s := regexp_replace(s, '\s*[-–—,]?\s*\m(lot|set|pack|bundle)\s+of\s+\d+\M', '', 'gi');
  end if;
  s := regexp_replace(s, '\(\s*\)', '', 'g');
  s := regexp_replace(s, '\s{2,}', ' ', 'g');
  s := regexp_replace(s, '\s*[-–—,:]\s*$', '', 'g');
  s := btrim(s, ' -–—,');
  return nullif(s, '');
end $$;
CREATE OR REPLACE FUNCTION pipeline.drafts_no_batch_words() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pipeline', 'pg_catalog' AS $$
declare is_set boolean := coalesce(new.is_set, false) or coalesce(new.answers->'station'->>'block', '') ~* 'Set: Yes'; t text;
begin
  if new.built_at is not null then return new; end if;
  if new.pricing ? 'ebay_title' then
    t := pipeline.strip_batch_words(new.pricing->>'ebay_title', is_set);
    if t is not null and t is distinct from new.pricing->>'ebay_title' then new.pricing := jsonb_set(new.pricing, '{ebay_title}', to_jsonb(t)); end if;
  end if;
  if new.ident ? 'title' then
    t := pipeline.strip_batch_words(new.ident->>'title', is_set);
    if t is not null and t is distinct from new.ident->>'title' then new.ident := jsonb_set(new.ident, '{title}', to_jsonb(t)); end if;
  end if;
  return new;
end $$;
drop trigger if exists drafts_no_batch_words on pipeline.drafts;
create trigger drafts_no_batch_words before insert or update of pricing, ident on pipeline.drafts for each row execute function pipeline.drafts_no_batch_words();
