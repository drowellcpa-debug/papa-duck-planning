// Papa Duck - Edge Function "offer-advice" v1 (2026-11-02). Papa Duck: "when I get a offer that requires my attention can you let me know
// to accept or decline, I dont want to get in a bidding war nor do I want to leave money on the table".
// Every 15 minutes (pg_cron pd-offer-advice): eBay Trading GetBestOffers = every ACTIVE offer waiting on him (offers at or above his
// auto-accept price are taken by eBay itself; below his minimum are declined by eBay). For each new offer: his list / auto / minimum /
// cost (Airtable), days listed + watchers (GetItem), what the same book is asking elsewhere on eBay (Browse) -> ONE call:
//   ACCEPT  - offer >= 90% of list, or at/above what the same item asks elsewhere, or listed 60+ days and above his minimum
//   COUNTER ONCE at $X (firm) - in between; X = halfway from the offer to the list, never below his auto-accept price. If they counter back:
//            accept anything at or above his auto-accept price, otherwise let it expire. No back-and-forth (no bidding war).
//   DECLINE - under his minimum or under cost + $3.
// v1 also ANSWERS for him: POST {"respond": BestOfferID} sends the answer he tapped on the Launch Pad (pipeline.offer_answer) with
//   RespondToBestOffer (Accept / Decline / Counter at his price, quantity 1), then the alert shows what eBay said.
// -> Launch Pad alert kind 'urgent' (offers expire in 48 hours), dedupe offer:<BestOfferID>. POST {} = sweep. POST {"test":{...}} = dry advice.
// Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "appdMXzb9U4sdXpAr", T_INV = "tblKxgB4q7v9SPqze";
const F_TRACK = "fldxiwKYi6z1t0iDx", F_LIST = "fldqfykAq3wumx32C", F_AUTO = "fldSpnDZLINeJyA0c", F_MIN = "fldvRL78ZiKrr3Vrh", F_COST = "fldyhCaL3G2km40fk";
const arr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();
const xesc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number) => "$" + n.toFixed(2);
const down99 = (x: number) => Math.max(0.99, Math.floor(x) - 0.01 + (x - Math.floor(x) >= 0.99 ? 1 : 0));

export function advise(a: { offer: number; list: number; auto: number; min: number; cost: number; days: number; watchers: number; market: number | null; qty: number }) {
  const { offer: O, list: L, auto: A, min: M, cost: C, days: D, market: K } = a;
  const why: string[] = [];
  if (A && O >= A) return { call: "ACCEPT", price: O, why: `It is at your own auto-accept price (${money(A)}).` };
  if (O < Math.max(M || 0, (C || 0) + 3)) {
    return { call: "DECLINE", price: null, why: O < (M || 0) ? `Under your minimum of ${money(M)}.` : `Too close to what you paid (${money(C)}) once fees are taken out.` };
  }
  if (O >= 0.9 * L) return { call: "ACCEPT", price: O, why: `${Math.round(O / L * 100)}% of your ${money(L)} price - a fair deal.` };
  if (K && O >= K * 0.95) return { call: "ACCEPT", price: O, why: `The same item asks about ${money(K)} elsewhere on eBay, so this offer is at the market.` };
  if (D >= 60) return { call: "ACCEPT", price: O, why: `Listed ${D} days and above your minimum - take the sale.` };
  let X = down99((O + L) / 2);
  if (A && X < A) X = A;
  if (X >= L) X = Math.max(A || 0, down99(L - 1));
  if (K && X > K) X = Math.max(O, down99(K));
  why.push(`Offer is ${Math.round(O / L * 100)}% of your ${money(L)} price${K ? `; the same item asks about ${money(K)} elsewhere` : ""}.`);
  why.push(`Counter ONCE at ${money(X)}. If they counter back: accept anything ${A ? "at or above " + money(A) : "close to " + money(X)}, otherwise let it expire - no back-and-forth.`);
  return { call: "COUNTER", price: X, why: why.join(" ") };
}

