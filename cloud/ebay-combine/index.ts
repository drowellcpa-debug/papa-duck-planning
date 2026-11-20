// Papa Duck - Edge Function "ebay-combine" v3 (2026-11-19: "items" wording for non-book orders). v1 (2026-11-18). Combined-shipping invoices with one tap on the Launch Pad.
// Papa Duck (mkruz83 bought 3 Moving Beyond the Page books and asked to combine shipping): "you have api can you do this automatically fo rme" /
//   "in the future do this for me ask and I will click do and estimate shipping".
//   POST {action:"scan"}        (cron every 15 min) eBay GetOrders, last 4 days: a buyer with 2+ UNPAID single orders becomes a card in
//                               pipeline.combine_invoices - item weights from GetItem, ONE box priced by USPS Media Mail retail
//                               (pipeline.media_mail_price). A card whose orders were paid / combined elsewhere closes as 'gone'.
//   POST {action:"test", days} the same grouping and price math on recent PAID orders too - nothing saved (to check the numbers).
//   POST {action:"send", id}    (his tap, pipeline.combine_send) AddOrder = one combined order at HIS shipping price, then SendInvoice with
//                               the message shown on the card. Nothing goes to a buyer without the tap.
// Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";
const xmlp = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const arr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();
const xesc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const money = (n: number) => n.toFixed(2);

