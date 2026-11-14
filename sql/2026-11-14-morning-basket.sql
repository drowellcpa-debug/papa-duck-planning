-- 2026-11-14 Papa Duck: "Would you recommend setting up morning basket lots" ... "Yes can you set this up"
-- station-api v7s: the family check also names a Morning Basket theme; a GOODWILL book with a theme -> pile 'BASKET'.
-- Sorting page + Book Station show 🧺 MORNING BASKET (theme in big letters) and a manual "Morning Basket instead" button.
alter table pipeline.cleanup_piles add column if not exists basket_theme text;
-- Launch Pad todo 86: lot maker (group the BASKET pile by theme into 5-8 book lot listings).
