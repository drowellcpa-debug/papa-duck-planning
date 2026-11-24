// Papa Duck - Edge Function "amazon-price" v8 (2026-11-23; v1 2026-10-26). Papa Duck: "yes give amazon its own price and change there please".
// Amazon gets its OWN price, separate from eBay / AbeBooks / Etsy:
//   competitors' lowest USED price for the same ASIN (our own offer left out) + $0.50, rounded UP to .99
//   -> never the lowest (his rule), never under the Amazon minimum (config amazon_min, default $7.99).
//   Sanity: if that would be more than 3x the eBay price, nothing changes and the row is flagged for Claude.
//   No other used seller -> keep the eBay price.
// v3 (2026-10-29, PD-3590): a RAISE is capped at +20% per run (config amazon_max_raise_pct, default 20).
// v4 (2026-10-30): once Amazon flags a book for a pricing error, pipeline.amazon_price_ceiling holds its price down.
// v6 (2026-11-14, PD-3681) RULE CU - Papa Duck: "go ahead and take it off amazon if there is ever an issue of price take it off
//   make the rule please" ... "automatically". A merchant listing Amazon switched off for a PRICING error is now TAKEN OFF
//   Amazon right away (DELETE listing; it stays on eBay / AbeBooks / Etsy at his price). No more re-pricing lower to reinstate it.
//   A 'handled' note goes on the Launch Pad and open pricing-error notes for that book are closed.
// v7 (2026-11-23, PD-3768): price_error:true now ALWAYS takes it off, even when the API still says BUYABLE. Before, a
//   pricing-error SKU the API showed as BUYABLE fell through to normal re-pricing ($25.99 -> $30.99) instead of removal.
// v8 (2026-11-23, PD-3768) - Papa Duck "Yes" to: stop Amazon raising a book more than a few dollars above its eBay price.
//   A RAISE never goes above eBay price + config amazon_max_over_ebay (default $3.00), rounded down to .99. PD-3768 was raised
//   $25.99 -> $30.99 (other seller $29.99 + 50c) and Amazon switched it off as a suspected pricing error. Prices already above
//   that line are not lowered by this rule (only raises are held).
// Only touches our MERCHANT listings. FBA is never touched (board FBA books: pipeline.fba_issue_check()).
// Results -> pipeline.amazon_prices. POST {} = do up to `max` books not priced in the last `hours` (default 40 / 6h);
// {"dry":true} = work out the prices, change nothing; {"pds":["PD-1"]} = just these (the hours filter is skipped);
// {"pds":[...],"price_error":true} = Amazon emailed a pricing error for these SKUs -> take them off.
// Auth: x-backup-secret.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOST = "https://sellingpartnerapi-na.amazon.com", MKT = "ATVPDKIKX0DER";
const r2 = (x: number) => Math.round(x * 100) / 100;
const down99 = (x: number) => Math.max(0.99, Math.floor(x + 0.01) - 0.01);   // 25.19 -> 24.99

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now(); const log: any[] = [];
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const body = await req.json().catch(() => ({}));
    const dry = !!body.dry, max = Number(body.max || 40);
    const pdFilter: string[] | null = body.pds || null;
    const hours = pdFilter ? 0 : Number(body.hours || 6);
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    const minAmz = Number(conf.amazon_min) || 7.99, over = Number(conf.amazon_over_low) || 0.5;
    const maxRaise = (Number(conf.amazon_max_raise_pct) || 20) / 100;
    const overEbay = conf.amazon_max_over_ebay != null && conf.amazon_max_over_ebay !== "" ? Number(conf.amazon_max_over_ebay) : 3;   // v8
    const A = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).amazon;
    const lr = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString() });
    const tok = (await lr.json()).access_token; if (!tok) throw new Error("Amazon login failed");
    const api = async (method: string, path: string, b?: unknown) => {
      for (let a = 0; a < 5; a++) {
        const r = await fetch(HOST + path, { method, body: b ? JSON.stringify(b) : undefined,
          headers: { "x-amz-access-token": tok, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "PapaDuckCloud/8 (Language=TypeScript)" } });
        const t = await r.text();
        if (r.status === 429 || r.status >= 500) { await sleep(2500 * (a + 1)); continue; }
        let j: any = {}; try { j = JSON.parse(t || "{}"); } catch { /* raw */ }
        return { status: r.status, j, raw: t };
      }
      return { status: 429, j: {}, raw: "busy" };
    };
    const ceil = Object.fromEntries((await sql`select pd, ceiling from pipeline.amazon_price_ceiling`).map((r: any) => [r.pd, Number(r.ceiling)]));
    const rows: any[] = await sql`
      with s as (select distinct on (i.pd) i.pd, (i.payload->>'price')::numeric ebay_price, i.payload->>'asin' asin from pipeline.send_items i
                 join pipeline.send_jobs j on j.id = i.job_id where j.channel = 'amazon' and j.test = false and i.state = 'done' order by i.pd, i.id desc)
      select s.* from s where (${pdFilter}::text[] is null or s.pd = any(${pdFilter}::text[]))
        and (${hours} = 0 or not exists (select 1 from pipeline.amazon_prices p where p.pd = s.pd and p.checked_at > now() - make_interval(hours => ${hours}) and not p.dry))
      order by s.pd limit ${max}`;
    for (const r of rows) {
      if (Date.now() - t0 > 120000) break;
      const out: any = { pd: r.pd, asin: r.asin, ebay: Number(r.ebay_price) };
      try {
        const path = `/listings/2021-08-01/items/${A.seller_id}/${encodeURIComponent(r.pd)}`;
        const g = await api("GET", path + "?" + new URLSearchParams({ marketplaceIds: MKT, includedData: "summaries,offers,fulfillmentAvailability,issues", issueLocale: "en_US" }));
        if (g.status === 404) { out.result = "not on Amazon any more (sold or removed)"; out.state = "gone"; }
        else {
          const s = g.j.summaries?.[0] || {}, st: string[] = s.status || [];
          const fc = g.j.fulfillmentAvailability?.[0]?.fulfillmentChannelCode || "DEFAULT";
          out.asin = out.asin || s.asin; out.cur = Number(g.j.offers?.[0]?.price?.amount || 0);
          const issues = (g.j.issues || []).map((i: any) => `${i.code || ""} ${(i.categories || []).join(",")} ${i.message || ""}`).join(" | ");
          // switched off for a (suspected) pricing error: Amazon's issues say so (and it is not buyable), OR the caller saw Amazon's
          // pricing-error email for this SKU (body.price_error - the hourly email watch). v7: price_error wins even if the API says BUYABLE.
          const priceOff = (!st.includes("BUYABLE") && /pric|18555|INVALID_PRICE/i.test(issues)) || !!body.price_error;
          if (fc !== "DEFAULT") { out.result = "FBA - not touched"; out.state = "skip"; }
          else if (priceOff) {
            // RULE CU (2026-11-14): any Amazon pricing error -> take it off Amazon at once (stays on the other stores).
            out.why = `Amazon switched it off for a pricing error (${(issues || "pricing-error email").slice(0, 300)})`;
            if (dry) { out.state = "dry"; out.result = "would take it off Amazon (pricing error)"; }
            else {
              const del = await api("DELETE", path + "?" + new URLSearchParams({ marketplaceIds: MKT }));
              const ok = del.j.status === "ACCEPTED";
              out.state = ok ? "removed" : "error";
              out.result = ok ? "taken off Amazon (pricing error) - stays on eBay" : "tried to take it off Amazon, refused: " + del.raw.slice(0, 160);
              if (ok) {
                const price = out.cur > 0 ? " at $" + out.cur.toFixed(2) : "";
                await sql`select pipeline.alert_add('Amazon', ${r.pd + ": taken off Amazon (pricing error)"}, ${"Amazon switched it off for a suspected pricing error" + price + ". Taken off Amazon automatically - it stays on eBay and your other stores. Nothing to do."}, ${r.pd}, null, 'handled', ${"amzpriceoff:" + r.pd})`.catch(() => null);
                await sql`update pipeline.alerts set done_at = now() where pd = ${r.pd} and done_at is null and kind <> 'handled' and title ilike '%pricing error%'`.catch(() => null);
              } else {
                await sql`select pipeline.alert_add('Amazon', ${r.pd + ": Amazon pricing error - could not take it off"}, ${"Amazon switched it off for a pricing error and Claude could not remove it: " + del.raw.slice(0, 160) + ". Remove it in Seller Central."}, ${r.pd}, null, 'urgent', ${"amzpriceofffail:" + r.pd + ":" + new Date().toISOString().slice(0, 10)})`.catch(() => null);
              }
            }
          }
          else if (!st.includes("BUYABLE")) { out.result = "not buyable (" + (st.join(",") || "processing") + ") - not touched"; out.state = "skip"; }
          else {
            await sleep(2100);   // getItemOffers: 0.5 requests / second
            const o = await api("GET", `/products/pricing/v0/items/${encodeURIComponent(out.asin)}/offers?MarketplaceId=${MKT}&ItemCondition=Used`);
            const offers: any[] = o.j.payload?.Offers || [];
            const others = offers.filter((x) => x.SellerId !== A.seller_id).map((x) => Number(x.ListingPrice?.Amount || 0) + Number(x.Shipping?.Amount || 0)).filter((x) => x > 0);
            out.low = others.length ? Math.min(...others) : null; out.sellers = others.length;
            let want: number;
            if (out.low == null) { want = Math.max(minAmz, out.ebay); out.why = "no other used seller - eBay price kept (never under the Amazon minimum)"; }
            else {
              want = Math.max(minAmz, Math.ceil(out.low + over) - 0.01);
              out.why = `lowest other used $${out.low.toFixed(2)} + $${over.toFixed(2)} -> $${want.toFixed(2)}`;
              if (want > out.ebay * 3) { out.state = "flag"; out.result = `would be $${want.toFixed(2)}, over 3x the eBay price - not changed, Claude to look`; }
            }
            if (out.cur > 0 && want > out.cur * (1 + maxRaise)) {
              const cap = Math.max(minAmz, down99(out.cur * (1 + maxRaise)));
              if (cap > out.cur) { out.why += ` · raise capped at +${Math.round(maxRaise * 100)}% this run -> $${cap.toFixed(2)} (keeps climbing next run)`; want = cap; }
            }
            // v8: a raise never goes more than $overEbay above the eBay price (prices already above that line are left alone, not lowered)
            if (out.ebay > 0 && want > out.cur) {
              const lineE = Math.max(minAmz, down99(out.ebay + overEbay));
              if (want > lineE) {
                const held = Math.max(out.cur, lineE);
                out.why += ` · held at $${held.toFixed(2)} (never raised more than $${overEbay.toFixed(2)} over the eBay price $${out.ebay.toFixed(2)})`;
                want = held; if (out.state === "flag") out.state = undefined;
              }
            }
            if (ceil[r.pd] != null && want > ceil[r.pd]) {
              out.why += ` · held at $${ceil[r.pd].toFixed(2)} (Amazon flagged this book for a pricing error before - never raised above that)`;
              want = Math.max(minAmz, ceil[r.pd]); if (out.state === "flag") out.state = undefined;
            }
            want = r2(want); out.new = want;
            if (!out.state) {
              if (Math.abs(want - out.cur) < 0.005) { out.state = "same"; out.result = "already right"; }
              else if (dry) { out.state = "dry"; out.result = `would change $${out.cur.toFixed(2)} -> $${want.toFixed(2)}`; }
              else {
                const p = await api("PATCH", path + "?" + new URLSearchParams({ marketplaceIds: MKT, issueLocale: "en_US" }), { productType: s.productType || "ABIS_BOOK",
                  patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: [{ audience: "ALL", currency: "USD", marketplace_id: MKT, our_price: [{ schedule: [{ value_with_tax: want }] }] }] }] });
                if (p.j.status === "ACCEPTED") { out.state = "changed"; out.result = `$${out.cur.toFixed(2)} -> $${want.toFixed(2)}`; }
                else { out.state = "error"; out.result = "Amazon refused: " + p.raw.slice(0, 200); }
              }
            }
          }
        }
      } catch (e) { out.state = "error"; out.result = String((e as Error).message).slice(0, 200); }
      log.push(out);
      await sql`insert into pipeline.amazon_prices (pd, asin, ebay_price, old_price, low_other, new_price, state, note, dry)
        values (${r.pd}, ${out.asin || null}, ${out.ebay}, ${out.cur || null}, ${out.low ?? null}, ${out.new ?? null}, ${out.state}, ${(out.why ? out.why + " · " : "") + (out.result || "")}, ${dry})`;
    }
    return json({ ok: true, dry, done: log.length, left: rows.length - log.length, secs: Math.round((Date.now() - t0) / 1000), log });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 400), log }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
