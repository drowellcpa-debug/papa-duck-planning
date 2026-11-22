// Papa Duck - Edge Function "title-clean" v1 (2026-11-22). Papa Duck: "I want it not to say anything about batch of X or set unless I indicate
// Set in our book station" -> "yes" (check the live store titles of the 31 old books and fix any that mention a quantity).
// POST {"pd":"PD-0009","job":id?,"dry":true?} -> reads the LIVE titles on eBay, Etsy and AbeBooks, runs them through pipeline.strip_batch_words(t, keep_sets=true)
// (Qty N / BATCH LOT / batch of N / N copies go; real "Set of N" wording on old set listings stays) and sends back only the ones that changed.
// Auth: x-backup-secret = backup.config cron_secret. Uses the store lock 7342001 (Etsy token rotation), like qty-set.
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "appdMXzb9U4sdXpAr", T_INV = "tblKxgB4q7v9SPqze", ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu";
const F_TRACK = "fldxiwKYi6z1t0iDx", F_EBAY = "fldKGZyyXy0Gjox5b", F_ETSY = "fld3GGIsBv0tXqjFL";
const arr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();
const J = (b: string) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
// same page read as abe-qty: the AbeBooks listing details live in the page's Next.js flight data
async function abeTitle(lid: string): Promise<string> {
  const html = await (await fetch(`https://www.abebooks.com/servlet/BookDetailsPL?bi=${lid}`, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(30000) })).text();
  let flight = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) { try { flight += JSON.parse(m[1]); } catch { /* skip */ } }
  const at = flight.indexOf(`"listing":{"listingId":${lid}`);
  if (at < 0) return "";
  let i = flight.indexOf("{", at + 9), d = 0, inStr = false, j = i;
  for (; j < flight.length; j++) {
    const c = flight[j];
    if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") d++; else if (c === "}") { d--; if (d === 0) break; }
  }
  try { return String(JSON.parse(flight.slice(i, j + 1)).title || ""); } catch { return ""; }
}
async function call(url: string, init: any = {}, tries = 3): Promise<{ status: number; body: string }> {
  for (let a = 0; ; a++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
    const body = await r.text();
    if ((r.status === 429 || r.status >= 500) && a < tries - 1) { await sleep(2000 * (a + 1)); continue; }
    return { status: r.status, body };
  }
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  let locked = false, job = 0;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const pd = String(b.pd || "").toUpperCase(), dry = !!b.dry; job = Math.floor(Number(b.job || 0));
    if (!/^PD-\d{4}[A-Z]?$/.test(pd)) return json({ ok: false, error: "need pd" }, 400);
    const clean = async (t: string) => String((await sql`select pipeline.strip_batch_words(${t}, true) as c`)[0]?.c || t);
    for (let a = 0; a < 20 && !locked; a++) { locked = (await sql`select pg_try_advisory_lock(7342001) as ok`)[0].ok; if (!locked) await sleep(3000); }
    if (!locked) throw new Error("the store worker is busy - try again in a minute");
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const K = JSON.parse(vr[0].decrypted_secret);
    const ids = await sql`select distinct on (j.channel) j.channel, i.listing_id from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id
      where i.pd = ${pd} and i.state = 'done' and i.listing_id is not null and j.test = false order by j.channel, i.id desc`;
    const f = await call(`https://api.airtable.com/v0/${BASE}/${T_INV}?returnFieldsByFieldId=true&maxRecords=1&filterByFormula=` + encodeURIComponent(`{${F_TRACK}}='${pd}'`),
      { headers: { Authorization: "Bearer " + K.airtable.token } }, 4);
    const rec = (J(f.body).records || [])[0];
    const atId: Record<string, string> = { ebay: String(rec?.fields?.[F_EBAY] || "").replace(/\D/g, ""), etsy: String(rec?.fields?.[F_ETSY] || "").replace(/\D/g, "") };
    const id = (ch: string) => (ids.find((r: any) => r.channel === ch) || {}).listing_id || atId[ch] || "";
    const out: any = { pd, dry };

    // eBay
    const eid = id("ebay");
    if (eid) {
      try {
        const e = K.ebay, x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const hdr = (n: string) => ({ "X-EBAY-API-CALL-NAME": n, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
          "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" });
        const g = await call("https://api.ebay.com/ws/api.dll", { method: "POST", headers: hdr("GetItem"),
          body: `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${x(e.auth_token)}</eBayAuthToken></RequesterCredentials><ItemID>${eid}</ItemID></GetItemRequest>` });
        const it = (parser.parse(g.body).GetItemResponse || {}).Item || {};
        const was = txt(it.Title), status = txt(it.SellingStatus?.ListingStatus);
        if (!was) out.ebay = "could not read the title";
        else if (status && status !== "Active") out.ebay = `not live (${status})`;
        else {
          const now = await clean(was);
          if (now === was) out.ebay = "ok as is";
          else if (dry) out.ebay = `would change: "${was}" -> "${now}"`;
          else {
            const r = await call("https://api.ebay.com/ws/api.dll", { method: "POST", headers: hdr("ReviseFixedPriceItem"),
              body: `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${x(e.auth_token)}</eBayAuthToken></RequesterCredentials><Item><ItemID>${eid}</ItemID><Title>${x(now)}</Title></Item></ReviseFixedPriceItemRequest>` });
            const xr = parser.parse(r.body).ReviseFixedPriceItemResponse || {}, ack = txt(xr.Ack);
            out.ebay = ack === "Success" || ack === "Warning" ? `fixed: "${was}" -> "${now}"` : "error: " + arr(xr.Errors).map((z: any) => `${txt(z.ErrorCode)} ${txt(z.LongMessage)}`).join("; ").slice(0, 200);
          }
        }
      } catch (e) { out.ebay = "error: " + String((e as Error).message).slice(0, 200); }
    } else out.ebay = "not listed";

    // Etsy
    const tid = id("etsy");
    if (tid) {
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
        const g = await call(`https://openapi.etsy.com/v3/application/listings/${tid}`, { headers: h });
        const L = J(g.body), was = String(L.title || "").trim();
        if (g.status >= 300 || !was) out.etsy = `could not read (${g.status})`;
        else if (L.state && L.state !== "active") out.etsy = `not live (${L.state})`;
        else {
          const now = await clean(was);
          if (now === was) out.etsy = "ok as is";
          else if (dry) out.etsy = `would change: "${was}" -> "${now}"`;
          else {
            const p = await call(`https://openapi.etsy.com/v3/application/shops/65331509/listings/${tid}`, { method: "PATCH",
              headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ title: now }).toString() });
            out.etsy = p.status < 300 ? `fixed: "${was}" -> "${now}"` : `error ${p.status}: ${p.body.slice(0, 200)}`;
          }
        }
      } catch (e) { out.etsy = "error: " + String((e as Error).message).slice(0, 200); }
    } else out.etsy = "not listed";

    // AbeBooks (abe-qty reads the live listing; a dry call tells us the title)
    try {
      const ab = async (body: any) => J((await call("https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/abe-qty", { method: "POST",
        headers: { "Content-Type": "application/json", "x-backup-secret": cfg.value }, body: JSON.stringify(body) }, 1)).body);
      const d = await ab({ pd, dry: true });   // finds the listing number (lid) in his store
      if (d.not_on_abe) out.abe = "not listed";
      else if (!d.lid) out.abe = "error: " + String(d.error || "could not find the listing").slice(0, 160);
      else {
        const was = await abeTitle(String(d.lid)), now = was ? await clean(was) : "";
        if (!was) out.abe = "error: could not read the AbeBooks title";
        else if (now === was) out.abe = "ok as is";
        else if (dry) out.abe = `would change: "${was}" -> "${now}"`;
        else { const r = await ab({ pd, lid: d.lid, title: now, wait: 5000 }); out.abe = r.ok ? `fixed: "${was}" -> "${now}"` : "error: " + String(r.error || r.res || "").slice(0, 160); }
      }
    } catch (e) { out.abe = "error: " + String((e as Error).message).slice(0, 160); }

    out.ok = !/error/.test(JSON.stringify([out.ebay, out.etsy, out.abe]));
    if (job) await sql`update pipeline.qty_adds set status = ${out.ok ? "done" : "problem"}, result = ${sql.json(out)}, done_at = now() where id = ${job}`;
    return json(out);
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300);
    if (job) await sql`update pipeline.qty_adds set status = 'problem', result = ${sql.json({ ok: false, error: msg })}, done_at = now() where id = ${job}`.catch(() => {});
    return json({ ok: false, error: msg }, 500);
  } finally {
    if (locked) await sql`select pg_advisory_unlock(7342001)`.catch(() => {});
    await sql.end({ timeout: 3 });
  }
});
