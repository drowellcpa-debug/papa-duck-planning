-- 2026-11-10: eBay Other step failed on PD-3646 Pimsleur (category 29792 Audiobooks): "The provided condition id is invalid for the selected
-- primary category id" - Audiobooks take BOOK condition IDs, not Used 3000. launch_build_files Step 1b now maps:
--   'cid', case when pricing->'item'->>'category_id' in ('29792') then (case ident->>'grade' when 'Brand New' then 1000 when 'Like New' then 2750
--          when 'Very Good' then 4000 when 'Acceptable' then 6000 else 5000 end) else coalesce((pricing->'item'->>'cond_id')::int, 3000) end
-- Job 109 PD-3646 payload cid set to 6000 and re-sent: LIVE eBay 407354675004.

-- Same night: every CD (176984), VHS (309) and 8-track (618) was refused with Used 3000 too. eBay media categories take the graded
-- used conditions (2750 Like New / 4000 Very Good / 5000 Good / 6000 Acceptable). The mapping now covers
-- 29792, 176984, 176985, 176983, 176986, 309, 617, 618, 11232, or any item whose type reads as CD/cassette/vinyl/record/VHS/DVD/8-track/audio.
-- Job 109 fixed and re-sent: CLOSED - 10 sent.
