// Papa Duck - Edge Function "recount-apply" v2 (2026-11-04; v2: also "find" to-dos - an old eBay listing with no PD he could not find on the shelf gets ended). Papa Duck: "put on a list any that we are uncertain and I will get you a recount".
// When he saves a shelf count on the Launch Pad To-do card (pipeline.todo_recount), this sets every store to that count:
//   eBay ReviseInventoryStatus (0 = end the listing), Etsy inventory quantity (0 = inactive), Airtable Quantity (0 = Unlisted),
//   AbeBooks: 0 = DELETE; other counts need a full-record update (AbeBooks has no quantity-only call) -> flagged for Claude.
// Writes what happened to pipeline.todos.applied and marks the to-do done when every store matched. POST {"id": todo id}. Auth: x-backup-secret.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const BASE = "appdMXzb9U4sdXpAr", T_INV = "tblKxgB4q7v9SPqze", ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", ETSY_SHOP = "65331509", ETSY_READY = 1502395825992;
const F = { TRACK: "fldxiwKYi6z1t0iDx", ITEMID: "fldKGZyyXy0Gjox5b", STATUS: "fldK5pTHj5iCEmf0w", QTY: "fld7MrQXX1D8iD0ap" };

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const [t] = await sql`select * from pipeline.todos where id = ${Number(b.id)} and kind in ('recount', 'find')`;
    if (!t || t.answer == null) return json({ ok: false, error: "no answer for that to-do" }, 400);
    if (t.kind === "find") {
      if (Number(t.answer) !== 0 || !t.ref) return json({ ok: true, skipped: true });
      const K0 = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).ebay;
      const tr = async (name: string, inner: string) => (await (await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-APP-NAME": K0.app_id, "X-EBAY-API-DEV-NAME": K0.dev_id, "X-EBAY-API-CERT-NAME": K0.cert_id, "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${K0.auth_token.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` })).text());
      const pk = (x: string, tag: string) => (x.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || "";
      const g0 = await tr("GetItem", `<ItemID>${t.ref}</ItemID><DetailLevel>ReturnSummary</DetailLevel>`);
      let text = "";
      if (pk(g0, "ListingStatus") !== "Active") text = `eBay: already ${pk(g0, "ListingStatus") || "gone"}`;
      else { await tr("EndItem", `<ItemID>${t.ref}</ItemID><EndingReason>NotAvailable</EndingReason>`); const g1 = await tr("GetItem", `<ItemID>${t.ref}</ItemID><DetailLevel>ReturnSummary</DetailLevel>`);
        text = pk(g1, "ListingStatus") === "Active" ? "eBay FAILED - still live" : "eBay: listing ended"; }
      await sql`update pipeline.todos set applied = ${text}, done_at = ${/FAILED/.test(text) ? null : new Date()} where id = ${t.id}`;
      return json({ ok: !/FAILED/.test(text), text });
    }
    const pd = String(t.pd).toUpperCase(), n = Number(t.answer);
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const K = JSON.parse(vr[0].decrypted_secret);
    const log: string[] = []; let needsClaude = false, bad = false;

    // eBay: every live listing for this PD (by SKU in the last audit, plus the Airtable item number)
    const at = await (await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}?` + new URLSearchParams([["filterByFormula", `{Tracking Number}='${pd}'`], ["returnFieldsByFieldId", "true"]]),
      { headers: { Authorization: "Bearer " + K.airtable.token } })).json();
    const rec = (at.records || [])[0];
    const atItem = String(rec?.fields?.[F.ITEMID] || "").replace(/\D/g, "");
    const items = new Set<string>((await sql`select item_id from audit.ebay where upper(sku) = ${pd} and avail > 0`).map((r: any) => r.item_id));
    if (atItem) items.add(atItem);
    const e = K.ebay;
    const trade = async (name: string, inner: string) => (await (await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
      body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${e.auth_token.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` })).text());
    const pick = (x: string, tag: string) => (x.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || "";
    let ebayDone = false;
    for (const id of items) {
      const g = await trade("GetItem", `<ItemID>${id}</ItemID><DetailLevel>ReturnSummary</DetailLevel>`);
      if (pick(g, "ListingStatus") !== "Active") continue;
      if (ebayDone) { await trade("EndItem", `<ItemID>${id}</ItemID><EndingReason>NotAvailable</EndingReason>`); log.push(`eBay: ended duplicate ${id}`); continue; }
      const x = n === 0 ? await trade("EndItem", `<ItemID>${id}</ItemID><EndingReason>NotAvailable</EndingReason>`)
                        : await trade("ReviseInventoryStatus", `<InventoryStatus><ItemID>${id}</ItemID><Quantity>${n}</Quantity></InventoryStatus>`);
      const ok = /Success|Warning/.test(pick(x, "Ack"));
      if (!ok) bad = true;
      log.push(ok ? (n === 0 ? `eBay: ended ${id}` : `eBay: ${n}`) : `eBay FAILED: ${pick(x, "LongMessage").slice(0, 120)}`);
      ebayDone = true;
    }
    if (!items.size) log.push("eBay: not listed");

    // Etsy
    const etsyIds = (await sql`select listing_id from audit.etsy where (upper(sku) = ${pd} or listing_id = (select etsy from audit.at_map where pd = ${pd} limit 1))
      and run_id = (select run_id from audit.runs where store = 'etsy')`).map((r: any) => r.listing_id);
    if (etsyIds.length) {
      const ek = K.etsy;
      if (!(ek.access_token && (ek.expires_at || 0) > Date.now() + 5 * 60e3)) {
        const r = await fetch("https://api.etsy.com/v3/public/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: ETSY_CLIENT, refresh_token: ek.refresh_token }) });
        const j = await r.json();
        if (!j.access_token || !j.refresh_token) throw new Error(`Etsy token refresh failed (${r.status})`);
        ek.access_token = j.access_token; ek.refresh_token = j.refresh_token; ek.expires_at = Date.now() + Number(j.expires_in || 3600) * 1000;
        const cur = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
        cur.etsy = ek; await sql`select vault.update_secret(${vr[0].id}::uuid, ${JSON.stringify(cur)})`;
      }
      const H = { "x-api-key": `${ETSY_CLIENT}:${ek.shared_secret}`, Authorization: "Bearer " + ek.access_token, Accept: "application/json" };
      for (const lid of etsyIds) {
        if (n === 0) {
          const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP}/listings/${lid}`, { method: "PATCH", headers: { ...H, "Content-Type": "application/x-www-form-urlencoded" }, body: "state=inactive" });
          log.push(r.ok ? "Etsy: off" : `Etsy FAILED ${r.status}`); if (!r.ok) bad = true; continue;
        }
        const inv = await (await fetch(`https://openapi.etsy.com/v3/application/listings/${lid}/inventory`, { headers: H })).json();
        const products = (inv.products || []).map((p: any) => ({ sku: p.sku || "", property_values: [], offerings: (p.offerings || []).map((o: any) => ({
          price: Math.round(Number(o.price?.amount || 0) / Number(o.price?.divisor || 100) * 100) / 100, quantity: n, is_enabled: o.is_enabled !== false,
          readiness_state_id: Number(o.readiness_state_id || ETSY_READY) })) }));
        const r = await fetch(`https://openapi.etsy.com/v3/application/listings/${lid}/inventory`, { method: "PUT", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ products }) });
        log.push(r.ok ? `Etsy: ${n}` : `Etsy FAILED ${r.status}`); if (!r.ok) bad = true;
      }
    } else log.push("Etsy: not listed");

    // AbeBooks
    const [abe] = await sql`select qty from audit.abe where pd = ${pd} and run_id = (select run_id from audit.runs where store = 'abe') limit 1`;
    if (!abe) log.push("AbeBooks: not listed");
    else if (Number(abe.qty) === n) log.push(`AbeBooks: already ${n}`);
    else if (n === 0) {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<inventoryUpdateRequest version="1.0">\n<action name="bookupdate">\n  <username>${esc(K.abe.username)}</username>\n  <password>${esc(K.abe.password)}</password>\n</action>\n<AbebookList>\n  <Abebook>\n    <transactionType>DELETE</transactionType>\n    <vendorBookID>${pd}</vendorBookID>\n  </Abebook>\n</AbebookList>\n</inventoryUpdateRequest>\n`;
      const r = await (await fetch("https://inventoryupdate.abebooks.com:10027", { method: "POST", body, headers: { "Content-Type": "text/xml; charset=utf-8" } })).text();
      log.push(/<code>600<\/code>/.test(r) ? "AbeBooks: deleted" : "AbeBooks FAILED delete"); if (!/<code>600<\/code>/.test(r)) bad = true;
    } else { needsClaude = true; log.push(`AbeBooks: shows ${abe.qty} - Claude will set it to ${n}`); }

    // Airtable
    if (rec) {
      const fields: Record<string, unknown> = { [F.QTY]: n };
      if (n === 0) fields[F.STATUS] = "Unlisted";
      const r = await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}`, { method: "PATCH", headers: { Authorization: "Bearer " + K.airtable.token, "Content-Type": "application/json" },
        body: JSON.stringify({ typecast: true, records: [{ id: rec.id, fields }] }) });
      log.push(r.ok ? `Airtable: ${n}${n === 0 ? " (Unlisted)" : ""}` : `Airtable FAILED ${r.status}`); if (!r.ok) bad = true;
    }

    const text = log.join(" · ");
    await sql`update pipeline.todos set applied = ${text}, done_at = ${!bad && !needsClaude ? new Date() : null} where id = ${t.id}`;
    if (needsClaude || bad) await sql`select pipeline.alert_add('To-do', ${`${pd}: recount ${n} saved`}, ${text}, ${pd}, null, ${bad ? "issue" : "question"}, ${"recount:" + pd + ":" + n})`;
    return json({ ok: !bad, pd, n, log });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
