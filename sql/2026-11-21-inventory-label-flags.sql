-- 2026-11-21 Papa Duck: "326 description is not correct either, see the warning you giave me"
-- The cloud read kept calling his own PD inventory stickers "library labels". exlib_only_when_flagged now also drops
-- "Ex-library: Yes" warnings and library condition notes on Book Station drafts he did not flag, and runs when flags change too.
CREATE OR REPLACE FUNCTION pipeline.exlib_only_when_flagged()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pipeline', 'pg_catalog'
AS $function$
declare t text := coalesce(new.answers->>'tell', ''); said_yes boolean;
begin
  select exists (select 1 from jsonb_array_elements(case when jsonb_typeof(new.questions) = 'array' then new.questions else '[]'::jsonb end) with ordinality q(v, i)
                  where q.v->>'q' ~* 'librar' and coalesce(new.answers->>((q.i - 1)::text), '') ~* '^\s*(yes|y\b|yep|it is)') into said_yes;
  if t like 'FROM THE BOOK STATION%' and t !~* 'ex-library: he flagged' and not said_yes then
    if new.ident is not null and new.ident ? 'ex_library' and coalesce(new.ident->>'ex_library', '') !~* '^no' then
      new.ident := jsonb_set(new.ident, '{ex_library}',
        to_jsonb('No - Papa Duck did not flag library markings; a small number sticker on the spine or cover is his own removable inventory label'::text));
    end if;
    if jsonb_typeof(new.flags) = 'array' then
      new.flags := coalesce((select jsonb_agg(x order by i) from jsonb_array_elements(new.flags) with ordinality f(x, i)
                             where x::text !~* 'ex-library: yes'), '[]'::jsonb);
    end if;
    if new.ident is not null and jsonb_typeof(new.ident->'condition_notes') = 'array' then
      new.ident := jsonb_set(new.ident, '{condition_notes}', coalesce((select jsonb_agg(x order by i) from jsonb_array_elements(new.ident->'condition_notes') with ordinality c(x, i)
                             where x::text !~* '(librar|call.number|institution)' or x::text ~* '(no |not a |not an |without )[a-z ]*librar'), '[]'::jsonb));
    end if;
    if position('INVENTORY LABEL:' in t) = 0 then
      new.answers := jsonb_set(new.answers, '{tell}', to_jsonb(t || E'\n- INVENTORY LABEL: a small (often pink) number sticker on the spine or cover showing the PD number is Papa Duck''s own removable inventory label. This is NOT an ex-library book - never call it a library sticker, call-number label or library processing. He always marks a library book himself.'));
    end if;
  end if;
  return new;
end $function$;
drop trigger if exists drafts_exlib_only_when_flagged on pipeline.drafts;
create trigger drafts_exlib_only_when_flagged before insert or update of answers, ident, flags on pipeline.drafts
  for each row execute function pipeline.exlib_only_when_flagged();
-- Data fix 2026-11-21: drafts 1129-1162 (Popular Science PD-0323..0332, Disney PD-6251..6274) - library wording replaced with
-- "small removable inventory label from our shop"; "📖 Volume:" line added to every description; titles PD-0325 (Vol 7), PD-6255 (Vol 3).
