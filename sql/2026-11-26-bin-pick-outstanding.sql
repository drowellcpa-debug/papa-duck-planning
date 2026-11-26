-- 2026-11-26 Papa Duck: "I noticed bin 13 is not able to be selected in the book station? also when I pick the bins in there
--   it should match the outstanding bins in the draft other than office hold and new"
-- The Book Station bin list ('all') was the last 16 bins checked out in 21 days - it left out older bins that still had books
-- waiting (4, 5, 6) and listed empty ones. Now 'all' = the bins the Drafts 🦆 Tic-Tac-Duck board shows as outstanding,
-- plus your current bin. 🏢 Office Hold (900) and 🆕 New bin are added by the page itself.
create or replace function pipeline.bin_mine(p_who text) returns jsonb
language plpgsql as $f$
declare b int; s jsonb; m jsonb; a jsonb; bb jsonb := pipeline.bin_board();
begin
  select c.bin into b from pipeline.bin_claims c where c.who = p_who order by c.bin desc limit 1;
  if b is null then s := pipeline.bin_new(p_who); else s := pipeline.bin_status(b); end if;
  select coalesce(jsonb_agg(jsonb_build_object('bin', x.bin, 'n', (pipeline.bin_status(x.bin)->>'n')::int) order by x.bin desc), '[]'::jsonb) into m
    from (select c.bin from pipeline.bin_claims c where c.who = p_who and c.at > now() - interval '21 days' order by c.bin desc limit 8) x;
  -- the outstanding bins on the Drafts board (+ the current bin), with how many books are still to photograph
  select coalesce(jsonb_agg(jsonb_build_object('bin', x.bin, 'who', x.who, 'n', (pipeline.bin_status(x.bin)->>'n')::int, 'left', x.left_n) order by x.bin), '[]'::jsonb) into a
    from (select o.bin, max(o.left_n) left_n, (select c.who from pipeline.bin_claims c where c.bin = o.bin) who
            from (select (e->>'bin')::int bin, ((e->>'total')::int - (e->>'done')::int) left_n from jsonb_array_elements(bb) e
                  union all select (s->>'bin')::int, null) o
           where o.bin is not null and o.bin < 900 group by o.bin) x;
  return s || jsonb_build_object('mine', m, 'all', a);
end $f$;
