-- 2026-11-10 Papa Duck: "these prices are way different then when I ran the checker" -> "yes please".
-- 1) pipeline.config min_list_drafts 9.99 -> 7.99
-- 2) pipeline.quick_price_apply(): Drafts takes the Quick check price (see function comment). Cron pd-quick-price every 5 min.
update pipeline.config set value='7.99' where key='min_list_drafts';
-- function body: see Supabase (pipeline.quick_price_apply); matches by ISBN or first 16 letters/digits of title,
-- skips not-LIST, thin data (0 sold and <=2 listed), and a lone sale more than 2x the Drafts price.
select cron.schedule('pd-quick-price', '*/5 * * * *', 'select pipeline.quick_price_apply()');
