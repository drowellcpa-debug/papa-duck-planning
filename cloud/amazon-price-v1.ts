// Papa Duck - Edge Function "amazon-price" v1 (2026-10-26). Papa Duck: "yes give amazon its own price and change there please".
// Amazon gets its OWN price, separate from eBay / AbeBooks / Etsy:
//   competitors' lowest USED price for the same ASIN (our own offer left out) + $0.50, rounded UP to .99
//   -> never the lowest (his rule), never under the Amazon minimum (config amazon_min, default $7.99).
//   Sanity: if that would be more than 3x the eBay price, nothing changes and the row is flagged for Claude.
//   No other used seller -> keep the eBay price.
// Only touches our MERCHANT listings that are live (Listings API GET: BUYABLE). FBA is never touched.
// Results -> pipeline.amazon_prices. POST {} = do up to `max` books not priced in the last `hours` (default 40 / 6h);
// {"dry":true} = work out the prices, change nothing; {"pds":["PD-1"]} = just these. Auth: x-backup-secret.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOST = "https://sellingpartnerapi-na.amazon.com", MKT = "ATVPDKIKX0DER";
const r2 = (x: number) => Math.round(x * 100) / 100;

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now(); const log: any[] = [];
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const body = await req.json().catch(() => ({}));
    const dry = !!body.dry, max = Number(body.max || 40), hours = Number(body.hours || 6);
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    const minAmz = Number(conf.amazon_min) || 7.99, over = Number(conf.amazon_over_low) || 0.5;
    const A = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).amazon;
    const lr = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString() });
    const tok = (await lr.json()).access_token; if (!tok) throw new Error("Amazon login failed");
    const api = async (method: string, path: string, b?: unknown) => {
      for (let a = 0; a < 5; a++) {
        const r = await fetch(HOST + path, { method, body: b ? JSON.stringify(b) : undefined,
          headers: { "x-amz-access-token": tok, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "PapaDuckCloud/4 (Language=TypeScript)" } });
        const t = await r.text();
        if (r.status === 429 || r.status >= 500) { await sleep(2500 * (a + 1)); continue; }
        let j: any = {}; try { j = JSON.parse(t || "{}"); } catch { /* raw */ }
        return { status: r.status, j, raw: t };
      }
      return { status: 429, j: {}, raw: "busy" };
    };
    // every merchant Amazon listing we sent (newest send per PD), with its ASIN and eBay price
    const pdFilter: string[] | null = body.pds || null;
    const rows: any[] = await sql`
      with s as (select distinct on (i.pd) i.pd, (i.payload->>'price')::numeric ebay_price, i.payload->>'asin' asin from pipeline.send_items i
                 join pipeline.send_jobs j on j.id = i.job_id where j.channel = 'amazon' and j.test = false and i.state = 'done' order by i.pd, i.id desc)
      select s.* from s where (${pdFilter}::text[] is null or s.pd = any(${pdFilter}::text[]))
        and not exists (select 1 from pipeline.amazon_prices p where p.pd = s.pd and p.checked_at > now() - make_interval(hours => ${hours}) and not p.dry)
      order by s.pd limit ${max}`;
    for (const r of rows) {
      if (Date.now() - t0 > 120000) break;
      const out: any = { pd: r.pd, asin: r.asin, ebay: Number(r.ebay_price) };
      try {
        const path = `/listings/2021-08-01/items/${A.seller_id}/${encodeURIComponent(r.pd)}`;
        const g = await api("GET", path + "?" + new URLSearchParams({ marketplaceIds: MKT, includedData: "summaries,offers,fulfillmentAvailability" }));
        if (g.status === 404) { out.result = "not on Amazon any more (sold or removed)"; out.state = "gone"; }
        else {
          const s = g.j.summaries?.[0] || {}, st: string[] = s.status || [];
          const fc = g.j.fulfillmentAvailability?.[0]?.fulfillmentChannelCode || "DEFAULT";
          out.asin = out.asin || s.asin; out.cur = Number(g.j.offers?.[0]?.price?.amount || 0);
          if (fc !== "DEFAULT") { out.result = "FBA - not touched"; out.state = "skip"; }
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
