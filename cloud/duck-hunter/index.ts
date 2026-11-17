// Papa Duck — Edge Function "duck-hunter" v1 (2026-11-17). The cloud half of the 🦆 Duck Hunter Chrome extension.
// Papa Duck: "can you look at what this app does with vinted and see if we can do that ourselves" (BookMine Hunter, $59.99/mo),
//   "I would also like to add sell on ebay as well, because as long as it sells somewhere I dont want to throw that away", "yes build it".
// The extension reads the Vinted listing he is looking at (title, ISBN, price, shipping) and posts it here.
//   POST {action:"check", isbn, title, author, price, ship, url}  -> one call per store + BUY / MAYBE / PASS
//   POST {action:"bought", isbn, title, author, cost, list, best, url} -> Scout Buys (pipeline.scout_buys + Airtable), store "Vinted"
//   POST {action:"ping"} -> passcode check
// Pricing is the Scout app's own code (eBay matching copies + sold counters, AbeBooks, Amazon/Keepa, TGATB flag): this function
//   calls the scout function, adds a Keepa price/rank chart and his own sales history, and works out profit per store.
// Auth: header x-station-pass = pipeline.config station_passcode or a sorter PIN (same as the Book Station / Drafts web pages).
// SAFETY: reads only. Writes: hunter.checks (a log) and, on "bought", the Scout Buys row (same as the Scout app's Bought button).
import postgres from "npm:postgres@3.4.4";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, x-station-pass" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const SCOUT = "https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/scout";
const r2 = (n: number) => Math.round(n * 100) / 100;
const digits = (s: string) => String(s || "").replace(/[^0-9Xx]/g, "").toUpperCase();

function isbn10to13(s: string) {
  const d = digits(s); if (d.length !== 10) return d;
  const b = "978" + d.slice(0, 9); let t = 0;
  for (let i = 0; i < 12; i++) t += Number(b[i]) * (i % 2 ? 3 : 1);
  return b + ((10 - (t % 10)) % 10);
}
function isbn13to10(s: string) {
  const d = digits(s); if (d.length !== 13 || !d.startsWith("978")) return "";
  const b = d.slice(3, 12); let t = 0;
  for (let i = 0; i < 9; i++) t += Number(b[i]) * (10 - i);
  const c = (11 - (t % 11)) % 11; return b + (c === 10 ? "X" : String(c));
}
function validIsbn(s: string) {
  const d = digits(s);
  if (d.length === 13 && /^97[89]/.test(d)) { let t = 0; for (let i = 0; i < 12; i++) t += Number(d[i]) * (i % 2 ? 3 : 1); return (10 - (t % 10)) % 10 === Number(d[12]); }
  if (d.length === 10) { let t = 0; for (let i = 0; i < 10; i++) t += (d[i] === "X" ? 10 : Number(d[i])) * (10 - i); return t % 11 === 0; }
  return false;
}

