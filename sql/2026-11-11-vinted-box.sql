-- 2026-11-11 Papa Duck: personal Vinted sorting box + lots with V-numbers (painter's tape labels).
alter table pipeline.cleanup_piles add column if not exists photo_url text, add column if not exists vinted_lot bigint;
create sequence if not exists pipeline.vinted_lot_seq;
create table if not exists pipeline.vinted_lots (id bigint primary key default nextval('pipeline.vinted_lot_seq'),
  vnum text generated always as ('V-' || lpad(id::text, 4, '0')) stored, items bigint[] not null default '{}', photos text[] not null default '{}',
  title text, description text, category text, condition text, package text, price numeric, status text not null default 'draft',
  created_at timestamptz default now(), listed_at timestamptz, sold_at timestamptz);
-- functions (see Supabase): pipeline.vinted_box(), pipeline.vinted_lot_make(bigint[]), pipeline.vinted_lot_save(bigint, jsonb)
-- station-api v7d stores the Quick check photo on 🛍️ Vinted box (storage p/vinted/<pile id>.jpg -> cleanup_piles.photo_url).