async function call(url: string, init: any = {}, tries = 3) {
  for (let a = 0; ; a++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) });
    const body = await r.text();
    if ((r.status === 429 || r.status >= 500) && a < tries - 1) { await sleep(2000 * (a + 1)); continue; }
    return { status: r.status, body };
  }
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    if (b.test) return json(advise(b.test));
    const K = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
    const e = K.ebay;
    const trading = async (name: string, inner: string) => {
      const r = await call("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xesc(e.auth_token)}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` });
      return parser.parse(r.body)[name + "Response"] || {};
    };
    // his answer from the Launch Pad -> eBay
    if (b.respond) {
      const [o] = await sql`select * from pipeline.offers where bo_id = ${String(b.respond)}`;
      if (!o || o.status !== "sending") return json({ ok: false, error: "no answer waiting for that offer" }, 400);
      const act = o.answer === "accept" ? "Accept" : o.answer === "decline" ? "Decline" : "Counter";
      const inner = `<ItemID>${xesc(o.item_id)}</ItemID><BestOfferID>${xesc(o.bo_id)}</BestOfferID><Action>${act}</Action>`
        + (act === "Counter" ? `<CounterOfferPrice currencyID="USD">${Number(o.answer_price).toFixed(2)}</CounterOfferPrice><CounterOfferQuantity>${Number(o.qty) || 1}</CounterOfferQuantity><SellerResponse>Thank you for your offer! This is my best price.</SellerResponse>` : "");
      const x = await trading("RespondToBestOffer", inner);
      const st = arr(x.RespondToBestOffer?.BestOffer).map((z: any) => txt(z.CallStatus)).join(",");
      const ok = ["Success", "Warning"].includes(txt(x.Ack)) && !/Failure/i.test(st);
      const err = arr(x.Errors).map((z: any) => txt(z.LongMessage)).join("; ").slice(0, 250);
      const done = act === "Accept" ? `accepted ${money(Number(o.offer))} - it's a sale, it will show on To ship` : act === "Decline" ? "declined" : `countered at ${money(Number(o.answer_price))} (your final price)`;
      await sql`update pipeline.offers set status = ${ok ? "answered" : "error"}, result = ${ok ? done : err || "eBay did not take it"} where bo_id = ${o.bo_id}`;
      await sql`update pipeline.alerts set kind = ${ok ? "handled" : "urgent"}, title = ${(o.sku || "eBay") + (ok ? ": offer " + done : ": eBay did not take your answer")},
        detail = ${ok ? "Done - nothing else to do." + (act === "Counter" ? " If they counter back I'll tell you." : "") : "eBay said: " + (err || "no reason") + ". Answer it in the eBay app."} where id = ${o.alert_id}`;
      return json({ ok, done, err });
    }
    // every active offer waiting on him
    const g = await trading("GetBestOffers", `<BestOfferStatus>Active</BestOfferStatus><DetailLevel>ReturnAll</DetailLevel>`);
    if (!["Success", "Warning"].includes(txt(g.Ack))) return json({ ok: false, error: arr(g.Errors).map((z: any) => txt(z.LongMessage)).join("; ") }, 500);
    const groups = arr(g.ItemBestOffersArray?.ItemBestOffers);
    const out: any[] = [];
    const active = new Set<string>();
    let appTok = "";
    for (const grp of groups) {
      const item = grp.Item || {}, itemId = txt(item.ItemID);
      for (const bo of arr(grp.BestOfferArray?.BestOffer)) {
        const boId = txt(bo.BestOfferID), offer = Number(txt(bo.Price)) || 0, qtyWanted = Number(txt(bo.Quantity)) || 1;
        if (!boId || !offer) continue;
        const dedupe = "offer:" + boId;
        active.add(boId);
        if ((await sql`select 1 from pipeline.alerts where dedupe = ${dedupe}`).length) { out.push({ boId, skipped: "already advised" }); continue; }
        // the listing
        const gi = (await trading("GetItem", `<ItemID>${itemId}</ItemID><IncludeWatchCount>true</IncludeWatchCount>`)).Item || {};
        const sku = txt(gi.SKU), title = txt(gi.Title), list = Number(txt(gi.StartPrice) || txt(gi.SellingStatus?.CurrentPrice)) || 0;
        const days = gi.ListingDetails?.StartTime ? Math.floor((Date.now() - new Date(txt(gi.ListingDetails.StartTime)).getTime()) / 864e5) : 0;
        const watchers = Number(txt(gi.WatchCount)) || 0;
        const auto = Number(txt(gi.ListingDetails?.BestOfferAutoAcceptPrice)) || 0, mn = Number(txt(gi.ListingDetails?.MinimumBestOfferPrice)) || 0;
        const left = Math.max(0, (Number(txt(gi.Quantity)) || 1) - (Number(txt(gi.SellingStatus?.QuantitySold)) || 0));
        // his cost from Airtable
        let cost = 0;
        if (/^PD-/.test(sku)) {
          const f = await call(`https://api.airtable.com/v0/${BASE}/${T_INV}?returnFieldsByFieldId=true&maxRecords=1&filterByFormula=` + encodeURIComponent(`{${F_TRACK}}='${sku}'`),
            { headers: { Authorization: "Bearer " + K.airtable.token } });
          const rec = (JSON.parse(f.body || "{}").records || [])[0];
          if (rec) cost = Number(rec.fields?.[F_COST]) || 0;
        }
        // what the same item asks elsewhere on eBay (delivered), median of the closest 8 by title
        let market: number | null = null;
        try {
          if (!appTok) {
            const t = await call("https://api.ebay.com/identity/v1/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(`${e.app_id}:${e.cert_id}`) },
              body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }).toString() });
            appTok = JSON.parse(t.body || "{}").access_token || "";
          }
          if (appTok && title) {
            const u = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
            u.searchParams.set("q", title.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" "));
            u.searchParams.set("limit", "20"); u.searchParams.set("filter", "buyingOptions:{FIXED_PRICE},priceCurrency:USD,itemLocationCountry:US");
            const s = await call(u.toString(), { headers: { Authorization: "Bearer " + appTok, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
            const v = (JSON.parse(s.body || "{}").itemSummaries || []).filter((x: any) => !String(x.itemId || "").includes(itemId))
              .map((x: any) => Number(x.price?.value || 0) + Number(x.shippingOptions?.[0]?.shippingCost?.value || 0)).filter((n: number) => n > 0).sort((a: number, b: number) => a - b).slice(0, 8);
            if (v.length >= 3) market = Math.round(v[Math.floor(v.length / 2)] * 100) / 100;
          }
        } catch (_) { market = null; }
        const adv = advise({ offer, list, auto, min: mn, cost, days, watchers, market, qty: left });
        const expAt = txt(bo.ExpirationTime) || null;
        const head = adv.call === "ACCEPT" ? `✅ ACCEPT ${money(offer)}` : adv.call === "DECLINE" ? `❌ DECLINE ${money(offer)}` : `↩️ COUNTER ONCE at ${money(adv.price!)}`;
        const exp = txt(bo.ExpirationTime) ? new Date(txt(bo.ExpirationTime)).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" }) : "in 48 hours";
        const detail = `Offer ${money(offer)}${qtyWanted > 1 ? ` for ${qtyWanted}` : ""} on your ${money(list)} listing${cost ? ` (you paid ${money(cost)})` : ""}. ${adv.why} Listed ${days} days, ${watchers} watching. Expires ${exp}. Tap your answer below and I send it to eBay (or answer in the eBay app).`;
        const [al] = await sql`select pipeline.alert_add('eBay', ${`${sku || "eBay " + itemId}: offer - ${head}`}, ${detail}, ${sku || null},
          ${"https://www.ebay.com/sh/ord/offers?itemId=" + itemId}, 'urgent', ${dedupe}) as id`;
        await sql`insert into pipeline.offers (bo_id, item_id, sku, title, offer, qty, list, auto, min, cost, advice, counter, why, alert_id, expires)
          values (${boId}, ${itemId}, ${sku || null}, ${title}, ${offer}, ${qtyWanted}, ${list}, ${auto}, ${mn}, ${cost}, ${adv.call.toLowerCase()}, ${adv.call === "COUNTER" ? adv.price : null},
            ${adv.why}, ${Number(al.id)}, ${expAt}) on conflict (bo_id) do nothing`;
        active.add(boId);
        out.push({ boId, sku, title, offer, list, auto, min: mn, cost, days, watchers, market, ...adv });
      }
    }
    // offers he answered in the eBay app, the buyer withdrew, or that expired: off the Launch Pad
    const gone = await sql`update pipeline.offers set status = 'closed', result = coalesce(result, 'answered in eBay, withdrawn or expired')
      where status = 'open' and not (bo_id = any(${[...active, ""]}::text[])) returning alert_id`;
    for (const r of gone as any[]) await sql`update pipeline.alerts set done_at = now() where id = ${r.alert_id} and done_at is null`;
    return json({ ok: true, offers: out.length, closed: gone.length, out });
  } catch (err) {
    return json({ ok: false, error: String((err as Error).message || err).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
