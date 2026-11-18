// Papa Duck - Edge Function "health-check" v1 (2026-11-18). The morning System Health check for the Launch Pad.
// Papa Duck: "Should we have a daily system review every morning that has a gauge for every app and big system supabase ... airtable
//   that let's me know ok or need to adjust" / "I do want it on launch pad". Built after the 11/18 5:41 AM database freeze.
// Runs every morning (cron pd-health-check, 6:03 AM Pacific) and from the Launch Pad's "Check now" button (pipeline.health_kick()).
// Database gauges come from pipeline.health_db(); this adds the outside checks, then pipeline.health_save() stores the run
// (any red gauge becomes a Launch Pad to-do). READ-ONLY toward every store: nothing is listed, changed or refreshed.
//   eBay      GetTokenStatus (the seller token works and when it expires)
//   Etsy      the access token was refreshed recently by the normal jobs (never refreshed here - the Etsy token rotates) + shop read
//   Amazon    a login token from the refresh token (does not rotate)
//   AbeBooks  his store search answers and shows PD listings
//   Airtable  the API answers with the Inventory table
//   Pages     launchpad / station / drafts pages on Netlify answer; drafts-api and duck-hunter answer with the passcode
// Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";
const xmlp = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const SB = "https://gdwxwiwckxthwcsrgywh.supabase.co", SITE = "https://papa-duck-planning.netlify.app";
const ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", SHOP = "65331509", VCI = "91371820";
const BASE = "appdMXzb9U4sdXpAr", T_INV = "tblKxgB4q7v9SPqze";
type G = { key: string; name: string; icon: string; status: "green" | "yellow" | "red"; value: string; fix: string };
const gauge = (key: string, name: string, icon: string, status: G["status"], value: string, fix = ""): G => ({ key, name, icon, status, value, fix });
const t = (ms = 20000) => AbortSignal.timeout(ms);
const daysTo = (d: Date) => Math.round((d.getTime() - Date.now()) / 86400e3);

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false });
  const t0 = Date.now();
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (!cfg || req.headers.get("x-backup-secret") !== cfg.value) return json({ error: "not allowed" }, 403);
    const K = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
    const [pc] = await sql`select value from pipeline.config where key = 'station_passcode'`;
    const pass = String(pc?.value || "");

    const checks: Promise<G>[] = [
      // ---- eBay ----
      (async () => {
        try {
          const e = K.ebay;
          const body = `<?xml version="1.0" encoding="utf-8"?><GetTokenStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${e.auth_token}</eBayAuthToken></RequesterCredentials></GetTokenStatusRequest>`;
          const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", body, signal: t(), headers: { "X-EBAY-API-CALL-NAME": "GetTokenStatus", "X-EBAY-API-SITEID": "0",
            "X-EBAY-API-COMPATIBILITY-LEVEL": "1193", "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" } });
          const x = xmlp.parse(await r.text()).GetTokenStatusResponse || {};
          const ts = x.TokenStatus || {}; const status = String(ts.Status || ""), exp = ts.ExpirationTime ? new Date(String(ts.ExpirationTime)) : null;
          if (String(x.Ack) !== "Success" || status !== "Active") return gauge("ebay", "eBay", "🛒", "red", "eBay says the seller token is " + (status || "not working"), "Your eBay connection needs to be renewed - tell Claude.");
          const d = exp ? daysTo(exp) : 999;
          return gauge("ebay", "eBay", "🛒", d > 30 ? "green" : d > 7 ? "yellow" : "red", "Connected" + (exp ? " · token good for " + d + " days" : ""),
            d > 30 ? "" : "The eBay token expires soon - tell Claude so it can be renewed before it stops.");
        } catch (er) { return gauge("ebay", "eBay", "🛒", "yellow", "eBay didn't answer (" + String((er as Error).message).slice(0, 60) + ")", "Usually a short eBay hiccup - Check now again later."); }
      })(),
      // ---- Etsy (read only - never refresh the rotating token here) ----
      (async () => {
        try {
          const e = K.etsy; const exp = Number(e.expires_at || 0), staleH = exp ? (Date.now() - exp) / 3600e3 : 999;
          if (exp > Date.now() + 60e3) {
            const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${SHOP}`, { signal: t(), headers: { "x-api-key": `${ETSY_CLIENT}:${e.shared_secret}`, Authorization: "Bearer " + e.access_token } });
            if (r.ok) { const j = await r.json(); return gauge("etsy", "Etsy", "🧶", "green", "Connected · " + (j.listing_active_count ?? "?") + " active listings"); }
            return gauge("etsy", "Etsy", "🧶", "red", "Etsy refused the connection (" + r.status + ")", "Your Etsy connection needs to be renewed - tell Claude.");
          }
          // the access token lasts 1 hour and the sales job refreshes it when it needs it - a little old is normal
          return gauge("etsy", "Etsy", "🧶", staleH < 6 ? "green" : staleH < 30 ? "yellow" : "red", staleH < 6 ? "Connected (refreshed " + Math.max(1, Math.round(staleH * 60)) + " min ago)" : "Not refreshed for " + Math.round(staleH) + " h",
            staleH < 6 ? "" : "The Etsy connection hasn't refreshed - tell Claude to check the Etsy sales job.");
        } catch (er) { return gauge("etsy", "Etsy", "🧶", "yellow", "Etsy didn't answer (" + String((er as Error).message).slice(0, 60) + ")", "Usually a short Etsy hiccup - Check now again later."); }
      })(),
      // ---- Amazon ----
      (async () => {
        try {
          const A = K.amazon;
          const r = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", signal: t(), headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString() });
          const j = await r.json().catch(() => ({}));
          return j.access_token ? gauge("amazon", "Amazon", "📦", "green", "Connected")
            : gauge("amazon", "Amazon", "📦", "red", "Amazon refused the login (" + r.status + ")", "Your Amazon connection needs to be renewed in Seller Central - tell Claude.");
        } catch (er) { return gauge("amazon", "Amazon", "📦", "yellow", "Amazon didn't answer (" + String((er as Error).message).slice(0, 60) + ")", "Usually a short Amazon hiccup - Check now again later."); }
      })(),
      // ---- AbeBooks (his store search) ----
      (async () => {
        try {
          const r = await fetch(`https://www.abebooks.com/servlet/SearchResults?vci=${VCI}`, { signal: t(25000),
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" } });
          const h = await r.text();
          const m = h.match(/\((over\s+)?([\d,]+)\s+results?\)/i);   // "(Over 2,300 results)"
          const n = m ? Number(m[2].replace(/,/g, "")) : null, over = !!(m && m[1]);
          if (!r.ok) return gauge("abe", "AbeBooks", "📚", "yellow", "AbeBooks answered " + r.status, "Try Check now later; if it stays yellow, tell Claude.");
          return gauge("abe", "AbeBooks", "📚", n && n > 0 ? "green" : "yellow", n ? "Store is up · " + (over ? "over " : "") + n.toLocaleString() + " listings" : "Store answered but no listings were counted",
            n && n > 0 ? "" : "AbeBooks may have changed its page - tell Claude.");
        } catch (er) { return gauge("abe", "AbeBooks", "📚", "yellow", "AbeBooks didn't answer (" + String((er as Error).message).slice(0, 60) + ")", "Usually a short AbeBooks hiccup - Check now again later."); }
      })(),
      // ---- Airtable ----
      (async () => {
        try {
          const r = await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}?maxRecords=1&fields%5B%5D=Tracking%20Number`, { signal: t(), headers: { Authorization: "Bearer " + K.airtable.token } });
          return r.ok ? gauge("airtable", "Airtable", "📋", "green", "Connected")
            : gauge("airtable", "Airtable", "📋", r.status === 429 ? "yellow" : "red", "Airtable answered " + r.status, r.status === 401 || r.status === 403 ? "The Airtable key stopped working - tell Claude." : "Tell Claude if it stays this way.");
        } catch (er) { return gauge("airtable", "Airtable", "📋", "yellow", "Airtable didn't answer (" + String((er as Error).message).slice(0, 60) + ")", "Usually a short hiccup - Check now again later."); }
      })(),
      // ---- your pages + their back ends ----
      (async () => {
        const bad: string[] = []; let ok = 0;
        const page = async (name: string, path: string) => { try { const r = await fetch(SITE + path, { signal: t() }); await r.body?.cancel(); r.ok ? ok++ : bad.push(name + " " + r.status); } catch { bad.push(name + " no answer"); } };
        const api = async (name: string, fn: string, body: unknown) => {
          try { const r = await fetch(`${SB}/functions/v1/${fn}`, { method: "POST", signal: t(), headers: { "Content-Type": "application/json", "x-station-pass": pass }, body: JSON.stringify(body) });
            const j = await r.json().catch(() => ({})); (r.ok && j.ok) ? ok++ : bad.push(name + " " + r.status); } catch { bad.push(name + " no answer"); }
        };
        await Promise.all([page("Launch Pad page", "/launchpad.html"), page("Book Station page", "/station.html"), page("Drafts page", "/drafts.html"),
          api("Launch Pad/Drafts cloud", "drafts-api", { q: "select pipeline.todos_open() as t" }), api("Duck Hunter", "duck-hunter", { action: "ping" })]);
        return gauge("pages", "Your apps", "📱", bad.length === 0 ? "green" : bad.length === 1 ? "yellow" : "red",
          bad.length ? "Not answering: " + bad.join(", ") : "Launch Pad, Book Station, Drafts and Duck Hunter all answer", bad.length ? "Tell Claude which app isn't opening." : "");
      })(),
    ];
    const [dbg] = await sql`select pipeline.health_db() as g`;
    const outside = await Promise.all(checks);
    const all = [...(dbg.g || []), ...outside];
    const [saved] = await sql`select pipeline.health_save(${sql.json(all)}, ${Date.now() - t0}) as r`;
    return json({ ok: true, ms: Date.now() - t0, saved: saved.r, gauges: all });
  } catch (e) {
    try { await sql`select pipeline.health_save(${sql.json([gauge("check", "Health check", "🩺", "red", "The health check itself failed: " + String((e as Error)?.message || e).slice(0, 150), "Tell Claude.")])}, ${Date.now() - t0})`; } catch (_) { /* nothing more to do */ }
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
