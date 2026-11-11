-- 2026-11-10 Papa Duck: "too many needless questions", "I sell only one at a time unless I say set", "if it sees the insert assumed intact
-- I will tell you differently", "If I say case is broken, it should not ask me again", "no scratches not tested".
-- BEFORE trigger on pipeline.drafts: unanswered questions get his standing answers (he changes any of them in Drafts).
create or replace function pipeline.drafts_auto_answer() returns trigger language plpgsql as $$
declare i int; q jsonb; qt text; opt text; a jsonb := coalesce(new.answers, '{}'::jsonb); said text;
  pick text;
begin
  if new.questions is null or jsonb_typeof(new.questions) <> 'array' then return new; end if;
  said := lower(coalesce(a->>'tell','') || ' ' || coalesce((select string_agg(value, ' ') from jsonb_each_text(a) where key ~ '^\d+$'), ''));
  for i in 0 .. jsonb_array_length(new.questions) - 1 loop
    q := new.questions -> i; qt := coalesce(q->>'q',''); opt := null; pick := null;
    continue when coalesce(a ->> i::text, '') <> '';
    if qt ~* '^how is this sold' then pick := 'one at a time';
    elsif qt ~* '(case|hinge|housing|cartridge|tray)' and qt ~* '(crack|broke|damage)'
          and said ~ '(case|hinge|tray)[^.]*(broke|crack)|(broke|crack)[^.]*(case|hinge|tray)' and said !~ 'no crack' then
      select o into opt from jsonb_array_elements_text(q->'options') o where o ~* '(broke|crack|damage)' and o !~* '^no' order by (o ~* 'broke') desc limit 1;
    elsif qt ~* '(insert|tray card|booklet|liner notes|slipcase|slip case|cardboard box|boxes|album art|artwork|sleeve)' and qt !~* '(crack|scratch|play|test|cartridge|housing)' then
      pick := '^(complete|yes|present|both present|all|tight|clean|intact|good)';
    elsif qt ~* '(played|rewound|tested|test |play back|plays|playback|skip)' and qt !~* 'scratch' then
      pick := '(not tested|haven.t (checked|tested)|no player|^unknown|condition unknown|not sure)';
    elsif qt ~* '(scratch|scuff)' then
      pick := '^(no scratches|no deep|all .* no deep|both discs look perfect|looks? perfect|no visible)';
    elsif qt ~* '(mold|musty|odor|smell|smoke)' then pick := '^no (odor|smell)';
    elsif qt ~* '(writing|stickers|labels|marked)' then pick := '^none';
    elsif qt ~* '(box|corner|edge)' and qt ~* '(crease|tear|crush|wear)' then pick := '^no ';
    elsif qt ~* '^anything the photos can.t show' then pick := '^none$';
    end if;
    if pick is not null then
      select o into opt from jsonb_array_elements_text(q->'options') o where o ~* pick limit 1;
    end if;
    if opt is not null then a := a || jsonb_build_object(i::text, opt); end if;
  end loop;
  new.answers := a;
  return new;
end $$;
drop trigger if exists drafts_auto_answer on pipeline.drafts;
create trigger drafts_auto_answer before insert or update of questions on pipeline.drafts for each row execute function pipeline.drafts_auto_answer();
