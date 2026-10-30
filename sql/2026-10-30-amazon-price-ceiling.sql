-- 2026-10-30 amazon-price v4: once Amazon flags a book for a pricing error, the reinstated price is a ceiling.
create table if not exists pipeline.amazon_price_ceiling (pd text primary key, ceiling numeric not null, reason text, set_at timestamptz default now());
insert into pipeline.amazon_price_ceiling (pd, ceiling, reason) values ('PD-3590', 24.99, 'Amazon 18555 pricing error twice (30.99, 28.99)')
  on conflict (pd) do update set ceiling = excluded.ceiling, reason = excluded.reason, set_at = now();
