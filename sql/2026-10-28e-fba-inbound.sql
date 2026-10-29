-- 2026-10-28 FBA Stage 2 by API (edge fba-inbound v2 + helpers). First box sent this way:
-- Box #1: inbound plan wfbac70dbd-a32b-4554-8814-3a761aa359fb, shipment FBA19VM9X6VK (sh5cdf5502-...), Stockton CA (SCK?), UPS SPD 1Z23A6V80305898956,
-- 25 books 37 lb 24x18x18, placement $10.86 + UPS $14.74 = $25.60. PD-3108 refused (old 10/17 test listing "must be removed") - kept out.
-- Order: POST items/prepDetails (NONE/ITEM_NO_PREP) -> POST inboundPlans (prepOwner SELLER, labelOwner SELLER) -> packingOptions generate/list/confirm
--  -> packingInformation (BOX_CONTENT_PROVIDED) -> placementOptions generate/list -> transportationOptions generate per placement (readyToShipWindow)
--  -> list (paginate, keep AMAZON_PARTNERED_CARRIER) -> HIS OK -> confirm placement -> confirm transportation -> GET shipment (confirmation id) -> v0 labels PackageLabel_Thermal.
create or replace function pipeline.fba_inbound_call(p jsonb) returns jsonb language plpgsql security definer set search_path to 'pipeline','pg_catalog','extensions' as $$
declare r text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '150');
  select content into r from extensions.http(('POST', 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/fba-inbound',
    array[extensions.http_header('x-backup-secret', (select value from backup.config where key='cron_secret'))],
    'application/json', p::text)::extensions.http_request);
  return r::jsonb;
end $$;
-- pipeline.fba_inbound_spd(plan, placement): pages transportationOptions, returns only AMAZON_PARTNERED_CARRIER quotes.
