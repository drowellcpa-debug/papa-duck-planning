-- 2026-11-22 Papa Duck: "I need the ability to grab an old Pd# and add additional quanity" ... "how do I know the condition we listed before?"
-- Launch Pad ➕ Add copies: qty_lookup (from the hourly Airtable backup - shows title, CONDITION, copies, price, cover),
-- qty_add (starts qty-set v5 with {pd, add, job}), qty_adds_recent (last 5 results). drafts-api v8 allows the three calls.
create table if not exists pipeline.qty_adds (
  id bigserial primary key, pd text not null, add_n int not null, before_qty int, condition text, title text,
  status text not null default 'sending', result jsonb, created_at timestamptz not null default now(), done_at timestamptz);
-- (function bodies: see pipeline.qty_lookup / qty_add / qty_adds_recent in the database; created 2026-11-22)