// Keepa: product (with a year of used price + sales rank for the chart); search by title when the listing has no ISBN
async function keepa(key: string, q: { code?: string; term?: string }) {
  const u = q.code
    ? `https://api.keepa.com/product?key=${encodeURIComponent(key)}&domain=1&code=${q.code}&stats=90&history=1&days=365`
    : `https://api.keepa.com/search?key=${encodeURIComponent(key)}&domain=1&type=product&term=${encodeURIComponent(q.term || "")}&page=0&stats=90&history=1&days=365`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try { const r = await fetch(u, { signal: ctl.signal }); const j = await r.json(); return (j.products || [])[0] || null; }
  catch (_) { return null; } finally { clearTimeout(t); }
}
const KMIN = 21564000;   // Keepa minutes -> unix minutes
function series(csv: any, cents: boolean) {
  if (!Array.isArray(csv) || csv.length < 2) return [];
  const cut = Date.now() / 60000 - 365 * 1440, out: [number, number][] = [];
  let last: number | null = null;
  for (let i = 0; i + 1 < csv.length; i += 2) {
    const tm = csv[i] + KMIN, v = csv[i + 1];
    if (tm < cut) { if (v > 0) last = v; continue; }
    if (v > 0) out.push([tm, cents ? v / 100 : v]);
  }
  if (last != null) out.unshift([cut, cents ? last / 100 : last]);
  // 52 weekly points (last value in each week)
  const pts: (number | null)[] = [];
  for (let w = 0; w < 52; w++) {
    const end = cut + (w + 1) * 7 * 1440; let v: number | null = null;
    for (const [tm, x] of out) { if (tm <= end) v = x; else break; }
    pts.push(v);
  }
  return pts;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const pass = String(req.headers.get("x-station-pass") || "");
    const [cfg] = await sql`select value from pipeline.config where key = 'station_passcode'`;
    const [pc] = await sql`select value from pipeline.config where key = 'sorter_pins'`;
    let pins: Record<string, string> = {}; try { pins = JSON.parse(String(pc?.value || "{}")); } catch (_) { pins = {}; }
    if (!cfg || !pass || (pass !== cfg.value && !pins[pass])) return json({ ok: false, error: "bad_passcode" }, 403);
    const b = await req.json().catch(() => ({}));
    const action = String(b.action || "check");
    if (action === "ping") return json({ ok: true });
    const [sp] = await sql`select value from backup.config where key = 'scout_pin'`;
    const scout = (body: any) => fetch(SCOUT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: sp?.value, ...body }) })
      .then((r) => r.json());

    if (action === "bought") {
      const ident = { isbn: digits(b.isbn), title: String(b.title || "").slice(0, 250), author: String(b.author || ""), format: String(b.format || "") };
      const r = await scout({ action: "bought", ident, cost: b.cost, list: b.list, store: "Vinted",
        notes: [`Duck Hunter${b.best ? " · best store: " + b.best : ""}`, b.url ? String(b.url).split("?")[0] : ""].filter(Boolean).join(" · ") });
      return json({ ok: !!r.ok, id: r.id, airtable: r.airtable, error: r.error });
    }

    // ---------- check ----------
    const price = Number(b.price) || 0, ship = Number(b.ship) || 0, cost = r2(price + ship);
    const title = String(b.title || "").trim(), author = String(b.author || "").trim();
    let isbn = validIsbn(b.isbn) ? isbn10to13(String(b.isbn)) : "";
    const [kk] = await sql`select value from backup.config where key = 'keepa_key'`;
    const key = String(kk?.value || "");

    // same book checked in the last 6 hours: reuse the store numbers (they don't move that fast), redo the profit with this cost
    let base: any = null;
    if (isbn) {
      const [c] = await sql`select result from hunter.checks where isbn = ${isbn} and at > now() - interval '6 hours' and result ? 'stores' order by at desc limit 1`;
      if (c) base = c.result;
    }
    if (!base) {
      // no ISBN on the listing: find it on Amazon by title + author
      let kp: any = null;
      if (!isbn && title && key) {
        kp = await keepa(key, { term: [title, author].filter(Boolean).join(" ").slice(0, 120) });
        const e = (kp?.eanList || []).map(String).find((x: string) => validIsbn(x));
        if (e) isbn = isbn10to13(e);
      }
      const [sc, kp2] = await Promise.all([
        isbn ? scout({ action: "evaluate", isbn, cost, store: "Vinted" })
             : scout({ action: "evaluate", ident: { title, author, isbn: "", search: [title, author].join(" "), confidence: "medium" }, cost, store: "Vinted" }),
        kp ? Promise.resolve(kp) : isbn && key ? keepa(key, { code: isbn }) : Promise.resolve(null),
      ]);
      if (sc.error) return json({ ok: false, error: "Scout: " + sc.error });
      const id = sc.ident || {}, g = sc.grid || {}, amz = g.amazon || {}, eb = g.ebay || {}, abe = g.abe || {};
      const stores: any[] = [];
      if (eb.n > 0 && sc.list) stores.push({ store: "eBay", sells: sc.list, selling: eb.sold > 0 ? `${eb.sold} sold` : `${eb.n} listed, none sold yet`, proven: eb.sold > 0 });
      const amzPrice = amz.used_bb || amz.used_low || 0;
      if (amzPrice) stores.push({ store: "Amazon", sells: amzPrice, selling: amz.sales90 != null ? `${amz.sales90} / 90 days` : "no sales data", proven: (amz.sales90 || 0) >= 3 });
      if (abe.n > 0) stores.push({ store: "AbeBooks", sells: abe.avg, selling: `${abe.n} ${abe.n === 1 ? "copy" : "copies"} listed`, proven: false });
      const p = kp2 || null;
      base = {
        ident: { title: id.title || title, author: id.author || author, isbn: isbn || digits(id.isbn), format: id.format || "", publisher: id.publisher || "", tgatb: !!id.tgatb },
        stores, scout_verdict: sc.verdict, scout_reason: sc.reason, hard: sc.hard || [], flags: (sc.flags || []).slice(0, 6), family: sc.family || "",
        amazon: { asin: p?.asin || sc.amazon?.asin || "", rank: amz.rank || null, sales90: amz.sales90 ?? null, offers: p?.stats?.current?.[12] > 0 ? p.stats.current[12] : null,
                  title: p?.title || "", image: p?.images?.[0]?.l ? "https://m.media-amazon.com/images/I/" + p.images[0].l : p?.imagesCSV ? "https://m.media-amazon.com/images/I/" + String(p.imagesCSV).split(",")[0] : "" },
        chart: p ? { price: series(p.csv?.[2], true), rank: series(p.csv?.[3], false) } : null,
      };
      const asin = base.amazon.asin || isbn13to10(isbn);
      const [h] = await sql`select hunter.history(${isbn || null}, ${asin || null}) as h`;
      base.history = h.h;
      const [bd] = await sql`select buy_target, sell_target from bd.check where asin = ${asin || ""}`.catch(() => [] as any[]);
      base.bargain = bd ? { buy: Number(bd.buy_target) || null, sell: Number(bd.sell_target) || null } : null;
      // TGATB check on Keepa's publisher too
      if (/good and the beautiful|jenny phillips/i.test([p?.manufacturer, p?.publisher, p?.title, base.ident.title, base.ident.publisher].join(" "))) base.ident.tgatb = true;
    }

    // ---------- profit per store and the call (profit = what it sells for minus his cost) ----------
    const stores = (base.stores || []).map((s: any) => ({ ...s, profit: r2(s.sells - cost) })).sort((a: any, b2: any) => b2.profit - a.profit);
    const proven = stores.filter((s: any) => s.proven);
    const best = proven[0] && proven[0].profit >= (stores[0]?.profit || 0) - 3 ? proven[0] : stores[0] || null;
    if (best) best.best = true;
    const hard = [...(base.hard || [])];
    if (base.ident.tgatb && !hard.some((h: string) => /Good and the Beautiful/.test(h))) hard.unshift("🚨 The Good and the Beautiful — never list");
    let verdict = "PASS", why = "";
    const bp = best ? best.profit : 0;
    if (hard.length) { verdict = "PASS"; why = hard[0]; }
    else if (!best) { verdict = "PASS"; why = "Not found for sale anywhere"; }
    else if (best.proven && bp >= 8) { verdict = "BUY"; why = `Sells on ${best.store} · good margin`; }
    else if (best.proven && bp >= 4) { verdict = "MAYBE"; why = `Sells on ${best.store}, but a thin margin`; }
    else if (!best.proven && bp >= 8) { verdict = "MAYBE"; why = `Good price on ${best.store}, but no proof it sells`; }
    else { verdict = "PASS"; why = bp > 0 ? "Profit too small" : "Costs more than it sells for"; }
    const out = { ok: true, ...base, verdict, why, cost, best: best ? { store: best.store, profit: best.profit, sells: best.sells } : null, stores, hard };
    await sql`insert into hunter.checks (url, isbn, title, cost, verdict, best_store, best_profit, result)
      values (${String(b.url || "").split("?")[0] || null}, ${base.ident.isbn || null}, ${base.ident.title || title || null}, ${cost}, ${verdict}, ${best?.store || null}, ${best?.profit ?? null}, ${sql.json(base)})`;
    return json(out);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
