-- 2026-11-17 Papa Duck: Duck Hunter (Chrome extension on Vinted, like BookMine Hunter). "yes build it".
-- Its own schema so it can never touch the blast off / Drafts / Book Station. Read-only except hunter.checks (a log).

create schema if not exists hunter;

create table if not exists hunter.checks (
  id bigserial primary key,
  at timestamptz not null default now(),
  url text, isbn text, title text, cost numeric, verdict text, best_store text, best_profit numeric, result jsonb
);

-- his own history for this book: every Inventory row with the same ISBN (digits only) or ASIN, and what sold
create or replace function hunter.history(p_isbn text, p_asin text) returns jsonb language sql stable as $$
  with inv as (
    select a.fields f from backup.airtable_records a
    where a.table_id = 'tblKxgB4q7v9SPqze'
      and ((length(regexp_replace(coalesce(p_isbn,''), '[^0-9Xx]', '', 'g')) >= 10
            and upper(regexp_replace(coalesce(a.fields->>'ISBN',''), '[^0-9Xx]', '', 'g')) = upper(regexp_replace(p_isbn, '[^0-9Xx]', '', 'g')))
        or (coalesce(p_asin,'') <> '' and a.fields->>'Amazon ASIN' = p_asin))
  ), pds as (select distinct f->>'Tracking Number' pd from inv where f->>'Tracking Number' like 'PD-%'),
  sold as (
    select s.fields f from backup.airtable_records s join pds on pds.pd = s.fields->>'Tracking Number'
    where s.table_id = 'tblm6DXvqF1jY3w9o'
  )
  select jsonb_build_object(
    'sold', coalesce((select jsonb_agg(jsonb_build_object('pd', f->>'Tracking Number', 'ch', f->>'Channel', 'price', (f->>'Sold Price')::numeric, 'date', f->>'Sold Date') order by f->>'Sold Date' desc) from sold), '[]'::jsonb),
    'on_hand', coalesce((select jsonb_agg(jsonb_build_object('pd', f->>'Tracking Number', 'status', f->>'Status', 'price', (f->>'Listed Price')::numeric))
                         from inv where f->>'Status' not in ('Sold','Donated','Unlisted') and coalesce((f->>'Quantity')::numeric, 1) > 0), '[]'::jsonb))
$$;
insert into pipeline.config (key, value) values ('hunter_min_profit', '20') on conflict (key) do update set value = excluded.value;  -- 2026-11-17 "only want profit greater than $20"
update pipeline.config set value = '15' where key = 'hunter_min_profit';  -- 2026-11-17 11:01 "lets drop it to 15"
