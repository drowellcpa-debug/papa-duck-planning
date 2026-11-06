// Papa Duck - Edge Function "amazon-watch" v2 (2026-11-05; v2: a slow returns report is picked up next run, warning only after 3 slow runs). Papa Duck: "Can you automatically with amazon api look for issues like return asked for"
// (after a return request on PD-3190 never reached his email). Read-only. Runs from cron pd-amazon-watch every 2 hours and posts Launch Pad alerts:
//   1) RETURN REQUESTS  - SP-API report GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE (last 30 days): one alert per return (order + RMA),
//                         plain-words reason; "Pending" ones are marked urgent (Amazon wants an answer within 2 business days).
//   2) CANCEL REQUESTS  - unshipped orders whose buyer asked to cancel (Orders API order items BuyerRequestedCancel).
//   3) REFUNDS          - refund events from the Finances API (a refund with no return request also shows up).
// Each alert has a dedupe key, so nothing is posted twice. Nothing on Amazon is changed. Auth: x-backup-secret.
import postgres from "npm:postgres@3.4.4";
const AMZ = "https://sellingpartnerapi-na.amazon.com", MKT = "ATVPDKIKX0DER";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REASON: Record<string, string> = {
  "CR-DAMAGED_BY_FC": "arrived damaged", "CR-DAMAGED_BY_CARRIER": "arrived damaged", "CR-DEFECTIVE": "defective / does not work",
  "CR-NOT_AS_DESCRIBED": "not as described", "AMZ-PG-BAD-DESC": "not as described", "CR-QUALITY_UNACCEPTABLE": "quality not acceptable",
  "CR-UNWANTED_ITEM": "no longer needed", "CR-ORDERED_WRONG_ITEM": "bought by mistake", "CR-SWITCHEROO": "wrong item sent",
  "CR-MISSED_ESTIMATED_DELIVERY": "arrived too late", "CR-FOUND_BETTER_PRICE": "found a better price", "CR-MISSING_PARTS": "missing parts or pages",
  "CR-EXTRA_ITEM": "extra item received", "CR-UNAUTHORIZED_PURCHASE": "did not approve the purchase", "CR-NO_REASON_GIVEN": "no reason given",
};
const SAFE_T = /DAMAGED|NOT_AS_DESCRIBED|BAD-DESC|QUALITY|DEFECTIVE|SWITCHEROO|MISSING/;

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const out: any = { returns: 0, cancels: 0, refunds: 0, posted: 0, errors: [] as string[] };
  const post = async (title: string, detail: string, pd: string | null, kind: string, key: string) => {
    const [r] = await sql`select count(*)::int n from pipeline.alerts where dedupe = ${key}`.catch(() => [{ n: 0 }]);
    await sql`select pipeline.alert_add('Amazon', ${title}, ${detail}, ${pd}, ${"https://sellercentral.amazon.com/returns/list"}, ${kind}, ${key})`;
    if (!r || !r.n) out.posted++;
  };
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const A = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).amazon;
    const t = await (await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString() })).json();
    const H = { "x-amz-access-token": t.access_token, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" };
    const get = async (u: string) => { for (let a = 0; a < 6; a++) { const r = await fetch(u, { headers: H }); if (r.status === 429) { await sleep(2500); continue; } return await r.json(); } throw new Error("Amazon kept saying slow down"); };
    const since30 = new Date(Date.now() - 30 * 864e5).toISOString();

    // 1) return requests
    try {
      // v2: a slow Amazon report is not a problem - its id is kept (audit.runs 'amzwatch') and picked up next run; warn only after 3 misses in a row
      await sql`insert into audit.runs (store, run_id, started_at, cursor, n) values ('amzwatch', 'returns', now(), null, 0) on conflict (store) do nothing`;
      const [run] = await sql`select cursor, n from audit.runs where store = 'amzwatch'`;
      let reportId = run?.cursor || "";
      if (!reportId) {
        const c = await (await fetch(`${AMZ}/reports/2021-06-30/reports`, { method: "POST", headers: H, body: JSON.stringify({ reportType: "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE", marketplaceIds: [MKT], dataStartTime: since30 }) })).json();
        if (!c.reportId) throw new Error("returns report: " + JSON.stringify(c).slice(0, 160));
        reportId = c.reportId;
      }
      let st: any = null;
      for (let i = 0; i < 24; i++) { st = await get(`${AMZ}/reports/2021-06-30/reports/${reportId}`); if (/DONE|CANCELLED|FATAL/.test(st.processingStatus)) break; await sleep(5000); }
      if (/IN_QUEUE|IN_PROGRESS/.test(st?.processingStatus || "")) {
        const miss = Number(run?.n || 0) + 1;
        await sql`update audit.runs set cursor = ${reportId}, n = ${miss} where store = 'amzwatch'`;
        if (miss >= 3) out.errors.push(`Amazon's returns report has been slow ${miss} runs in a row`);
      } else await sql`update audit.runs set cursor = null, n = 0, finished_at = now() where store = 'amzwatch'`;
      if (st?.processingStatus === "DONE") {
        const d = await get(`${AMZ}/reports/2021-06-30/documents/${st.reportDocumentId}`);
        const raw = new Uint8Array(await (await fetch(d.url)).arrayBuffer());
        const txt = d.compressionAlgorithm === "GZIP" ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).text() : new TextDecoder().decode(raw);
        const lines = txt.split(/\r?\n/).filter(Boolean);
        const hd = (lines.shift() || "").split("\t");
        const col = (row: string[], name: string) => (row[hd.indexOf(name)] || "").trim();
        for (const ln of lines) {
          const r = ln.split("\t"), order = col(r, "Order ID"), rma = col(r, "Amazon RMA ID") || col(r, "Return request date");
          const code = col(r, "Return Reason"), status = col(r, "Return request status"), sku = col(r, "Merchant SKU").toUpperCase();
          const pd = /^PD-/.test(sku) ? sku : null, why = REASON[code] || code || "no reason given";
          const label = col(r, "Label cost") ? `$${col(r, "Label cost")} return label paid by ${col(r, "Label to be paid by") || "?"}` : "";
          const pending = /pending/i.test(status);
          out.returns++;
          await post(`${pending ? "⚠️ ANSWER NEEDED - " : ""}Return request: ${sku || order} - "${why}"`,
            `${col(r, "Item Name").slice(0, 90)} · order ${order} (ordered ${col(r, "Order date")}) · return asked ${col(r, "Return request date")} · status: ${status}` +
            `${label ? " · " + label : ""}${col(r, "A-to-Z Claim") === "Y" ? " · A-to-z CLAIM" : ""}${col(r, "Refunded Amount") ? " · refunded $" + col(r, "Refunded Amount") : ""}.` +
            (pending ? " Amazon wants an answer within 2 business days - open Seller Central > Orders > Manage Returns." : "") +
            (SAFE_T.test(code) ? " When it comes back: photograph the package before opening and the book after - if it isn't what the buyer said, a SAFE-T claim can get your money back." : ""),
            pd, pending ? "issue" : "question", `amzret:${order}:${rma}:${pending ? "p" : "a"}`);
        }
      } else if (/CANCELLED|FATAL/.test(st?.processingStatus || "") && st?.processingStatus !== "CANCELLED") out.errors.push("returns report " + st.processingStatus);
    } catch (e) { out.errors.push(String((e as Error).message || e).slice(0, 200)); }

    // 2) buyer cancel requests on unshipped orders
    try {
      const o = await get(`${AMZ}/orders/v0/orders?MarketplaceIds=${MKT}&OrderStatuses=Unshipped,PartiallyShipped&CreatedAfter=${since30}`);
      for (const ord of o.payload?.Orders || []) {
        const it = await get(`${AMZ}/orders/v0/orders/${ord.AmazonOrderId}/orderItems`);
        for (const x of it.payload?.OrderItems || []) {
          const bc = x.BuyerRequestedCancel || {};
          if (String(bc.IsBuyerRequestedCancel) !== "true") continue;
          out.cancels++;
          const sku = String(x.SellerSKU || "").toUpperCase();
          await post(`⚠️ Buyer asked to CANCEL: ${sku} - don't ship it`, `${String(x.Title || "").slice(0, 90)} · order ${ord.AmazonOrderId} · reason: ${bc.BuyerCancelReason || "none given"}. Cancel it in Seller Central > Orders > Manage Orders (choose "Buyer canceled") so it isn't held against you.`,
            /^PD-/.test(sku) ? sku : null, "issue", `amzcancel:${ord.AmazonOrderId}:${x.OrderItemId}`);
        }
        await sleep(1200);
      }
    } catch (e) { out.errors.push("cancels: " + String((e as Error).message || e).slice(0, 200)); }

    // 3) refunds posted to the account (covers refunds with no return request)
    try {
      const f = await get(`${AMZ}/finances/v0/financialEvents?PostedAfter=${new Date(Date.now() - 7 * 864e5).toISOString()}&MaxResultsPerPage=100`);
      for (const ev of f.payload?.FinancialEvents?.RefundEventList || []) {
        for (const it of ev.ShipmentItemAdjustmentList || []) {
          const sku = String(it.SellerSKU || "").toUpperCase();
          const amt = (it.ItemChargeAdjustmentList || []).reduce((t: number, c: any) => t + Number(c.ChargeAmount?.CurrencyAmount || 0), 0);
          out.refunds++;
          await post(`Refund issued on Amazon: ${sku || ev.AmazonOrderId}`, `Order ${ev.AmazonOrderId} · refunded $${Math.abs(amt).toFixed(2)} on ${String(ev.PostedDate || "").slice(0, 10)}. If there is no return request for this order, the buyer was refunded without sending it back.`,
            /^PD-/.test(sku) ? sku : null, "question", `amzrefund:${ev.AmazonOrderId}:${sku}`);
        }
      }
    } catch (e) { out.errors.push("refunds: " + String((e as Error).message || e).slice(0, 200)); }

    if (out.errors.length) await sql`select pipeline.alert_add('Amazon', 'Amazon watch had trouble', ${out.errors.join(" | ")}, null, null, 'issue', ${"amzwatch-err:" + new Date().toISOString().slice(0, 10)})`;
    return json({ ok: !out.errors.length, ...out });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
