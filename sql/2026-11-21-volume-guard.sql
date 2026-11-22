-- 2026-11-21 Papa Duck: "from now on will it catch volume" -> "yes"
-- Trigger drafts_volume_guard: a numbered volume gets "Vol N" in the eBay title and a "📖 Volume: Volume N" line in the description;
-- a draft that looks like part of a numbered series with no readable number gets a Drafts warning to check the cover.
-- Dry run on all 67 open drafts 11/21: 0 titles / 0 descriptions / 0 warnings changed (no false hits). Year Books are left alone.
CREATE OR REPLACE FUNCTION pipeline.drafts_volume_guard()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare t text := coalesce(new.pricing->>'ebay_title', ''); b1 text := coalesce(new.pricing->>'b1', ''); b2 text := coalesce(new.pricing->>'b2', '');
  src text; n text; pile text; it text := coalesce(new.ident->>'title', ''); series boolean := false; k int;
  warn text := '📖 Volume number not found - check the cover and add "Vol #" to the title';
begin
  if new.built_at is not null or new.pricing is null or b2 = '' then return new; end if;
  select c.title into pile from pipeline.cleanup_piles c where upper(c.pd) = upper(new.pd) order by c.id desc limit 1;
  src := concat_ws(' ¦ ', t, new.ident->>'subtitle_or_series', it, pile, b1, (new.ident->'condition_notes')::text, new.ident->>'uncertainties');
  n := substring(src from '(?i)\mvol(?:ume)?\.?\s*#?\s*(\d{1,3})\M');
  if n is null and jsonb_typeof(new.ident->'set_books') = 'array' and jsonb_array_length(new.ident->'set_books') = 1 then
    n := nullif(regexp_replace(coalesce(new.ident->'set_books'->0->>'volume', ''), '\D', '', 'g'), '');
  end if;
  if n is not null then
    if b2 !~ '📖 Volume:' then
      k := position('Book Details</h3><ul>' in b2);
      if k > 0 then
        b2 := overlay(b2 placing 'Book Details</h3><ul><li>📖 Volume: Volume ' || n || '</li>' from k for length('Book Details</h3><ul>'));
        new.pricing := jsonb_set(new.pricing, '{b2}', to_jsonb(b2));
      end if;
    end if;
    if t <> '' and t !~* ('\mvol(ume)?\.?\s*#?\s*' || n || '\M') then
      if it <> '' and position(lower(it) in lower(t)) = 1 then t := left(t, length(it)) || ' Vol ' || n || substr(t, length(it) + 1);
      else t := t || ' Vol ' || n; end if;
      while length(t) > 80 and position(' ' in t) > 0 loop t := regexp_replace(t, '\s+\S+$', ''); end loop;
      new.pricing := jsonb_set(new.pricing, '{ebay_title}', to_jsonb(t));
    end if;
    if jsonb_typeof(new.flags) = 'array' then
      new.flags := coalesce((select jsonb_agg(x) from jsonb_array_elements(new.flags) x where x #>> '{}' <> warn), '[]'::jsonb);
    end if;
  else
    series := concat_ws(' ¦ ', it, new.ident->>'subtitle_or_series', pile) ~* '\mvol(ume)?\M'
      or coalesce(new.ident->>'uncertainties', '') ~* 'multi-volume|\d+-volume|volume number|which volume|only volume|volume \w+ of'
      or (it <> '' and exists (select 1 from pipeline.drafts o where o.id <> new.id and o.ident->>'title' = it
                               and o.created_at > now() - interval '60 days' and o.pricing->>'ebay_title' ~* '\mvol(ume)?\.?\s*\d'));
    if series and not coalesce(new.flags, '[]'::jsonb) @> to_jsonb(array[warn]) then
      new.flags := coalesce(new.flags, '[]'::jsonb) || to_jsonb(array[warn]);
    end if;
  end if;
  return new;
end $function$;
drop trigger if exists drafts_volume_guard on pipeline.drafts;
create trigger drafts_volume_guard before insert or update of pricing, ident on pipeline.drafts
  for each row execute function pipeline.drafts_volume_guard();
