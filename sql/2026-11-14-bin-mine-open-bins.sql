-- 2026-11-14 Papa Duck: "I will have multiple bins open, I need the ability to pick from open or create a new" (garage sorting bin + office bin).
-- bin_mine also returns 'mine' = this person's open bins (claimed in the last 21 days, newest first, up to 8) with book counts.
-- Sorting page: tapping the bin bar opens a picker (your open bins + Start a new bin). Book Station: bin dropdown, remembered per device.
-- New bin no longer passes "from" (bin_new would hand back the newer open bin instead of a new number).
create or replace function pipeline.bin_mine(p_who text) returns jsonb language plpgsql as $function$
declare b int; s jsonb; m jsonb;
begin
  select c.bin into b from pipeline.bin_claims c where c.who = p_who order by c.bin desc limit 1;
  if b is null then s := pipeline.bin_new(p_who); else s := pipeline.bin_status(b); end if;
  select coalesce(jsonb_agg(jsonb_build_object('bin', x.bin, 'n', (pipeline.bin_status(x.bin)->>'n')::int) order by x.bin desc), '[]'::jsonb) into m
    from (select c.bin from pipeline.bin_claims c where c.who = p_who and c.at > now() - interval '21 days' order by c.bin desc limit 8) x;
  return s || jsonb_build_object('mine', m);
end $function$;
