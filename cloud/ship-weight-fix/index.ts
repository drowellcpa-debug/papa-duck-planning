// Papa Duck - Edge Function "ship-weight-fix" v1 (2026-11-14).
// Papa Duck: Clue game PD-0313 listed at 3 lb (buyer paid $8.10 shipping) cost $22 at 4 lb boxed - "I am losing money on this one",
// "we need to change this asap", "no do this now". Every LIVE non-book item gets its packed shipping weight (pipeline.ship_lb =
// item weight + 1 lb, rounded up): eBay ShippingPackageDetails WeightMajor, Etsy item_weight + the matching Ground Advantage profile.
// POST {"limit":12} (or {"pds":["PD-0313"]}, {"dry":true}). Done items get answers.ship_lb_fixed so a rerun skips them.
// Auth: x-backup-secret = backup.config cron_secret. Uses the store lock 7342001 (same as qty-set / sales-cloud).
import postgres from "npm:postgres@3.4.4";
import { XMLParser } from "npm:fast-xml-parser@4";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", SHOP = "65331509";
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
    const limit = Math.min(25, Math.max(1, Number(b.limit || 12)));
    const pds: string[] = Array.isArray(b.pds) ? b.pds.map((x: any) => String(x).toUpperCase()) : [];
    const rows = await sql`
      select distinct on (d.pd) d.id, d.pd, d.weight_lb, pipeline.ship_lb(d.ident, d.weight_lb) as lb,
        (select i.listing_id from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id where i.pd = d.pd and i.state = 'done' and i.listing_id is not null and j.test = false and j.channel = 'ebay' order by i.id desc limit 1) as ebay_id,
        (select i.listing_id from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id where i.pd = d.pd and i.state = 'done' and i.listing_id is not null and j.test = false and j.channel = 'etsy' order by i.id desc limit 1) as etsy_id
      from pipeline.drafts d
      where (d.ident->>'kind' = 'item' or lower(coalesce(d.ident->>'format','')) = 'other') and d.status = 'sent' and d.built_at is not null
        and not exists (select 1 from pipeline.sales_done s where s.key like '%:' || d.pd)
        and ${pds.length ? sql`d.pd = any(${pds}::text[])` : sql`d.answers->>'ship_lb_fixed' is null`}
      order by d.pd, d.id desc limit ${limit}`;
    const [left] = await sql`select count(*)::int n from pipeline.drafts d where (d.ident->>'kind' = 'item' or lower(coalesce(d.ident->>'format','')) = 'other')
      and d.status = 'sent' and d.built_at is not null and d.answers->>'ship_lb_fixed' is null and not exists (select 1 from pipeline.sales_done s where s.key like '%:' || d.pd)`;
    if (b.dry) return json({ ok: true, dry: true, remaining: left.n, rows });
    if (!rows.length) return json({ ok: true, done: [], remaining: 0 });
    for (let a = 0; a < 20 && !locked; a++) { locked = (await sql`select pg_try_advisory_lock(7342001) as ok`)[0].ok; if (!locked) await sleep(3000); }
    if (!locked) return json({ ok: false, error: "the store worker is busy - try again in a minute" }, 409);
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const K = JSON.parse(vr[0].decrypted_secret);
    const [pc] = await sql`select value from backup.config where key = 'etsy_item_ship_profiles'`;
    const profiles = (JSON.parse(String(pc?.value || "[]")) as any[]).sort((x, y) => Number(x.lb) - Number(y.lb));
    const e = K.ebay, esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const trade = async (name: string, inner: string) => {
      const r = await call("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${esc(e.auth_token)}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` });
      const x = parser.parse(r.body)[name + "Response"] || {}, ack = txt(x.Ack);
      const errs = arr(x.Errors).map((z: any) => `${txt(z.ErrorCode)} ${txt(z.LongMessage)}`).join("; ");
      return ack === "Success" || ack === "Warning" ? "" : "error: " + (errs || r.status).toString().slice(0, 200);
    };
    let etsyH: any = null;
    const etsyHeaders = async () => {
      if (etsyH) return etsyH;
      const t = K.etsy;
      if (!(t.access_token && (t.expires_at || 0) > Date.now() + 5 * 60e3)) {
        const r = await call("https://api.etsy.com/v3/public/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: ETSY_CLIENT, refresh_token: t.refresh_token }) });
        const j = J(r.body);
        if (!j.access_token || !j.refresh_token) throw new Error(`Etsy token refresh failed (${r.status})`);
        t.access_token = j.access_token; t.refresh_token = j.refresh_token; t.expires_at = Date.now() + Number(j.expires_in || 3600) * 1000;
        const cur = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
        cur.etsy = t; await sql`select vault.update_secret(${vr[0].id}::uuid, ${JSON.stringify(cur)})`;
      }
      etsyH = { "x-api-key": `${ETSY_CLIENT}:${t.shared_secret}`, Authorization: "Bearer " + t.access_token, Accept: "application/json" };
      return etsyH;
    };
    const done: any[] = [];
    for (const r of rows as any[]) {
      const lb = Math.max(1, Math.ceil(Number(r.lb) || 1));
      const out: any = { pd: r.pd, was_lb: Number(r.weight_lb), ship_lb: lb };
      if (r.ebay_id) {
        try {
          const er = await trade("ReviseFixedPriceItem", `<Item><ItemID>${r.ebay_id}</ItemID><ShippingPackageDetails><WeightMajor unit="lbs">${lb}</WeightMajor><WeightMinor unit="oz">0</WeightMinor></ShippingPackageDetails></Item>`);
          out.ebay = er || "ok";
          if (/1047|ended|not.*active|closed/i.test(er)) out.ebay = "ended (skipped)";
        } catch (x) { out.ebay = "error: " + String((x as Error).message).slice(0, 160); }
      } else out.ebay = "not listed";
      if (r.etsy_id) {
        try {
          const h = await etsyHeaders();
          const prof = profiles.find((p) => Number(p.lb) >= lb) || profiles[profiles.length - 1];
          const p = await call(`https://openapi.etsy.com/v3/application/shops/${SHOP}/listings/${r.etsy_id}`, { method: "PATCH",
            headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ shipping_profile_id: String(prof.id), item_weight: String(lb), item_weight_unit: "lb" }).toString() });
          out.etsy = p.status < 300 ? `ok (${prof.title})` : (p.status === 404 || /inactive|sold_out|expired/i.test(p.body) ? "not active (skipped)" : `error ${p.status}: ${p.body.slice(0, 160)}`);
        } catch (x) { out.etsy = "error: " + String((x as Error).message).slice(0, 160); }
      } else out.etsy = "not listed";
      const bad = /^error/.test(String(out.ebay)) || /^error/.test(String(out.etsy));
      if (!bad) await sql`update pipeline.drafts set answers = coalesce(answers, '{}'::jsonb) || jsonb_build_object('ship_lb_fixed', ${lb}::int) where id = ${r.id}`;
      out.ok = !bad;
      done.push(out);
    }
    const [left2] = await sql`select count(*)::int n from pipeline.drafts d where (d.ident->>'kind' = 'item' or lower(coalesce(d.ident->>'format','')) = 'other')
      and d.status = 'sent' and d.built_at is not null and d.answers->>'ship_lb_fixed' is null and not exists (select 1 from pipeline.sales_done s where s.key like '%:' || d.pd)`;
    return json({ ok: true, done, remaining: left2.n });
  } catch (x) {
    return json({ ok: false, error: String((x as Error).message || x).slice(0, 300) }, 500);
  } finally {
    if (locked) await sql`select pg_advisory_unlock(7342001)`.catch(() => {});
    await sql.end({ timeout: 3 });
  }
});