function message(firstName: string, n: number, ship: number, media: boolean) {
  const hi = firstName ? `Hi ${firstName}!` : "Hi!";
  // v3 (2026-11-19): "items" when they aren't all books (ge502544 bought two dollhouse miniature kits - the card said "books")
  const what = media ? "books" : "items";
  return `${hi} Thanks so much for your order. I combined all ${n} ${what} into one package, so you only pay shipping once ($${money(ship)}). ` +
    `They'll go out ${media ? "by Media Mail " : ""}as soon as payment comes through. Enjoy your ${what}! - Papa Duck Homeschool`;
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (!cs || req.headers.get("x-backup-secret") !== cs.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const K = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).ebay;
    const trading = async (call: string, inner: string) => {
      const body = `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xesc(K.auth_token)}</eBayAuthToken></RequesterCredentials><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>${inner}</${call}Request>`;
      for (let a = 0; a < 3; a++) {
        const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", body, signal: AbortSignal.timeout(45000), headers: { "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "1193", "X-EBAY-API-APP-NAME": K.app_id, "X-EBAY-API-DEV-NAME": K.dev_id, "X-EBAY-API-CERT-NAME": K.cert_id, "Content-Type": "text/xml" } });
        const t = await r.text();
        if (r.status >= 500 && a < 2) { await new Promise((z) => setTimeout(z, 2500 * (a + 1))); continue; }
        return xmlp.parse(t)[call + "Response"] || {};
      }
      return {};
    };
    const errs = (x: any) => arr(x.Errors).filter((e: any) => txt(e.SeverityCode) === "Error").map((e: any) => `${txt(e.ErrorCode)} ${txt(e.LongMessage) || txt(e.ShortMessage)}`).join("; ");

    // ------------------------------------------------------------------ scan  ({action:"test", days} = same math on PAID orders too, nothing saved)
    if ((b.action || "scan") === "scan" || b.action === "test") {
      const test = b.action === "test";
      const now = new Date(), from = new Date(now.getTime() - (test ? Math.min(30, Number(b.days) || 14) : 4) * 86400e3);
      const x = await trading("GetOrders", `<CreateTimeFrom>${from.toISOString()}</CreateTimeFrom><CreateTimeTo>${now.toISOString()}</CreateTimeTo><OrderRole>Seller</OrderRole><OrderStatus>${test ? "All" : "Active"}</OrderStatus><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>`);
      if (txt(x.Ack) === "Failure") return json({ ok: false, error: errs(x) }, 502);
      const groups = new Map<string, any>();
      for (const o of arr(x.OrderArray?.Order)) {
        if (!test && (txt(o.PaidTime) || txt(o.OrderStatus) !== "Active")) continue;
        const trs = arr(o.TransactionArray?.Transaction);
        if (trs.length !== 1) continue;                               // already a combined order
        const t = trs[0], buyer = txt(o.BuyerUserID);
        if (!buyer) continue;
        const g = groups.get(buyer) || { buyer, name: txt(o.ShippingAddress?.Name), zip: txt(o.ShippingAddress?.PostalCode), lines: [] as any[] };
        g.lines.push({ order: txt(o.OrderID), item: txt(t.Item?.ItemID), txn: txt(t.TransactionID), sku: txt(t.Item?.SKU), title: txt(t.Item?.Title).slice(0, 80),
          price: Number(txt(t.TransactionPrice)) || 0, qty: Number(txt(t.QuantityPurchased)) || 1 });
        groups.set(buyer, g);
      }
      const keys: string[] = []; const made: string[] = [];
      for (const g of groups.values()) {
        if (g.lines.length < 2) continue;
        // weights + shipping service from each listing
        for (const l of g.lines) {
          const it = (await trading("GetItem", `<ItemID>${l.item}</ItemID><DetailLevel>ReturnAll</DetailLevel>`)).Item || {};
          const pk = it.ShippingPackageDetails || {};
          const lb = (Number(txt(pk.WeightMajor)) || 0) + (Number(txt(pk.WeightMinor)) || 0) / 16;
          l.lb = lb > 0 ? lb : 1;                                                       // no weight on the listing: count 1 lb
          l.service = txt(arr(it.ShippingDetails?.ShippingServiceOptions)[0]?.ShippingService) || "";
        }
        g.lines.sort((a: any, z: any) => (a.item + a.txn).localeCompare(z.item + z.txn));
        const key = g.buyer + ":" + g.lines.map((l: any) => l.item + "-" + l.txn).join(",");
        keys.push(key);
        const itemsTotal = Math.round(g.lines.reduce((s: number, l: any) => s + l.price * l.qty, 0) * 100) / 100;
        const lbs = g.lines.reduce((s: number, l: any) => s + l.lb * l.qty, 0);
        const mediaOk = g.lines.every((l: any) => l.service === "USPSMedia");
        const service = mediaOk ? "USPSMedia" : (g.lines[0].service || "USPSGroundAdvantage");
        const [p] = await sql`select pipeline.media_mail_price(${lbs}) as p`;
        const est = mediaOk ? Number(p.p) : null;
        const first = String(g.name || "").trim().split(/\s+/)[0] || "";
        if (test) { made.push(`${g.buyer}: ${g.lines.length} books $${money(itemsTotal)}, ${Math.ceil(lbs)} lb (${g.lines.map((l: any) => l.sku + " " + l.lb + "lb " + l.service).join(", ")}) -> ship ${est ?? "manual"}`); continue; }
        const [row] = await sql`insert into pipeline.combine_invoices (key, buyer, buyer_name, zip, lines, items_total, weight_lb, ship_est, service, media_ok, message)
            values (${key}, ${g.buyer}, ${g.name || null}, ${g.zip || null}, ${sql.json(g.lines)}, ${itemsTotal}, ${Math.ceil(lbs)}, ${est}, ${service}, ${mediaOk},
                    ${message(first, g.lines.length, est ?? 0, mediaOk)})
            on conflict (key) do update set seen_at = now() returning id, (xmax = 0) as fresh`;
        if (row.fresh) made.push(g.buyer);
      }
      if (test) return json({ ok: true, test: true, groups: made });
      // cards whose orders were paid / combined in Seller Hub / cancelled
      const gone = await sql`update pipeline.combine_invoices set status = 'gone', result = 'Paid or combined in eBay - nothing to do'
          where status = 'pending' and not (key = any(${keys}::text[])) returning id`;
      return json({ ok: true, buyers_with_2plus: keys.length, new_cards: made, closed: gone.length });
    }

    // ------------------------------------------------------------------ send (his tap)
    if (b.action === "send") {
      const [c] = await sql`select * from pipeline.combine_invoices where id = ${Number(b.id)} and status = 'sending'`;
      if (!c) return json({ ok: false, error: "nothing to send" }, 404);
      const fail = async (m: string) => { await sql`update pipeline.combine_invoices set status = 'failed', result = ${m.slice(0, 400)} where id = ${c.id}`; return json({ ok: false, error: m }); };
      const ship = Number(c.ship), total = Math.round((Number(c.items_total) + ship) * 100) / 100;
      const first = String(c.buyer_name || "").trim().split(/\s+/)[0] || "";
      const msg = message(first, c.lines.length, ship, !!c.media_ok).slice(0, 500);
      const opt = `<ShippingServiceOptions><ShippingService>${xesc(c.service)}</ShippingService><ShippingServiceCost currencyID="USD">${money(ship)}</ShippingServiceCost><ShippingServicePriority>1</ShippingServicePriority></ShippingServiceOptions>`;
      const trs = c.lines.map((l: any) => `<Transaction><Item><ItemID>${xesc(l.item)}</ItemID></Item><TransactionID>${xesc(l.txn)}</TransactionID></Transaction>`).join("");
      const a = await trading("AddOrder", `<Order><CreatingUserRole>Seller</CreatingUserRole><ShippingDetails>${opt}</ShippingDetails><Total currencyID="USD">${money(total)}</Total><TransactionArray>${trs}</TransactionArray></Order>`);
      const orderId = txt(a.OrderID);
      if (!orderId) return fail("eBay would not combine the orders: " + (errs(a) || txt(a.Ack) || "no answer") + " - use Seller Hub > Orders > Awaiting payment > Send invoice");
      await sql`update pipeline.combine_invoices set combined_order = ${orderId} where id = ${c.id}`;
      const s = await trading("SendInvoice", `<OrderID>${xesc(orderId)}</OrderID>${opt}<CheckoutInstructions>${xesc(msg)}</CheckoutInstructions><EmailCopyToSeller>true</EmailCopyToSeller>`);
      if (txt(s.Ack) !== "Success" && txt(s.Ack) !== "Warning") return fail("Orders were combined (eBay order " + orderId + ") but the invoice didn't send: " + (errs(s) || txt(s.Ack)) + " - open it in Seller Hub and press Send invoice");
      await sql`update pipeline.combine_invoices set status = 'sent', sent_at = now(), message = ${msg}, result = ${"Invoice sent: $" + money(Number(c.items_total)) + " + $" + money(ship) + " shipping = $" + money(total) + " (+ tax)"} where id = ${c.id}`;
      return json({ ok: true, order: orderId, total });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
