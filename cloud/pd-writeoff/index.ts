// Papa Duck — Edge Function "pd-writeoff" v2 (2026-11-04; v2 = optional {shelf, title} - used to close out old eBay sales from before Oct 7) v1 (2026-11-03). Papa Duck: "can not find the 2437 or 0054 ... take them off everywhere consider them sold".
// For each PD: eBay ended (EndItem + read back), AbeBooks deleted, Etsy inactive (+ read back), Amazon offer removed,
// Airtable Status "Sold", Quantity 0, Shelf "Missing - written off". Same calls as shelf-clear. Logs to pipeline.alerts (handled).
// POST {"pds":["PD-0054"], "why":"..."}. Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "appdMXzb9U4sdXpAr", T_INV = "tblKxgB4q7v9SPqze", ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", ETSY_SHOP = "65331509";
const AMZ = "https://sellingpartnerapi-na.amazon.com", MKT = "ATVPDKIKX0DER";
const F = { TRACK: "fldxiwKYi6z1t0iDx", ITEMID: "fldKGZyyXy0Gjox5b", ETSY: "fld3GGIsBv0tXqjFL", STATUS: "fldK5pTHj5iCEmf0w", QTY: "fld7MrQXX1D8iD0ap", SHELF: "flduz8HOLS4UHMbQ1" };
const arr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();
const J = (b: string) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
const findAll = (o: any, key: string, out: any[] = []): any[] => {
  if (!o || typeof o !== "object") return out;
  for (const [k, v] of Object.entries(o)) { if (k === key) out.push(...arr(v)); else if (v && typeof v === "object") arr(v).forEach((c: any) => findAll(c, key, out)); }
  return out;
};
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
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const pds: string[] = (b.pds || []).map((x: string) => String(x).toUpperCase()).filter((x: string) => /^PD-\w+$/.test(x));
    if (!pds.length) return json({ ok: false, error: "send pds" }, 400);
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const K = JSON.parse(vr[0].decrypted_secret);
    const saveEtsy = async () => { const cur = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
      cur.etsy = K.etsy; await sql`select vault.update_secret(${vr[0].id}::uuid, ${JSON.stringify(cur)})`; };
    const at = async (method: string, qs = "", body?: unknown) => {
      const r = await call(`https://api.airtable.com/v0/${BASE}/${T_INV}${qs ? "?" + qs : ""}`, { method, headers: { Authorization: "Bearer " + K.airtable.token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined }, 4);
      if (r.status >= 300) throw new Error(`Airtable ${r.status}: ${r.body.slice(0, 160)}`);
      return J(r.body);
    };
    const ebay = async (name: string, inner: string) => {
      const e = K.ebay, esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const r = await call("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${esc(e.auth_token)}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` });
      const x = parser.parse(r.body)[name + "Response"] || {}, ack = txt(x.Ack);
      if (ack !== "Success" && ack !== "Warning") throw new Error(`eBay ${name}: ${arr(x.Errors).map((z: any) => `${txt(z.ErrorCode)} ${txt(z.LongMessage)}`).join("; ") || ack || "http " + r.status}`.slice(0, 240));
      return x;
    };
    const ebayStatus = async (id: string) => txt((await ebay("GetItem", `<ItemID>${id}</ItemID><DetailLevel>ReturnSummary</DetailLevel>`)).Item?.SellingStatus?.ListingStatus);
    const abeDelete = async (pd: string) => {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<inventoryUpdateRequest version="1.0">\n<action name="bookupdate">\n  <username>${esc(K.abe.username)}</username>\n  <password>${esc(K.abe.password)}</password>\n</action>\n<AbebookList>\n  <Abebook>\n    <transactionType>DELETE</transactionType>\n    <vendorBookID>${pd}</vendorBookID>\n  </Abebook>\n</AbebookList>\n</inventoryUpdateRequest>\n`;
      const r = await call("https://inventoryupdate.abebooks.com:10027", { method: "POST", body, headers: { "Content-Type": "text/xml; charset=utf-8" } });
      const x = parser.parse(r.body), bk = findAll(x, "Abebook")[0] || {};
      const code = txt(bk.code) || txt(findAll(x, "code")[0]), msg = txt(bk.message) || txt(findAll(x, "message")[0]);
      if (code === "600") return "deleted";
      if (/not\s*(be\s*)?found|does not exist|no such|not in your inventory/i.test(msg)) return "not on AbeBooks";
      throw new Error(`AbeBooks code ${code || "?"} ${msg || r.body.slice(0, 100)}`);
    };
    const etsyTok = async () => {
      const e = K.etsy;
      if (e.access_token && (e.expires_at || 0) > Date.now() + 5 * 60e3) return e.access_token;
      const r = await call("https://api.etsy.com/v3/public/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", client_id: ETSY_CLIENT, refresh_token: e.refresh_token }) });
      const j = J(r.body);
      if (!j.access_token || !j.refresh_token) throw new Error(`Etsy token refresh failed (${r.status})`);
      e.access_token = j.access_token; e.refresh_token = j.refresh_token; e.expires_at = Date.now() + Number(j.expires_in || 3600) * 1000;
      await saveEtsy();
      return e.access_token;
    };
    const etsy = async (method: string, path: string, form?: Record<string, string>) => {
      const tok = await etsyTok();
      const h: Record<string, string> = { "x-api-key": `${ETSY_CLIENT}:${K.etsy.shared_secret}`, Authorization: "Bearer " + tok, Accept: "application/json" };
      if (form) h["Content-Type"] = "application/x-www-form-urlencoded";
      const r = await call("https://openapi.etsy.com/v3/application" + path, { method, headers: h, body: form ? new URLSearchParams(form).toString() : undefined });
      if (r.status >= 300) throw new Error(`Etsy ${r.status} ${r.body.slice(0, 160)}`);
      return J(r.body);
    };
    let amzTok = "";
    const amz = async (method: string, path: string, params: Record<string, string>) => {
      if (!amzTok) amzTok = J((await call("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: K.amazon.refresh_token, client_id: K.amazon.client_id, client_secret: K.amazon.client_secret }).toString() })).body).access_token;
      const r = await call(AMZ + path + "?" + new URLSearchParams(params), { method, headers: { "x-amz-access-token": amzTok, Accept: "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" } }, 5);
      return { status: r.status, j: J(r.body), raw: r.body };
    };

    const shelf = String(b.shelf || "Missing - written off").slice(0, 80);
    const out: any[] = [];
    for (const pd of pds) {
      const log: Record<string, string> = {};
      let bad = false;
      const step = async (name: string, f: () => Promise<string>) => { try { log[name] = await f(); } catch (e) { bad = true; log[name] = "FAILED " + String((e as Error).message).slice(0, 160); } };
      const recs = (await at("GET", new URLSearchParams([["filterByFormula", `{Tracking Number}='${pd}'`], ["returnFieldsByFieldId", "true"],
        ["fields[]", F.TRACK], ["fields[]", F.ITEMID], ["fields[]", F.ETSY], ["fields[]", F.STATUS]]).toString())).records || [];
      const f = recs[0]?.fields || {};
      const itemid = String(f[F.ITEMID] || "").replace(/\D/g, ""), lid = String(f[F.ETSY] || "").replace(/\D/g, "");
      await step("ebay", async () => {
        if (!itemid) return "none (no eBay item #)";
        const s0 = await ebayStatus(itemid);
        if (s0 !== "Active") return `already off eBay (${s0 || "?"})`;
        await ebay("EndItem", `<ItemID>${itemid}</ItemID><EndingReason>NotAvailable</EndingReason>`);
        const s1 = await ebayStatus(itemid);
        if (s1 === "Active") throw new Error("still active after ending");
        return `ended (${s1})`;
      });
      await step("abe", () => abeDelete(pd));
      await step("etsy", async () => {
        if (!lid) return "none (not on Etsy)";
        const cur = await etsy("GET", `/listings/${lid}`);
        if (cur.state !== "active") return `already off Etsy (${cur.state})`;
        await etsy("PATCH", `/shops/${ETSY_SHOP}/listings/${lid}`, { state: "inactive" });
        const back = await etsy("GET", `/listings/${lid}`);
        if (back.state === "active") throw new Error("still active");
        return `off Etsy (${back.state})`;
      });
      await step("amazon", async () => {
        const path = `/listings/2021-08-01/items/${K.amazon.seller_id}/${encodeURIComponent(pd)}`;
        const g = await amz("GET", path, { marketplaceIds: MKT });
        if (g.status === 404) return "none (not on Amazon)";
        const d = await amz("DELETE", path, { marketplaceIds: MKT });
        if (d.j.status !== "ACCEPTED") throw new Error("offer not removed: " + d.raw.slice(0, 120));
        return "removed";
      });
      await step("airtable", async () => {
        if (!recs[0]) return "none (not in Inventory)";
        await at("PATCH", "", { typecast: true, records: [{ id: recs[0].id, fields: { [F.STATUS]: "Sold", [F.QTY]: 0, [F.SHELF]: shelf } }] });
        return `updated: Sold, quantity 0, shelf '${shelf}'`;
      });
      if (!b.quiet) await sql`select pipeline.alert_add('Inventory', ${`${pd} ${b.title || "taken off every store - counted as sold"}`}, ${(b.why || "Papa Duck could not find it.") + " " + Object.entries(log).map(([k, v]) => `${k}: ${v}`).join(" · ")},
        ${pd}, null, ${bad ? "issue" : "handled"}, ${"writeoff:" + pd})`;
      out.push({ pd, ok: !bad, log });
    }
    return json({ ok: out.every((o) => o.ok), out });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
