-- 2026-11-10: eBay hid PD-3654 (407354679880) "Offering to buy or sell outside of eBay" - the description carried the maker's
-- (800) number copied off the VHS box. Fixed via copy-wording-fix {"desc"} (read back clean) + drafts/send_items b2.
-- Prevention (Rule CS validator): pipeline.no_contact(text) strips phone numbers, URLs, emails, bare .com/.net/.org names;
-- queue_ebay now wraps b1 and b2 in pipeline.no_contact(...).
create or replace function pipeline.no_contact(t text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(t,''),
    '\s*[/|,–-]?\s*(1[ .-]?)?\(?\m\d{3}\)?[ .-]\d{3}[ .-]\d{4}\M', '', 'g'),
    '\s*\(?(https?://|www\.)[^\s<)"]+\)?', '', 'gi'),
    '\s*\(?\m[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\M\)?', '', 'gi'),
    '\s*\(?\m[a-z0-9-]+\.(com|net|org|biz|info)\M(/[^\s<)"]*)?\)?', '', 'gi')
$$;
