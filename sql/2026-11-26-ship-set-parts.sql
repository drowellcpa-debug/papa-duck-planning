-- 2026-11-26 Papa Duck: "can you show those pd# as a 'set' when I look in the app tonight and pick the books" (PD-0055 sold = PD-2315 + PD-2316).
-- pipeline.set_parts: a SET listing's own PD -> the stickered books to pull. Seeded from the Airtable SET records (titles carry "[PD-x + PD-y]").
-- to_ship() now returns 'set_parts' so the Launch Pad 📬 To ship row says "📚 SET - pull PD-2315 + PD-2316".
create table if not exists pipeline.set_parts (pd text primary key, parts text[] not null, note text, created_at timestamptz not null default now());
insert into pipeline.set_parts(pd, parts, note) values
 ('PD-0048', array['PD-2326','PD-2327'], 'Apologia General Science text + Solutions & Tests'),
 ('PD-0049', array['PD-2329','PD-2328','PD-2305'], 'Apologia Physical Science text + Solutions & Tests + Notebook'),
 ('PD-0050', array['PD-2322','PD-2323'], 'Mystery of History I + II'),
 ('PD-0051', array['PD-2302','PD-2300'], 'WriteShop I & II TM + WriteShop II workbook'),
 ('PD-0052', array['PD-2296','PD-2297','PD-2298'], 'Trail Guide Paths of Exploration 4-6 TGs'),
 ('PD-0053', array['PD-2320','PD-2321'], 'A Beka Art A + Art C'),
 ('PD-0054', array['PD-2318','PD-2319'], 'TOPS Analysis 10 + Cohesion/Adhesion 13'),
 ('PD-0055', array['PD-2315','PD-2316'], 'Founding Fathers (Malam) + The Renaissance (Quigley, ex-library)'),
 ('PD-0056', array['PD-2683','PD-2684'], 'Newsweek The Forties + Personalities!'),
 ('PD-0057', array['PD-2685','PD-2686'], '9/11 TIME + US News Sept 24 2001'),
 ('PD-2106', array['PD-2106','PD-2105'], 'Discovering Geometry student + Teacher''s Guide')
on conflict (pd) do update set parts = excluded.parts, note = excluded.note;
