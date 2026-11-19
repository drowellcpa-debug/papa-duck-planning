-- 2026-11-18 Papa Duck: "invetory sticker, I will always indicate if a library book".
-- PD-6105 New Jerusalem Bible said its spine sticker "may be a library or inventory sticker"; PD-6097, PD-6101 and PD-6106 were written up
-- as ex-library because the photo reader saw our own pink PD-number label. Rule: a book is ex-library ONLY when he flags it at the
-- Book Station (the notes then carry "- Ex-library: he flagged library markings."). Otherwise the photo reader's ex_library guess is
-- set to No and the notes tell the listing writer the number sticker is his removable inventory label.
create or replace function pipeline.exlib_only_when_flagged() returns trigger
language plpgsql set search_path to 'pipeline', 'pg_catalog' as $f$
declare t text := coalesce(new.answers->>'tell', '');
begin
  if t like 'FROM THE BOOK STATION%' and t !~* 'ex-library: he flagged' then
    if new.ident is not null and new.ident ? 'ex_library' and coalesce(new.ident->>'ex_library', '') !~* '^no' then
      new.ident := jsonb_set(new.ident, '{ex_library}',
        to_jsonb('No - Papa Duck did not flag library markings; a small number sticker on the spine or cover is his own removable inventory label'::text));
    end if;
    if position('INVENTORY LABEL:' in t) = 0 then
      new.answers := jsonb_set(new.answers, '{tell}', to_jsonb(t || E'\n- INVENTORY LABEL: a small (often pink) number sticker on the spine or cover showing the PD number is Papa Duck''s own removable inventory label. This is NOT an ex-library book - never call it a library sticker, call-number label or library processing. He always marks a library book himself.'));
    end if;
  end if;
  return new;
end $f$;

drop trigger if exists drafts_exlib_only_when_flagged on pipeline.drafts;
create trigger drafts_exlib_only_when_flagged before insert or update of answers, ident on pipeline.drafts
  for each row execute function pipeline.exlib_only_when_flagged();
