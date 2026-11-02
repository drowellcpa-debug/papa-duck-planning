-- Papa Duck 2026-11-02: "I need the ability to indicate not to ship that once cancelled" (PD-0249 order 18-15361-98954).
alter table pipeline.ship_marks add column if not exists kind text not null default 'shipped';
create or replace function pipeline.mark_cancelled(p_key text) returns jsonb language sql security definer set search_path to 'pipeline','pg_catalog' as $$
  insert into pipeline.ship_marks (key, kind) values (p_key, 'cancelled') on conflict (key) do update set kind = 'cancelled';
  select pipeline.to_ship(); $$;

-- v2: a cancelled multi-quantity sale puts the piece back (qty-set v4 add:1); one-of-a-kind -> alert to relist.
-- (full function: see migration mark_cancelled_restock in Supabase)
