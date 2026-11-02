// Papa Duck - Edge Function "qty-set" v4 (2026-11-02; v3 adds price, v4 adds restock). v1 (2026-10-31). Papa Duck: "on pd 0164 i forgot to indicate 5 of them".
// Changes how many copies a LIVE item has, everywhere at once: eBay (ReviseInventoryStatus), Etsy (listing inventory),
// Airtable Quantity, and the draft's station qty. POST {"pd":"PD-0164","qty":5}. Auth: x-backup-secret = backup.config cron_secret.
// v3: {"pd","price":22.99} (qty optional) also sets the PRICE everywhere: eBay StartPrice + Best Offer (auto 80%, min 65%), Etsy offering price,
//   Airtable List/Auto/Min, the draft pricing. Papa Duck 2026-11-02: "ok change prices please" (PD-0249/0236/0248 priced off sets, not single pieces).
// v4: {"pd","add":1} = put pieces BACK (a cancelled sale): reads what eBay (else Etsy) shows available now and adds to it.
//   Called by pipeline.mark_cancelled (Papa Duck 2026-11-02: "It did not change back quantity").
// Uses the same store lock as sales-cloud (7342001) so it never collides with the Etsy token rotation.
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "appdMXzb9U4sdXpAr", T_INV = "tblKxgB4q7v9SPqze", ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu";
const F_TRACK = "fldxiwKYi6z1t0iDx", F_QTY = "fld7MrQXX1D8iD0ap", F_LIST = "fldqfykAq3wumx32C", F_AUTO = "fldSpnDZLINeJyA0c", F_MIN = "fldvRL78ZiKrr3Vrh";
const r50 = (x: number) => Math.round(x * 2) / 2;
const arr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();
const J = (b: string) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
async function call(url: string, init: any = {}, tries = 3): Promise<{ status: number; body: string }> {
  for (let a = 0; ; a++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) });
    const body = await r.text();
    if ((r.status === 429 || r.status >= 500) && a < tries - 1) { await sleep(2000 * (a + 1)); continue; }
    return { status: r.status, body };
  }
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  let locked = false;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const pd = String(b.pd || "").toUpperCase(), add = Math.floor(Number(b.add || 0));
    let qty = b.qty == null ? 0 : Math.floor(Number(b.qty));
    const price = b.price == null ? 0 : Math.round(Number(b.price) * 100) / 100;
    const auto = price ? Math.min(r50(price * 0.8), price - 0.5) : 0, mn = price ? Math.min(r50(price * 0.65), auto) : 0;
    if (!/^PD-\d{4}[A-Z]?$/.test(pd) || (!qty && !price && !(add > 0 && add <= 20)) || (qty && !(qty >= 1 && qty <= 999)) || (price && !(price >= 6.99 && price <= 5000)))
      return json({ error: "need pd like PD-0164 and qty 1-999 and/or price 6.99-5000" }, 400);
    for (let a = 0; a < 20 && !locked; a++) { locked = (await sql`select pg_try_advisory_lock(7342001) as ok`)[0].ok; if (!locked) await sleep(3000); }
    if (!locked) return json({ ok: false, error: "the store worker is busy - try again in a minute" }, 409);
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const K = JSON.parse(vr[0].decrypted_secret);
    const saveEtsy = async () => { const cur = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
      cur.etsy = K.etsy; await sql`select vault.update_secret(${vr[0].id}::uuid, ${JSON.stringify(cur)})`; };
    const ids = await sql`select distinct on (j.channel) j.channel, i.listing_id from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id
      where i.pd = ${pd} and i.state = 'done' and i.listing_id is not null and j.test = false order by j.channel, i.id desc`;
    const id = (ch: string) => (ids.find((r: any) => r.channel === ch) || {}).listing_id;
    const out: any = { pd, qty: qty || null, price: price || null };
    if (add > 0 && !qty) {
      // how many are available right now, eBay first, then Etsy, then the draft
      let now = -1;
      const eid = id("ebay");
      if (eid) {
        const e = K.ebay, x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const r = await call("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": "GetItem", "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
          "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
          body: `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${x(e.auth_token)}</eBayAuthToken></RequesterCredentials><ItemID>${eid}</ItemID></GetItemRequest>` });
        const it = (parser.parse(r.body).GetItemResponse || {}).Item || {};
        if (txt(it.Quantity)) now = Math.max(0, Number(txt(it.Quantity)) - Number(txt(it.SellingStatus?.QuantitySold) || 0));
      }
      if (now < 0) { const [dr] = await sql`select (answers->'station'->>'qty')::int q from pipeline.drafts where pd = ${pd} order by id desc limit 1`; now = Math.max(0, Number(dr?.q || 0) - add); }
      qty = now + add; out.restock = `was ${now} available, +${add} = ${qty}`; out.qty = qty;
    }

    // eBay
    const ebayId = id("ebay");
    if (ebayId) {
      try {
        const e = K.ebay, esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const trade = async (name: string, inner: string) => {
          const r = await call("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
            "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
            body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${esc(e.auth_token)}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` });
          const x = parser.parse(r.body)[name + "Response"] || {}, ack = txt(x.Ack);
          return ack === "Success" || ack === "Warning" ? "" : "error: " + arr(x.Errors).map((z: any) => `${txt(z.ErrorCode)} ${txt(z.LongMessage)}`).join("; ").slice(0, 200);
        };
        const parts: string[] = [];
        if (qty) { const er = await trade("ReviseInventoryStatus", `<InventoryStatus><ItemID>${ebayId}</ItemID><Quantity>${qty}</Quantity></InventoryStatus>`); parts.push(er || `qty ${qty}`); }
        if (price) {
          const er = await trade("ReviseFixedPriceItem", `<Item><ItemID>${ebayId}</ItemID><StartPrice currencyID="USD">${price.toFixed(2)}</StartPrice><BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails><ListingDetails><BestOfferAutoAcceptPrice currencyID="USD">${auto.toFixed(2)}</BestOfferAutoAcceptPrice><MinimumBestOfferPrice currencyID="USD">${mn.toFixed(2)}</MinimumBestOfferPrice></ListingDetails></Item>`);
          parts.push(er || `price $${price.toFixed(2)} (offers: auto $${auto.toFixed(2)}, min $${mn.toFixed(2)})`);
        }
        out.ebay = parts.join("; ") + ` (item ${ebayId})`;
      } catch (e) { out.ebay = "error: " + String((e as Error).message).slice(0, 200); }
    } else out.ebay = "not listed";

    // Etsy
    const etsyId = id("etsy");
    if (etsyId) {
      try {
        const e = K.etsy;
        if (!(e.access_token && (e.expires_at || 0) > Date.now() + 5 * 60e3)) {
          const r = await call("https://api.etsy.com/v3/public/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grant_type: "refresh_token", client_id: ETSY_CLIENT, refresh_token: e.refresh_token }) });
          const j = J(r.body);
          if (!j.access_token || !j.refresh_token) throw new Error(`Etsy token refresh failed (${r.status})`);
          e.access_token = j.access_token; e.refresh_token = j.refresh_token; e.expires_at = Date.now() + Number(j.expires_in || 3600) * 1000;
          await saveEtsy();
        }
        const h = { "x-api-key": `${ETSY_CLIENT}:${e.shared_secret}`, Authorization: "Bearer " + e.access_token, Accept: "application/json" };
        const g = await call(`https://openapi.etsy.com/v3/application/listings/${etsyId}/inventory`, { headers: h });
        if (g.status >= 300) throw new Error(`Etsy read ${g.status} ${g.body.slice(0, 150)}`);
        const inv = J(g.body);
        const products = (inv.products || []).map((p: any) => ({ sku: p.sku || "", property_values: (p.property_values || []).map((v: any) => ({ property_id: v.property_id, value_ids: v.value_ids, scale_id: v.scale_id, property_name: v.property_name, values: v.values })),
          offerings: (p.offerings || []).map((o: any) => ({ price: price || Number(o.price?.amount) / Number(o.price?.divisor || 100), quantity: qty || Number(o.quantity), is_enabled: o.is_enabled !== false, ...(o.readiness_state_id ? { readiness_state_id: o.readiness_state_id } : {}) })) }));
        const body = { products, price_on_property: inv.price_on_property || [], quantity_on_property: inv.quantity_on_property || [], sku_on_property: inv.sku_on_property || [] };
        const p = await call(`https://openapi.etsy.com/v3/application/listings/${etsyId}/inventory`, { method: "PUT", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        out.etsy = p.status < 300 ? `${qty ? 'qty ' + qty + ' ' : ''}${price ? 'price $' + price.toFixed(2) + ' ' : ''}(listing ${etsyId})` : `error ${p.status}: ${p.body.slice(0, 200)}`;
      } catch (e) { out.etsy = "error: " + String((e as Error).message).slice(0, 200); }
    } else out.etsy = "not listed";

    // Airtable
    try {
      const at = (method: string, qs = "", body?: unknown) => call(`https://api.airtable.com/v0/${BASE}/${T_INV}${qs ? "?" + qs : ""}`, { method,
        headers: { Authorization: "Bearer " + K.airtable.token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, 4);
      const f = await at("GET", "returnFieldsByFieldId=true&maxRecords=1&filterByFormula=" + encodeURIComponent(`{${F_TRACK}}='${pd}'`));
      const rec = (J(f.body).records || [])[0];
      if (!rec) out.airtable = "no record";
      else { const u = await at("PATCH", "", { typecast: true, records: [{ id: rec.id, fields: { ...(qty ? { [F_QTY]: qty } : {}), ...(price ? { [F_LIST]: price, [F_AUTO]: auto, [F_MIN]: mn } : {}) } }] }); out.airtable = u.status < 300 ? 'updated' : `error ${u.status}`; }
    } catch (e) { out.airtable = "error: " + String((e as Error).message).slice(0, 160); }

    // the draft
    if (qty) await sql`update pipeline.drafts set answers = jsonb_set(coalesce(answers, '{}'::jsonb), '{station}', coalesce(answers->'station', '{}'::jsonb) || jsonb_build_object('qty', ${qty}::int))
      where pd = ${pd}`;
    if (price) await sql`update pipeline.drafts set pricing = coalesce(pricing, '{}'::jsonb) || jsonb_build_object('list', ${price}::numeric, 'auto', ${auto}::numeric, 'min', ${mn}::numeric, 'price_set_at', now())
      where pd = ${pd}`;
    out.draft = "updated";
    out.ok = !/error/.test(JSON.stringify([out.ebay, out.etsy, out.airtable]));
    return json(out);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally {
    if (locked) await sql`select pg_advisory_unlock(7342001)`.catch(() => {});
    await sql.end({ timeout: 3 });
  }
});
