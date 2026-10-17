// Papa Duck - Edge Function "reprice-push" v1 (2026-10-17). Papa Duck: "tell perplexity how to review the books already listed to do a repricer" ... "yes please".
// Pushes approved prices for books ALREADY LISTED on eBay. Source: pipeline.price_review rows with status 'approved' and evidence.listed = true
// (written by Perplexity, or approved by Papa Duck's button). For each row:
//   1. find the eBay ItemID (evidence.ebay_item_id, else Airtable Inventory by PD)
//   2. GetItem: must be Active with stock; read the live price and Best Offer numbers
//   3. guards: listing Active with stock and SKU = PD; new price >= min list ($6.99); no change under $0.50. Fully automatic (Papa Duck 10/17):
//      big moves are pushed and named in the note, never held for approval.
//   4. ReviseFixedPriceItem: StartPrice, Best Offer auto-accept = 80% (to .50, below list), minimum keeps its old place in the band
//   5. GetItem read-back must show the new price; Airtable List / Auto / Min updated; row -> applied with push_note
// AbeBooks prices are NOT changed here yet (a flat-file resend rewrites the whole listing; photo behaviour on resend is unproven) - noted on the row.
// Calls: POST {} = work the queue. POST {"dry": true} = check every approved row, change nothing. POST {"same": "PD-xxxx"} = revise one live
// listing to its OWN current price (a harmless end-to-end test of the revise call).
// Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";
const xmlp = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const arr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();
const xesc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "appdMXzb9U4sdXpAr", T_INV = "tblKxgB4q7v9SPqze";
const F_ITEMID = "fldKGZyyXy0Gjox5b", F_LIST = "fldqfykAq3wumx32C", F_AUTO = "fldSpnDZLINeJyA0c", F_MIN = "fldvRL78ZiKrr3Vrh", F_STATUS = "fldK5pTHj5iCEmf0w";
const r50 = (x: number) => Math.round(x * 2) / 2;

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now(); const log: any[] = [];
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const body = await req.json().catch(() => ({}));
    const dry = !!body?.dry, same = String(body?.same || "");
    const [lk] = await sql`select pg_try_advisory_lock(7342077) as ok`;
    if (!lk.ok) return json({ ok: true, busy: true });
    const K = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    const minList = Number(conf.min_list_drafts) || 6.99;
    const e = K.ebay;
    const trading = async (call: string, inner: string) => {
      const b = `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xesc(e.auth_token)}</eBayAuthToken></RequesterCredentials><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>${inner}</${call}Request>`;
      for (let a = 0; a < 3; a++) {
        const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", body: b, signal: AbortSignal.timeout(60000), headers: { "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "1193", "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" } });
        const t = await r.text();
        if (r.status >= 500 && a < 2) { await sleep(3000 * (a + 1)); continue; }
        return xmlp.parse(t)[call + "Response"] || {};
      }
      return {};
    };
    const errs = (x: any) => arr(x.Errors).filter((er: any) => txt(er.SeverityCode) === "Error").map((er: any) => `${txt(er.ErrorCode)} ${txt(er.LongMessage) || txt(er.ShortMessage)}`).join("; ");
    const at = async (pd: string) => {
      const r = await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}?` + new URLSearchParams([["filterByFormula", `{Tracking Number}='${pd}'`], ["returnFieldsByFieldId", "true"],
        ["fields[]", F_ITEMID], ["fields[]", F_LIST], ["fields[]", F_STATUS]]), { headers: { Authorization: "Bearer " + K.airtable.token }, signal: AbortSignal.timeout(30000) });
      return ((await r.json()).records || []) as any[];
    };
    const live = async (itemId: string) => {
      const g = await trading("GetItem", `<ItemID>${xesc(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>false</IncludeItemSpecifics>`);
      const it = g.Item || {};
      return { ack: txt(g.Ack), err: errs(g), status: txt(it.SellingStatus?.ListingStatus), sku: txt(it.SKU), title: txt(it.Title),
        price: Number(txt(it.StartPrice)) || 0, qty: Number(txt(it.Quantity)) - Number(txt(it.SellingStatus?.QuantitySold) || 0),
        auto: Number(txt(it.ListingDetails?.BestOfferAutoAcceptPrice)) || 0, min: Number(txt(it.ListingDetails?.MinimumBestOfferPrice)) || 0,
        bo: txt(it.BestOfferDetails?.BestOfferEnabled) === "true" };
    };
    const offers = (lst: number, oldList: number, oldMin: number) => {
      let auto = r50(lst * 0.8); if (auto >= lst) auto = +(lst - 0.5).toFixed(2);
      const ratio = oldList > 0 && oldMin > 0 ? oldMin / oldList : 0.6;
      let mn = r50(lst * ratio); if (mn > auto) mn = auto;
      return { auto, mn };
    };
    const revise = async (itemId: string, lst: number, auto: number, mn: number) => {
      const x = await trading("ReviseFixedPriceItem", `<Item><ItemID>${xesc(itemId)}</ItemID><StartPrice currencyID="USD">${lst.toFixed(2)}</StartPrice>` +
        `<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails><ListingDetails><BestOfferAutoAcceptPrice currencyID="USD">${auto.toFixed(2)}</BestOfferAutoAcceptPrice>` +
        `<MinimumBestOfferPrice currencyID="USD">${mn.toFixed(2)}</MinimumBestOfferPrice></ListingDetails></Item>`);
      return { ok: ["Success", "Warning"].includes(txt(x.Ack)), err: errs(x) || txt(x.Ack) };
    };
    const writeAt = async (rec: string, lst: number, auto: number, mn: number) => {
      const r = await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}`, { method: "PATCH", headers: { Authorization: "Bearer " + K.airtable.token, "Content-Type": "application/json" },
        body: JSON.stringify({ typecast: true, records: [{ id: rec, fields: { [F_LIST]: lst, [F_AUTO]: auto, [F_MIN]: mn } }] }), signal: AbortSignal.timeout(30000) });
      return r.ok ? "Airtable updated" : "Airtable write failed " + r.status;
    };

    // ---- test: revise one live listing to its own current price ----
    if (same) {
      const recs = await at(same); const itemId = String(recs[0]?.fields?.[F_ITEMID] || "").replace(/\D/g, "");
      if (!itemId) return json({ ok: false, error: "no eBay ItemID in Airtable for " + same });
      const L = await live(itemId);
      if (L.status !== "Active") return json({ ok: false, error: `listing ${itemId} is ${L.status || L.err}` });
      const auto = L.auto || offers(L.price, L.price, L.min).auto, mn = L.min || offers(L.price, L.price, 0).mn;
      const rv = await revise(itemId, L.price, auto, Math.min(mn, auto));
      const B = await live(itemId);
      return json({ ok: rv.ok && Math.abs(B.price - L.price) < 0.005, test: "same price", pd: same, itemId, before: L, after: B, revise: rv });
    }

    const rows: any[] = await sql`select * from pipeline.price_review where status = 'approved' and coalesce(evidence->>'listed','') = 'true' and applied_at is null order by id limit 40`;
    for (const r of rows) {
      if (Date.now() - t0 > 120000) break;
      const note = async (status: string, msg: string) => {
        log.push({ pd: r.pd, status, msg });
        if (!dry) await sql`update pipeline.price_review set status = ${status}, push_note = ${msg}, pushed_at = now(),
            applied_at = case when ${status} = 'applied' then now() else applied_at end where id = ${r.id}`;
      };
      try {
        const want = Math.round(Number(r.recommended_price) * 100) / 100;
        const ev = r.evidence || {};
        const recs = await at(r.pd);
        let itemId = String(ev.ebay_item_id || recs[0]?.fields?.[F_ITEMID] || "").replace(/\D/g, "");
        if (!itemId) { await note("needs_papa_duck", "No eBay ItemID found (evidence or Airtable) - nothing changed."); continue; }
        const L = await live(itemId);
        if (L.status !== "Active") { await note("rejected", `eBay ${itemId} is ${L.status || "not found"} - sold or ended, nothing changed.`); continue; }
        if (L.sku && L.sku !== r.pd) { await note("needs_papa_duck", `eBay ${itemId} has SKU ${L.sku}, not ${r.pd} - nothing changed.`); continue; }
        if (L.qty < 1) { await note("rejected", `eBay ${itemId} has no stock left - nothing changed.`); continue; }
        if (!(want >= minList)) { await note("needs_papa_duck", `Recommended $${want.toFixed(2)} is under the $${minList.toFixed(2)} minimum - nothing changed.`); continue; }
        if (Math.abs(want - L.price) < 0.5) { await note("applied", `Live price is already $${L.price.toFixed(2)} - nothing to change.`); continue; }
        const move = Math.abs(want - L.price) / L.price;
        // 2026-10-17 Papa Duck: "I dont want to have to aprove each one ... this has to be automitc" - big moves go through too, just named in the note
        const big = move >= 0.40 ? ` (big move ${Math.round(move * 100)}%)` : "";
        // 2026-10-17 Papa Duck: "Let you be the final say" - after Life in the Sea went $6.99 -> $27.99 on AbeBooks-only asks: a Perplexity raise to
        // 2x+ the live price, or to $25+, waits for Claude's check (status 'waiting', reviewer stays). Claude re-approves or writes its own row.
        if (r.reviewer !== "claude" && want > L.price && (want >= 2 * L.price || want >= 25) && ev.claude_ok !== true) {
          await note("waiting", `Held for Claude's check: raise $${L.price.toFixed(2)} -> $${want.toFixed(2)} is large - nothing changed yet.`); continue; }
        const { auto, mn } = offers(want, L.price, L.min);
        if (dry) { log.push({ pd: r.pd, itemId, would: `$${L.price.toFixed(2)} -> $${want.toFixed(2)} (auto $${auto.toFixed(2)}, min $${mn.toFixed(2)})` }); continue; }
        const rv = await revise(itemId, want, auto, mn);
        if (!rv.ok) { await note("needs_papa_duck", `eBay refused the revise: ${rv.err}`.slice(0, 400)); continue; }
        const B = await live(itemId);
        const okBack = Math.abs(B.price - want) < 0.005;
        const atMsg = recs[0]?.id ? await writeAt(recs[0].id, want, auto, mn) : "no Airtable record";
        await note(okBack ? "applied" : "needs_papa_duck", `${okBack ? "eBay" : "CHECK eBay"} ${itemId}: $${L.price.toFixed(2)} -> $${B.price.toFixed(2)} (auto $${auto.toFixed(2)}, min $${mn.toFixed(2)}). ${atMsg}. AbeBooks not changed yet.${big}`);
      } catch (er) {
        await note("needs_papa_duck", "Push failed: " + String((er as Error).message || er).slice(0, 300));
      }
    }
    await sql`select pg_advisory_unlock(7342077)`;
    return json({ ok: true, dry, rows: rows.length, log, secs: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 400), log }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
