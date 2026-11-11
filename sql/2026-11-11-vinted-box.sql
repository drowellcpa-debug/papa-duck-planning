-- 2026-11-11 Papa Duck: personal Vinted sorting box + lots with V-numbers (painter's tape labels).
alter table pipeline.cleanup_piles add column if not exists photo_url text, add column if not exists vinted_lot bigint;
create sequence if not exists pipeline.vinted_lot_seq;
create table if not exists pipeline.vinted_lots (id bigint primary key default nextval('pipeline.vinted_lot_seq'),
  vnum text generated always as ('V-' || lpad(id::text, 4, '0')) stored, items bigint[] not null default '{}', photos text[] not null default '{}',
  title text, description text, category text, condition text, package text, price numeric, status text not null default 'draft',
  created_at timestamptz default now(), listed_at timestamptz, sold_at timestamptz);
-- functions (see Supabase): pipeline.vinted_box(), pipeline.vinted_lot_make(bigint[]), pipeline.vinted_lot_save(bigint, jsonb)
-- station-api v7d stores the Quick check photo on 🛍️ Vinted box (storage p/vinted/<pile id>.jpg -> cleanup_piles.photo_url).

-- Same day ("If I mark it Vinted it needs to be able to move the folders to another area so I can drag ... all the pictures"):
-- cleanup_piles.photos text[] + draft_id. ui_save action 'vinted' (status dont_list, channel 'vinted'); trigger drafts_to_vinted puts the
-- draft in the Vinted box with ALL its photos (reopen takes it out). quick_price_apply: a Station draft whose Quick check went to the
-- Vinted box moves there automatically. vinted_box returns photos; vinted_lot_make uses every photo of every item. Drafts: 🛍️ Vinted box button.
