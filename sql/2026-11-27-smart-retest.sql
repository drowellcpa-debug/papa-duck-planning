-- 2026-11-27 morning: scout v32 -> v34 re-tests on the same 30 books (pipeline.smart_compare: new2_* = v32, old2_* = old way run again,
-- new3_* = v34). Result: the old way disagreed with itself on 2 calls / 4 prices; v34 gave 0 calls and 0 prices outside what the
-- old way itself gave (only difference: Best Loved Books found a price where the old way found none - same Goodwill call).
-- -> pipeline.config scout_smart = 'on' (Papa Duck 11/26 21:46: "Auto turn on change you don't need my ok").
-- Functions used: pipeline.smart_compare_round2 / smart_compare_old_again / smart_compare_round3 (applied as migrations).
update pipeline.config set value = 'on' where key = 'scout_smart';
