// Papa Duck - Edge Function "listing-text-push" v1 (2026-11-02). Papa Duck: "fix this now, this should never happen" (PD-0249 went live as
// "Set of 5" while each sale is ONE plate). Replaces the words on a LIVE listing everywhere at once:
//   eBay  - ReviseFixedPriceItem: Title, Description (Block 2 HTML), ConditionDescription (Block 1); GetItem read-back.
//   Etsy  - PATCH listing: title + plain-text description made from Block 2; GET read-back.
//   Draft - pricing.ebay_title / b1 / b2 updated so the record matches what is live.
// POST {"pd":"PD-0249","title":"...","b1":"...","b2":"<div>...","etsy_title":"optional"}. Auth: x-backup-secret = backup.config cron_secret.
// Uses the store lock (7342001) like qty-set so it never collides with the Etsy token rotation.
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", SHOP = "65331509";
const arr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();
const xesc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const J = (b: string) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
async function call(url: string, init: any = {}, tries = 3) {
  for (let a = 0; ; a++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) });
    const body = await r.text();
    if ((r.status === 429 || r.status >= 500) && a < tries - 1) { await sleep(2000 * (a + 1)); continue; }
    return { status: r.status, body };
  }
}
// Block 2 HTML -> Etsy plain text (headings and list lines on their own lines)
function plain(html: string): string {
  const ent = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const t = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(h[1-6]|p|div)>/gi, "\n\n").replace(/<li[^>]*>/gi, "").replace(/<\/li>/gi, "\n")
    .replace(/<\/ul>/gi, "\n").replace(/<[^>]+>/g, "");
  return ent(t).split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  let locked = false;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const pd = String(b.pd || "").toUpperCase(), title = String(b.title || "").trim(), b1 = String(b.b1 || "").trim(), b2 = String(b.b2 || "").trim();
    if (!/^PD-\d{4}[A-Z]?$/.test(pd) || !title || title.length > 80 || !b1 || b2.length < 300) return json({ error: "need pd, title (<=80), b1, b2" }, 400);
    for (let a = 0; a < 20 && !locked; a++) { locked = (await sql`select pg_try_advisory_lock(7342001) as ok`)[0].ok; if (!locked) await sleep(3000); }
    if (!locked) return json({ ok: false, error: "the store worker is busy - try again in a minute" }, 409);
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const K = JSON.parse(vr[0].decrypted_secret);
    const ids = await sql`select distinct on (j.channel) j.channel, i.listing_id from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id
      where i.pd = ${pd} and i.state = 'done' and i.listing_id is not null and j.test = false order by j.channel, i.id desc`;
    const id = (ch: string) => (ids.find((r: any) => r.channel === ch) || {}).listing_id;
    const out: any = { pd };
    // eBay
    const ebayId = id("ebay");
    if (ebayId) {
      const e = K.ebay;
      const trading = async (name: string, inner: string) => {
        const r = await call("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
          "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
          body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xesc(e.auth_token)}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` });
        return parser.parse(r.body)[name + "Response"] || {};
      };
      try {
        const x = await trading("ReviseFixedPriceItem", `<Item><ItemID>${ebayId}</ItemID><Title>${xesc(title)}</Title><Description><![CDATA[${b2.replace(/]]>/g, "]]&gt;")}]]></Description><ConditionDescription>${xesc(b1.slice(0, 1000))}</ConditionDescription></Item>`);
        const ack = txt(x.Ack);
        if (ack === "Success" || ack === "Warning") {
          const g = await trading("GetItem", `<ItemID>${ebayId}</ItemID><DetailLevel>ReturnAll</DetailLevel>`);
          const it = g.Item || {};
          out.ebay = { item: ebayId, title_live: txt(it.Title), title_ok: txt(it.Title) === title, cond_ok: txt(it.ConditionDescription).startsWith(b1.slice(0, 40)),
            desc_has_set_of: /set of/i.test(txt(it.Description)), qty_left: Number(txt(it.Quantity)) - Number(txt(it.SellingStatus?.QuantitySold) || 0) };
        } else out.ebay = "error: " + arr(x.Errors).map((z: any) => `${txt(z.ErrorCode)} ${txt(z.LongMessage)}`).join("; ").slice(0, 300);
      } catch (er) { out.ebay = "error: " + String((er as Error).message).slice(0, 200); }
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
          const cur = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
          cur.etsy = e; await sql`select vault.update_secret(${vr[0].id}::uuid, ${JSON.stringify(cur)})`;
        }
        const h = { "x-api-key": `${ETSY_CLIENT}:${e.shared_secret}`, Authorization: "Bearer " + e.access_token, Accept: "application/json" };
        const et = String(b.etsy_title || title).replace(/[^\p{L}\p{N}\s.,'":()\-\/]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 140);
        const desc = plain(b2);
        const p = await call(`https://openapi.etsy.com/v3/application/shops/${SHOP}/listings/${etsyId}`, { method: "PATCH",
          headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ title: et, description: desc }).toString() });
        if (p.status >= 300) out.etsy = `error ${p.status}: ${p.body.slice(0, 250)}`;
        else {
          const g = J((await call(`https://openapi.etsy.com/v3/application/listings/${etsyId}`, { headers: h })).body);
          out.etsy = { listing: etsyId, title_live: g.title, title_ok: g.title === et, desc_has_set_of: /set of/i.test(String(g.description || "")), qty: g.quantity, state: g.state };
        }
      } catch (er) { out.etsy = "error: " + String((er as Error).message).slice(0, 200); }
    } else out.etsy = "not listed";
    // the draft record
    await sql`update pipeline.drafts set pricing = coalesce(pricing, '{}'::jsonb) || jsonb_build_object('ebay_title', ${title}::text, 'b1', ${b1}::text, 'b2', ${b2}::text, 'text_pushed_at', now())
      where pd = ${pd}`;
    out.ok = !/error/.test(JSON.stringify([out.ebay, out.etsy]));
    return json(out);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally {
    if (locked) await sql`select pg_advisory_unlock(7342001)`.catch(() => {});
    await sql.end({ timeout: 3 });
  }
});
