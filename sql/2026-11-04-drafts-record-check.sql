-- 2026-11-04 Papa Duck "Fixing for sure" (after PD-5041 vinyl went out Very Good with water/mold + no inner sleeve).
-- Trigger pipeline.drafts_record_check (BEFORE INSERT OR UPDATE on pipeline.drafts): vinyl record drafts (ident.kind='item')
-- get 3 in-hand questions; grade capped at Acceptable until answered; answers cap it (mold/heavy water or scratches/warp -> Acceptable,
-- light stain or no inner sleeve -> Good, light marks -> Very Good). Uncapped grade kept in ident.grade_before_cap.
-- Tested 2026-11-04 (rolled back): NEW:Acceptable  NOSLEEVE:Good  CLEAN:Very Good  MOLD:Acceptable  his pick Good:Good.
-- Full function body below (same as Supabase migration "drafts_record_check").

create or replace function pipeline.drafts_record_check() returns trigger language plpgsql
set search_path to 'pipeline', 'pg_catalog' as $$
declare
  qs jsonb; txt text; w text; s text; v text; base text; g text; gi int; cap int := 5;
  grades text[] := array['Acceptable','Good','Very Good','Like New','New'];
  q1 text := 'Records: any water stains or mold on the jacket, inside or out? (Smell it - musty?)';
  q2 text := 'Records: is the inner sleeve there?';
  q3 text := 'Records: with the vinyl OUT of the jacket - any scratches or warp?';
begin
  if new.built_at is not null or coalesce(new.ident->>'kind','') <> 'item' then return new; end if;
  txt := concat_ws(' ', new.ident->>'format', new.ident->>'title', new.ident#>>'{item,type}', new.answers->>'tell');
  if txt !~* '(\mvinyl\M|\mLPs?\M|record album|phonograph record|33 ?1/3|\m45 ?rpm|\m78 ?rpm)' then return new; end if;
  qs := coalesce(new.questions, '[]'::jsonb);
  if not exists (select 1 from jsonb_array_elements(qs) q where q->>'q' = q2) then
    qs := qs || jsonb_build_array(
      jsonb_build_object('q', q1, 'options', jsonb_build_array('None - clean and dry', 'Light water stain or foxing', 'Heavy water damage or mold')),
      jsonb_build_object('q', q2, 'options', jsonb_build_array('Yes, inner sleeve present', 'No inner sleeve')),
      jsonb_build_object('q', q3, 'options', jsonb_build_array('Clean and flat', 'Light marks only', 'Scratches or warp')));
    new.questions := qs;
    new.flags := coalesce(new.flags, '[]'::jsonb) || to_jsonb('💿 RECORD: answer the 3 record questions (water/mold, inner sleeve, vinyl out of the jacket) - the grade stays capped at Acceptable until you do.'::text);
  end if;
  select coalesce(new.answers->>((o - 1)::text), '') into w from jsonb_array_elements(qs) with ordinality e(q, o) where q->>'q' = q1 limit 1;
  select coalesce(new.answers->>((o - 1)::text), '') into s from jsonb_array_elements(qs) with ordinality e(q, o) where q->>'q' = q2 limit 1;
  select coalesce(new.answers->>((o - 1)::text), '') into v from jsonb_array_elements(qs) with ordinality e(q, o) where q->>'q' = q3 limit 1;
  if coalesce(w,'') = '' or coalesce(s,'') = '' or coalesce(v,'') = '' then cap := 1; end if;
  if w ~* '(heavy|mold)' then cap := least(cap, 1); elsif w ~* 'light' then cap := least(cap, 2); end if;
  if s ~* '^no' then cap := least(cap, 2); end if;
  if v ~* '(scratch|warp)' then cap := least(cap, 1); elsif v ~* 'light' then cap := least(cap, 3); end if;
  base := case when new.ident ? 'grade_before_cap' and new.ident->>'grade' = new.ident->>'grade_capped_to'
               then new.ident->>'grade_before_cap' else coalesce(new.ident->>'grade', 'Good') end;
  gi := array_position(grades, base);
  if gi is null then return new; end if;
  g := grades[least(gi, cap)];
  if g is distinct from new.ident->>'grade' or new.ident ? 'grade_before_cap' then
    new.ident := new.ident || jsonb_build_object('grade', g, 'grade_before_cap', base, 'grade_capped_to', g);
  end if;
  return new;
end $$;
create trigger drafts_record_check before insert or update on pipeline.drafts for each row execute function pipeline.drafts_record_check();
