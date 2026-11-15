-- 2026-11-14 Papa Duck: Clue game PD-0313 listed at 3 lb (buyer paid $8.10) cost $22 at 4 lb in a box - "I am losing money on this one", "change this asap".
-- Non-book items ship at item weight + 1 lb (box + padding), rounded up, on eBay (WeightMajor) and Etsy (Ground Advantage profile tier).
-- Books unchanged. blast_rows feeds every builder (eBay books, eBay Other, Etsy items) through launch_build_files.
create or replace function pipeline.ship_lb(p_ident jsonb, p_weight numeric) returns numeric language sql immutable as $$
  select case when coalesce(p_ident->>'kind','') = 'item' or lower(coalesce(p_ident->>'format','')) = 'other'
              then ceil(coalesce(p_weight, 1) + 1)
              else coalesce(p_weight, 1) end $$;
-- blast_rows(): weight_lb column and wmaj now come from pipeline.ship_lb(d.ident, d.weight_lb) (see migration items_packed_ship_weight).
-- Still open: 157 live non-book listings keep their old (too light) weights until revised - Launch Pad todo.
