// Papa Duck — Edge Function "duck-hunter" v1 (2026-11-17). The cloud half of the 🦆 Duck Hunter Chrome extension.
// Papa Duck: "can you look at what this app does with vinted and see if we can do that ourselves" (BookMine Hunter, $59.99/mo),
//   "I would also like to add sell on ebay as well, because as long as it sells somewhere I dont want to throw that away", "yes build it".
// The extension reads the Vinted listing he is looking at (title, ISBN, price, shipping) and posts it here.
//   POST {action:"check", isbn, title, author, price, ship, url}  -> one row per store + BUY / PASS
//   POST {action:"bought", isbn, title, author, cost, list, best, url} -> Scout Buys (pipeline.scout_buys + Airtable), store "Vinted"
//   POST {action:"ping"} -> passcode check
// Pricing is the Scout app's own code (eBay matching copies + sold counters, AbeBooks, Amazon/Keepa, TGATB flag): this function
//   calls the scout function, adds a Keepa price/rank chart and his own sales history, and works out profit per store.
// Auth: header x-station-pass = pipeline.config station_passcode or a sorter PIN (same as the Book Station / Drafts web pages).
// v2 (2026-11-17 10:52, "please compare it against the 3 year keepa graph to determine, I dont want maybee"): only 🟢 BUY or 🔴 PASS.
//   Keepa history is 3 years. Amazon counts at its SAFE price = the lower of today's used price and its 3-year middle (median), and
//   "sells" = sales-rank drops in the last year. A store only counts toward BUY when it is proven to sell. BUY = proven store, profit >= $6.
// v3 (2026-11-17 10:59, "only want profit greater than $20"): BUY needs profit of at least pipeline.config hunter_min_profit (20).
// v4 (2026-11-17 20:10): the 3-year Amazon line now INCLUDES shipping (Keepa USED_GOOD_SHIPPING, csv[21]; falls back to USED + $3.99),
//   so it compares fairly with today's used price (which includes shipping). Before, penny listings made the "3-year middle" $0.95.
// v5 (2026-11-17 20:13, "if it cant find the books, can it look at the picture?"): {photos:[up to 4 listing image URLs], use_photos}
//   -> when the listing has no ISBN, or use_photos is set (the extension asks after "can't find" / wrong book), the photos are read by the
//   Scout app's own photo reader (cover, back cover barcode, copyright page) and the book is priced from what they show.
// v6 (2026-11-17 20:35): a book read from photos still gets its Amazon row (Keepa current used price incl. shipping, sales/year).
// v7c (21:05): Amazon-search picks re-read each candidate's editors/authors; a different author never wins; full-title matches rank first.
// v7 (2026-11-17 20:46, "dig deeper I need this to be a more higher accuracy"): ACCURACY FIRST - every check reads the photos
//   (config hunter_vision_model, default claude-sonnet-4-6) and the seller's ISBN is only used when the cover confirms it. See the check block.
// v8 (2026-11-19 17:59, "base the profit on the average high price during the three years when it sells at the highest" / "analyze the
//   keepa graph, you are a professional keepa analyzer"): seasonOf() reads the 3-year Keepa graph like a pro: each year's best 4-week
//   price window (when it sells highest), the year-over-year trend (falling highs -> use the latest year, not the 3-year average),
//   rank drops (= sales) in that season, today's used competition, and Amazon itself in stock (caps the price). A second Amazon row
//   "Amazon · season high (Aug)" is priced at that season high and counts toward BUY only when the book proves it sells in season.
// v8c (2026-11-19 18:09, "textbooks have a pattern"): season month = the same months every year (best average high + sales), and
//   the used-seller count is read so it can say "list a month early" when sellers pile in at the peak. See seasonOf.
// v8d (2026-11-19 18:10, "when inventory is down that means my prices will go up with less sellers"): today's used-seller count vs its
//   usual 3-year level. Half or less = low supply: Duck Hunter says the price is likely to rise, and a held book turns READY at 85% of target.
// v8e (2026-11-19 18:14, from BookMine's Keepa tutorial, "yes if you think it is more accurate"): the season price is what the book
//   actually SOLD for (used price at each sales-rank drop in the season window, 75th percentile per year), not just the highest asking
//   price; and every check shows the most he can offer and still make his minimum profit (pipeline.config hunter_min_profit).
// v8f (2026-11-19 18:17): the season row only appears when the book proves it sells in that season, and only a proven store can be
//   the headline "Best profit" (a PASS showed "Best profit $55.67" from a season price with 0 sales).
// v8b (2026-11-19 18:00, "track when i buy them and watch the real prices weekly to let me know when to list them. I will not list them
//   until the prices reaches the good time for profit"): every Duck Hunter "bought" goes into hunter.holds with its target (the season
//   high). POST {action:"watch"} (cron weekly + Launch Pad "Check now") reads today's Amazon used price for every book on hold; at 95% of
//   the target it turns READY ("List now") on the Launch Pad card 🦆 Holding for the season.
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
    ? `https://api.keepa.com/product?key=${encodeURIComponent(key)}&domain=1&code=${q.code}&stats=365&history=1&days=1095`
    : `https://api.keepa.com/search?key=${encodeURIComponent(key)}&domain=1&type=product&term=${encodeURIComponent(q.term || "")}&page=0&stats=365&history=1&days=1095`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try { const r = await fetch(u, { signal: ctl.signal }); const j = await r.json(); return (j.products || [])[0] || null; }
  catch (_) { return null; } finally { clearTimeout(t); }
}
const KMIN = 21564000;   // Keepa minutes -> unix minutes
function mid3(pts: (number | null)[]) {
  const v = pts.filter((x): x is number => x != null && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  return { median: r2(v[Math.floor(v.length / 2)]), low: r2(v[0]), high: r2(v[v.length - 1]) };
}
function series(csv: any, cents: boolean) {
  if (!Array.isArray(csv) || csv.length < 2) return [];
  const cut = Date.now() / 60000 - 1095 * 1440, out: [number, number][] = [];
  let last: number | null = null;
  for (let i = 0; i + 1 < csv.length; i += 2) {
    const tm = csv[i] + KMIN, v = csv[i + 1];
    if (tm < cut) { if (v > 0) last = v; continue; }
    if (v > 0) out.push([tm, cents ? v / 100 : v]);
  }
  if (last != null) out.unshift([cut, cents ? last / 100 : last]);
  // 78 points, one every 2 weeks (last value in each)
  const pts: (number | null)[] = [];
  for (let w = 0; w < 78; w++) {
    const end = cut + (w + 1) * 14 * 1440; let v: number | null = null;
    for (const [tm, x] of out) { if (tm <= end) v = x; else break; }
    pts.push(v);
  }
  return pts;
}

// ---------- v8 season analysis (the 3-year Keepa graph, read the way a professional Keepa seller reads it) ----------
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function rankDropsByMonth(csv: any) {
  // a sale shows on Keepa as the sales rank dropping (getting better). Count drops of 5%+ per calendar month, last 3 years.
  const by = new Array(12).fill(0); let total = 0;
  if (!Array.isArray(csv) || csv.length < 4) return { by, total };
  const cut = Date.now() / 60000 - 1095 * 1440; let prev: number | null = null;
  for (let i = 0; i + 1 < csv.length; i += 2) {
    const tm = csv[i] + KMIN, v = csv[i + 1];
    if (!(v > 0)) continue;
    if (prev != null && tm >= cut && v <= prev * 0.95) { by[new Date(tm * 60000).getUTCMonth()]++; total++; }
    prev = v;
  }
  return { by, total };
}
// v8c (2026-11-19 18:09, "textbooks have a pattern"): the season is picked the way textbooks actually sell - the SAME months every year
//   (Aug-Sep fall rush, Jan spring rush). Every month is scored by its average high across the 3 years AND the sales in it; the best
//   month wins, then each year's high is taken from that same window (month before to month after). Also reads the used-seller count
//   line (Keepa COUNT_USED): if sellers pile in at the peak, it says to list a few weeks BEFORE the season.
// v8e (2026-11-19 18:14, BookMine's Keepa method, "yes if you think it is more accurate"): every sales-rank drop is a sale, and the
//   used price at that moment is about what it SOLD for. soldPoints() pairs each drop with the used price (incl. shipping) at that time.
function soldPoints(rankCsv: any, priceCsv: any, cents: boolean, addShip = 0) {
  const out: { t: number; m: number; v: number }[] = [];
  if (!Array.isArray(rankCsv) || !Array.isArray(priceCsv) || priceCsv.length < 2) return out;
  const cut = Date.now() / 60000 - 1095 * 1440;
  const pr: [number, number][] = [];
  for (let i = 0; i + 1 < priceCsv.length; i += 2) pr.push([priceCsv[i] + KMIN, priceCsv[i + 1]]);
  let prev: number | null = null, j = 0, cur = -1;
  for (let i = 0; i + 1 < rankCsv.length; i += 2) {
    const tm = rankCsv[i] + KMIN, v = rankCsv[i + 1];
    if (!(v > 0)) continue;
    while (j < pr.length && pr[j][0] <= tm) { cur = pr[j][1]; j++; }
    if (prev != null && tm >= cut && v <= prev * 0.95 && cur > 0) out.push({ t: tm, m: new Date(tm * 60000).getUTCMonth(), v: r2((cents ? cur / 100 : cur) + addShip) });
    prev = v;
  }
  return out;
}
function bucketsByMonth(cutMin: number, n: number) { return Array.from({ length: n }, (_, w) => new Date((cutMin + (w + 1) * 14 * 1440) * 60000).getUTCMonth()); }
function seasonOf(p: any, price: (number | null)[]) {
  if (!p || price.length < 52) return null;
  const cutMin = Date.now() / 60000 - 1095 * 1440;
  const mon = bucketsByMonth(cutMin, price.length);
  const d = rankDropsByMonth(p.csv?.[3]);
  const win = (m: number) => [(m + 11) % 12, m, (m + 1) % 12];
  // 4-week windows (2 neighbouring 2-week points, so one-day spikes don't count), each tagged with its year and month
  const w4: { y: number; m: number; v: number }[] = [];
  for (let i = 0; i + 1 < price.length; i++) {
    const a = price[i], b = price[i + 1];
    if (a != null && b != null) w4.push({ y: Math.floor((i + 1) / 26), m: mon[i + 1], v: (a + b) / 2 });
  }
  const yearsWithData = [0, 1, 2].filter((y) => price.slice(y * 26, y * 26 + 26).filter((x) => x != null).length >= 10);
  if (yearsWithData.length < 2) return null;
  const highIn = (y: number, ms: number[]) => { let h = 0; for (const x of w4) if (x.y === y && ms.includes(x.m) && x.v > h) h = x.v; return h || null; };
  // score each month: average of the yearly highs in its window, nudged by how many sales happen in that window
  let bestM = -1, bestScore = -1;
  for (let m = 0; m < 12; m++) {
    const hs = yearsWithData.map((y) => highIn(y, win(m))).filter((x): x is number => x != null);
    if (hs.length < 2) continue;
    const avg = hs.reduce((t, x) => t + x, 0) / hs.length, sales = win(m).reduce((t, k) => t + d.by[k], 0);
    const score = avg * (1 + Math.min(sales, 60) / 300);          // a sales-heavy month wins a near tie on price
    if (score > bestScore) { bestScore = score; bestM = m; }
  }
  if (bestM < 0) return null;
  // each year's season price: what it actually SOLD for in that window (75th percentile of the sale prices, so one lucky sale
  // can't set it), falling back to the 4-week high when that year has fewer than 3 sales on record
  const usedCsv = Array.isArray(p.csv?.[21]) && p.csv[21].length > 2 ? p.csv[21] : p.csv?.[2];
  const sold = soldPoints(p.csv?.[3], usedCsv, true, usedCsv === p.csv?.[21] ? 0 : 3.99);
  const yearOf = (t: number) => Math.floor((t - cutMin) / (14 * 1440) / 26);
  let soldBased = 0;
  const years = yearsWithData.map((y) => {
    const v = sold.filter((x) => yearOf(x.t) === y && win(bestM).includes(x.m)).map((x) => x.v).sort((a1, b1) => a1 - b1);
    if (v.length >= 3) { soldBased++; return { y, high: v[Math.min(v.length - 1, Math.floor(v.length * 0.75))] }; }
    return { y, high: highIn(y, win(bestM)) };
  }).filter((x): x is { y: number; high: number } => x.high != null).map((x) => ({ high: r2(x.high), month: bestM }));
  if (years.length < 2) return null;
  const last = years[years.length - 1], earlier = years.slice(0, -1);
  const earlyAvg = earlier.reduce((t, y) => t + y.high, 0) / earlier.length;
  // falling = every year's high lower than the year before (new edition, more sellers), or the latest year well under the earlier ones
  const stepsDown = years.every((y, i) => i === 0 || y.high < years[i - 1].high) && last.high < years[0].high * 0.95;
  const falling = stepsDown || last.high < earlyAvg * 0.85;
  let high = falling ? last.high : r2(years.reduce((t, y) => t + y.high, 0) / years.length);
  const inSeason = win(bestM).reduce((t, m) => t + d.by[m], 0);
  // used sellers: average count in the season window vs the rest of the year (Keepa COUNT_USED, csv[12])
  const offS = series(p.csv?.[12], false);
  let inS = 0, nIn = 0, outS = 0, nOut = 0;
  offS.forEach((v, i) => { if (v == null) return; if (win(bestM).includes(mon[i])) { inS += v; nIn++; } else { outS += v; nOut++; } });
  const sellersIn = nIn ? Math.round(inS / nIn) : null, sellersOut = nOut ? Math.round(outS / nOut) : null;
  // v8d (18:10, "when inventory is down that means my prices will go up with less sellers"): sellers now vs their usual 3-year level
  const offV = offS.filter((x): x is number => x != null).sort((x, y) => x - y);
  const sellersUsual = offV.length ? offV[Math.floor(offV.length / 2)] : null;
  const sellersNow = p?.stats?.current?.[12] > 0 ? p.stats.current[12] : null;
  const lowStock = sellersNow != null && sellersUsual != null && sellersUsual >= 4 && sellersNow <= sellersUsual * 0.5;
  const flood = sellersIn != null && sellersOut != null && sellersOut > 0 && sellersIn >= sellersOut * 1.4 && sellersIn - sellersOut >= 3;
  // Amazon itself selling new caps what a used copy can bring
  const amazonNew = p?.stats?.current?.[0] > 0 ? p.stats.current[0] / 100 : null;
  let capped = false;
  if (amazonNew && amazonNew < high) { high = r2(amazonNew); capped = true; }
  const offers = p?.stats?.current?.[12] > 0 ? p.stats.current[12] : null;
  const now = new Date().getUTCMonth(), months = (bestM - now + 12) % 12;
  const listFrom = MONTHS[(bestM + (flood ? 11 : 0)) % 12];       // flood -> list a month early, before the other sellers show up
  return { high, month: MONTHS[bestM], months_away: months, years: years.map((y) => ({ high: y.high, month: MONTHS[y.month] })),
    falling, in_season_sales: inSeason, sales_3y: d.total, amazon_new: amazonNew, capped, used_offers: offers,
    sold_based: soldBased, sold_in_season: sold.filter((x) => win(bestM).includes(x.m)).length,
    sellers_in_season: sellersIn, sellers_off_season: sellersOut, flood, list_from: listFrom, sellers_now: sellersNow, sellers_usual: sellersUsual, low_stock: lowStock };
}

// ---------- v8b holds: watch the real price weekly, say when to list ----------
async function watchHolds(sql: any, key: string, buyId: number | null) {
  const hs = buyId ? await sql`select * from hunter.holds where buy_id = ${buyId}` : await sql`select * from hunter.holds where status = 'holding' order by id`;
  if (!hs.length) return { ok: true, checked: 0 };
  const codes = [...new Set(hs.map((h: any) => digits(h.isbn)).filter(Boolean))] as string[];
  const prods: any[] = [];
  for (let i = 0; i < codes.length; i += 20) prods.push(...await keepaMany(key, codes.slice(i, i + 20)));
  const byCode = new Map<string, any>();
  for (const p of prods) for (const c of [...(p.eanList || []), isbnOf(p)].filter(Boolean)) byCode.set(isbn10to13(String(c)), p);
  let ready = 0;
  for (const h of hs) {
    const p = byCode.get(isbn10to13(digits(h.isbn)));
    const day = new Date().toISOString().slice(0, 10);
    if (!p) {
      await sql`update hunter.holds set checked_at = now(), status = 'ready', ready_at = coalesce(ready_at, now()),
        season = coalesce(season, '{}'::jsonb) || ${sql.json({ note: "Amazon has no price history for it - list it now (eBay)" })} where id = ${h.id}`;
      ready++; continue;
    }
    let ps = series(p.csv?.[21], true);
    if (!ps.some((x) => x != null)) ps = series(p.csv?.[2], true).map((x) => (x == null ? null : r2(x + 3.99)));
    const now = p?.stats?.current?.[21] > 0 ? r2(p.stats.current[21] / 100) : p?.stats?.current?.[2] > 0 ? r2(p.stats.current[2] / 100 + 3.99) : null;
    const sea = seasonOf(p, ps);
    const target = h.target != null ? Number(h.target) : sea?.high ?? null;     // the target set when he bought it stays
    let note = "";
    if (target == null) note = "No season pattern on Amazon - list it now";
    else if (now == null) note = `No used copies on Amazon right now - waiting for about $${target.toFixed(2)}${h.season_month || sea?.month ? " around " + (h.season_month || sea?.month) : ""}`;
    else if (now >= target * 0.95) note = `Price is up to $${now.toFixed(2)} - target was $${target.toFixed(2)}. List it now`;
    else note = `Now $${now.toFixed(2)} - waiting for about $${target.toFixed(2)}${h.season_month || sea?.month ? " around " + (h.season_month || sea?.month) : ""}`
      + (sea?.flood ? ` - sellers pile in at the peak, list in ${sea.list_from}` : "");
    // few sellers right now (half the usual or less) -> prices are climbing; ready at 85% of target instead of 95%
    const lowReady = !!sea?.low_stock && target != null && now != null && now >= target * 0.85 && now < target * 0.95;
    if (lowReady) note = `Only ${sea.sellers_now} sellers on Amazon now (usually ${sea.sellers_usual}) and the price is $${now.toFixed(2)} - list it now while supply is low`;
    else if (sea?.low_stock && target != null && now != null && now < target * 0.85) note += ` - only ${sea.sellers_now} sellers now (usually ${sea.sellers_usual}), price should climb`;
    const isReady = target == null || (now != null && now >= target * 0.95) || lowReady;
    if (isReady) ready++;
    const hist = [...(Array.isArray(h.history) ? h.history : []).filter((x: any) => x.d !== day), { d: day, now }].slice(-60);
    await sql`update hunter.holds set asin = coalesce(asin, ${p.asin || null}), now_price = ${now}, checked_at = now(), target = ${target},
        season_month = coalesce(season_month, ${sea?.month || null}), season = ${sql.json({ ...(sea || {}), note })}, history = ${sql.json(hist)},
        status = case when ${isReady} and status = 'holding' then 'ready' else status end,
        ready_at = case when ${isReady} and ready_at is null then now() else ready_at end where id = ${h.id}`;
  }
  return { ok: true, checked: hs.length, ready };
}

// ---------- v7 identification helpers ----------
const STOPW = new Set(["the","and","for","with","from","into","your","this","that","edition","book","books","volume","vol","text","textbook","student","series","guide","an","a","of","to","in","on","by","ed","new"]);
const wordsOf = (t: string) => (String(t || "").toLowerCase().replace(/['’]/g, "").match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOPW.has(w) && !/^\d+(st|nd|rd|th)$/.test(w)).map((w) => w.replace(/(ies|es|s)$/, ""));
function titleMatch(a: string, b: string) {
  const A = [...new Set(wordsOf(a))], B = [...new Set(wordsOf(b))];
  if (!A.length || !B.length) return false;
  const hit = A.filter((w) => B.includes(w)).length;
  return hit >= 2 || hit / Math.min(A.length, B.length) >= 0.6;
}
const ORD: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
function edNum(t: string): number | null {
  const s = String(t || "").toLowerCase();
  const m = s.match(/(\d{1,2})(?:st|nd|rd|th)\s*(?:ed|edition)/) || s.match(/edition\s*(\d{1,2})\b/);
  if (m) return Number(m[1]);
  const w = s.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+edition/);
  return w ? ORD[w[1]] : null;
}
function editionOk(coverEd: string, amzTitle: string) { const a = edNum(coverEd), b = edNum(amzTitle); return a == null || b == null || a === b; }
async function keepaSearch(key: string, term: string): Promise<any[]> {
  try {
    const r = await fetch(`https://api.keepa.com/search?key=${encodeURIComponent(key)}&domain=1&type=product&term=${encodeURIComponent(term)}&page=0&stats=365&history=1&days=1095`, { signal: AbortSignal.timeout(20000) });
    return ((await r.json()).products || []).slice(0, 10);
  } catch (_) { return []; }
}
// v7c (2026-11-17 21:05): author check is 3-way: true = same author/editor, false = a DIFFERENT person, null = Amazon doesn't say.
//   Keepa search often leaves author blank (Shafer-Landau's "Ethical Theory" 2nd ed. had none), so candidates are re-read with the
//   product call, which lists contributors (editors too).
function authorHit(p: any, author: string): boolean | null {
  const aw = wordsOf(author).filter((w) => w.length >= 4);
  if (!aw.length) return null;
  const names = [p.author || "", ...((p.contributors || []) as any[]).map((c: any) => (Array.isArray(c) ? c[0] : String(c || "")))].join(" ");
  if (aw.some((w) => wordsOf(names + " " + (p.title || "")).includes(w))) return true;
  return wordsOf(names).length ? false : null;
}
const isbnOf = (p: any) => (p?.eanList || []).map(String).find((x: string) => validIsbn(x)) || (validIsbn(p?.asin) ? String(p.asin) : "");
const peopleOf = (p: any) => wordsOf([p.author || "", ...((p.contributors || []) as any[]).map((c: any) => (Array.isArray(c) ? c[0] : ""))].join(" ")).sort().slice(0, 3).join(" ");
async function keepaMany(key: string, codes: string[]): Promise<any[]> {
  if (!codes.length) return [];
  try {
    const r = await fetch(`https://api.keepa.com/product?key=${encodeURIComponent(key)}&domain=1&code=${codes.join(",")}&stats=365&history=1&days=1095`, { signal: AbortSignal.timeout(20000) });
    return (await r.json()).products || [];
  } catch (_) { return []; }
}
// title-matching books with an ISBN from a Keepa search, re-read in full (contributors + 3-year history)
async function candidates(key: string, prods: any[], cover: any) {
  const c = prods.filter((p) => p?.title && isbnOf(p) && titleMatch(cover.title, p.title)).slice(0, 6);
  const full = await keepaMany(key, c.map((p) => isbnOf(p)));
  return full.length ? full : c;
}
function bestProduct(prods: any[], cover: any) {
  let c = prods.filter((p) => p?.title && isbnOf(p) && titleMatch(cover.title, p.title));
  if (cover.author) c = c.filter((p) => authorHit(p, cover.author) !== false);      // a book by someone else can never win
  else if (new Set(c.map(peopleOf).filter(Boolean)).size > 1) return null;           // same title, different authors, no author to tell them apart
  const cw = [...new Set(wordsOf(cover.title))];
  let best: any = null, bestScore = -1;
  for (const p of c) {
    const pw = wordsOf(p.title);
    let s = cw.filter((w) => pw.includes(w)).length;
    if (cw.length && cw.every((w) => pw.includes(w))) s += 4;                         // every word of the cover title is in it
    if (cover.author && authorHit(p, cover.author) === true) s += 2;
    if (cover.edition) { if (edNum(cover.edition) != null && edNum(cover.edition) === edNum(p.title)) s += 3; else if (!editionOk(cover.edition, p.title)) s -= 5; }
    if (cover.format && p.binding && String(p.binding).toLowerCase().includes(String(cover.format).toLowerCase().slice(0, 4))) s += 1;
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return bestScore >= 1 ? best : null;
}
async function readCover(model: string, shots: { data: string; mt: string }[], seller: any) {
  const prompt = `These ${shots.length} photo(s) are from ONE used-book listing on Vinted (cover, back, spine, barcode or copyright page).
Identify the book from what the PHOTOS show. The seller typed this (it can be WRONG - use it only as a hint, never copy it as a fact):
title: ${seller.title}\nauthor: ${seller.author}\nISBN typed: ${seller.isbn}\ndescription: ${seller.desc}

Rules:
- isbn_seen: the ISBN exactly as printed in a photo (barcode text "ISBN 978-..." or copyright page). Copy every digit carefully. If any digit is blurry, cut off or covered, leave it "" and set isbn_clear false. Never use the seller's typed ISBN here.
- author: the author/editor shown in the photos. If the photos don't show one, use the author/editor named in the seller's description ONLY if it fits this book, and set author_from_seller true.
- edition: e.g. "5th edition" only if the photos show it.
- is_book: false if this is not a book.
- tgatb: true only if it is The Good and the Beautiful / Jenny Phillips material.
Answer ONLY JSON: {"is_book":true,"title":"","author":"","author_from_seller":false,"edition":"","year":"","format":"Paperback | Hardcover | Spiral | Other","isbn_seen":"","isbn_clear":true,"tgatb":false,"confidence":"high | medium | low"}`;
  for (let a = 1; a <= 2; a++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(45000),
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: "user", content: [
        ...shots.map((x) => ({ type: "image", source: { type: "base64", media_type: x.mt, data: x.data } })), { type: "text", text: prompt }] }] }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const raw = (j.content || []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").replace(/```json|```/g, "");
      try { return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch (_) { continue; }
    }
    if (r.status === 429 || r.status >= 500) { await new Promise((z) => setTimeout(z, 2500 * a)); continue; }
    break;
  }
  return null;
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

    const key0 = String((await sql`select value from backup.config where key = 'keepa_key'`)[0]?.value || "");
    if (action === "bought") {
      const ident = { isbn: digits(b.isbn), title: String(b.title || "").slice(0, 250), author: String(b.author || ""), format: String(b.format || "") };
      const r = await scout({ action: "bought", ident, cost: b.cost, list: b.list, store: "Vinted",
        notes: [`Duck Hunter${b.best ? " · best store: " + b.best : ""}`, b.url ? String(b.url).split("?")[0] : ""].filter(Boolean).join(" · ") });
      if (r.ok && r.id) {
        const [c] = ident.isbn ? await sql`select result from hunter.checks where isbn = ${ident.isbn} and at > now() - interval '2 days' order by at desc limit 1` : [];
        const sea = c?.result?.chart?.season || null;
        await sql`insert into hunter.holds (buy_id, isbn, asin, title, cost, target, season_month, best_store, season)
          values (${r.id}, ${ident.isbn || null}, ${c?.result?.amazon?.asin || null}, ${ident.title}, ${Number(b.cost) || 0}, ${sea?.high ?? null},
                  ${sea?.month ?? null}, ${b.best || null}, ${sea ? sql.json(sea) : null}) on conflict (buy_id) do nothing`;
        if (key0) await watchHolds(sql, key0, r.id);
      }
      return json({ ok: !!r.ok, id: r.id, airtable: r.airtable, error: r.error });
    }
    if (action === "watch") return json(await watchHolds(sql, key0, null));

    // ---------- check ----------
    const price = Number(b.price) || 0, ship = Number(b.ship) || 0, cost = r2(price + ship);
    const title = String(b.title || "").trim(), author = String(b.author || "").trim();
    let isbn = validIsbn(b.isbn) ? isbn10to13(String(b.isbn)) : "";
    const [kk] = await sql`select value from backup.config where key = 'keepa_key'`;
    const key = String(kk?.value || "");

    // ---------- v7 (2026-11-17 20:46, "dig deeper I need this to be a more higher accuracy"): ACCURACY FIRST ----------
    // The seller's typed ISBN is never trusted on its own. Every check reads the listing photos (cover, back, barcode, copyright page)
    // with a strong vision model, then picks the ISBN in this order:
    //   1) an ISBN read clearly from the photos (barcode / copyright page)        -> "photo-isbn"
    //   2) the seller's ISBN, only if its book matches the cover (title + edition) -> "seller-isbn-confirmed"
    //   3) Amazon search by the cover's title + author (+ edition)                 -> "cover-title" (flagged: check the edition)
    //   4) nothing found                                                           -> "title-only" (flagged)
    // No photos at all -> the seller's ISBN, marked "seller-isbn-unchecked".
    const sent = (Array.isArray(b.images) ? b.images : []).filter((x: any) => x && typeof x.data === "string" && x.data.length > 3000 && x.data.length < 6_000_000).slice(0, 4)
      .map((x: any) => ({ data: x.data, mt: /^image\/(jpeg|png|webp)$/.test(String(x.mt)) ? String(x.mt) : "image/jpeg" }));
    const listIsbn = isbn;
    let method = "", idNote = "", cover: any = null, kpFound: any = null;
    if (sent.length) {
      const [vm] = await sql`select value from pipeline.config where key = 'hunter_vision_model'`;
      cover = await readCover(String(vm?.value || "claude-sonnet-4-6"), sent, { title, author, desc: String(b.desc || "").slice(0, 1500), isbn: String(b.isbn || "") }).catch(() => null);
    }
    if (cover && cover.is_book === false) {
      return json({ ok: false, error: "The photos don't look like a book - use Fix it if it is one" });
    }
    if (cover?.title) {
      const photoIsbn = validIsbn(cover.isbn_seen) && cover.isbn_clear !== false ? isbn10to13(cover.isbn_seen) : "";
      if (photoIsbn) {
        isbn = photoIsbn; method = listIsbn && listIsbn !== photoIsbn ? "photo-isbn-over-seller" : "photo-isbn";
      } else if (listIsbn && key) {
        const kpL = await keepa(key, { code: listIsbn });
        const ok = kpL?.title && titleMatch(cover.title, kpL.title) && editionOk(cover.edition, kpL.title);
        if (ok) { method = "seller-isbn-confirmed"; kpFound = kpL; }
        else { isbn = ""; idNote = kpL?.title ? `The seller's ISBN is "${String(kpL.title).slice(0, 70)}" - not this book` : "The seller's ISBN isn't on Amazon"; }
      }
      if (!isbn && key) {
        const prods = await keepaSearch(key, [cover.title, cover.author, cover.edition].filter(Boolean).join(" ").slice(0, 120));
        const pick = bestProduct(await candidates(key, prods, cover), cover);
        if (pick) { isbn = isbn10to13(isbnOf(pick)); kpFound = pick; method = "cover-title"; }
      }
      if (!isbn) method = "title-only";
    } else {
      method = listIsbn ? "seller-isbn-unchecked" : "title-only";
    }
    const idTitle = cover?.title || title, idAuthor = cover?.author || author;

    // same book checked in the last 6 hours: reuse the store numbers, redo the profit with this cost
    let base: any = null;
    if (isbn) {
      const [c] = await sql`select result from hunter.checks where isbn = ${isbn} and at > now() - interval '6 hours' and result ? 'stores' order by at desc limit 1`;
      if (c && c.result?.v === 7) base = c.result;
    }
    if (!base) {
      const [sc, kp2] = await Promise.all([
        isbn ? scout({ action: "evaluate", isbn, cost, store: "Vinted" })
             : scout({ action: "evaluate", ident: { title: idTitle, author: idAuthor, isbn: "", edition: cover?.edition || "", search: [idTitle, idAuthor].join(" "), confidence: "medium" }, cost, store: "Vinted" }),
        kpFound ? Promise.resolve(kpFound) : isbn && key ? keepa(key, { code: isbn }) : Promise.resolve(null),
      ]);
      if (sc.error) return json({ ok: false, error: "Scout: " + sc.error });
      if (sc.verdict === "RETAKE") return json({ ok: false, error: "Couldn't identify the book - type the ISBN with Fix it" });
      const id = sc.ident || {}, g = sc.grid || {}, amz = g.amazon || {}, eb = g.ebay || {}, abe = g.abe || {};
      const stores: any[] = [];
      if (eb.n > 0 && sc.list) stores.push({ store: "eBay", sells: sc.list, selling: eb.sold > 0 ? `${eb.sold} sold` : `${eb.n} listed, none sold yet`, proven: eb.sold > 0 });
      const p0 = kp2 || null;
      let priceSeries = p0 ? series(p0.csv?.[21], true) : [];
      if (!priceSeries.some((x) => x != null) && p0) priceSeries = series(p0.csv?.[2], true).map((x) => (x == null ? null : r2(x + 3.99)));
      const m3 = mid3(priceSeries);
      const drops365 = typeof p0?.stats?.salesRankDrops365 === "number" && p0.stats.salesRankDrops365 >= 0 ? p0.stats.salesRankDrops365 : null;
      const kNow = p0?.stats?.current?.[21] > 0 ? p0.stats.current[21] / 100 : p0?.stats?.current?.[2] > 0 ? p0.stats.current[2] / 100 + 3.99 : 0;
      const amzNow = amz.used_bb || amz.used_low || r2(kNow) || 0;
      const amzSafe = amzNow && m3 ? Math.min(amzNow, m3.median) : amzNow;
      if (amzSafe) stores.push({ store: "Amazon", sells: r2(amzSafe), now: amzNow, median3: m3?.median ?? null,
        selling: drops365 != null ? `${drops365} sales / year` : amz.sales90 != null ? `${amz.sales90} / 90 days` : "no sales data",
        proven: drops365 != null ? drops365 >= 4 : (amz.sales90 || 0) >= 3 });
      // v8: the season-high row (only when the graph proves it sells in that season)
      const sea = seasonOf(p0, priceSeries);
      // v8f (18:17, his screenshot: "season high $108.87, 0 sales around Mar" shown as Best profit $55.67): the season row only shows
      //   when the book really sells in that season - a season price nobody paid is not a price
      const sellsIn = !!sea && sea.in_season_sales >= 2 && (drops365 == null || drops365 >= 4);
      if (sea && sellsIn && sea.high > (amzSafe || 0) + 0.5) {
        stores.push({ store: `Amazon · season ${sea.sold_based ? "sold price" : "high"} (${sea.month})`, sells: sea.high, season: sea,
          selling: `${sea.in_season_sales} sales around ${sea.month} in 3 yrs` + (sea.months_away ? ` · hold ~${sea.months_away} mo` : " · in season now")
            + (sea.falling ? " · highs falling, using latest year" : "") + (sea.capped ? " · capped at Amazon's own price" : "")
            + (sea.flood ? ` · sellers pile in at the peak (${sea.sellers_off_season}→${sea.sellers_in_season}) - list in ${sea.list_from}` : "")
            + (sea.low_stock ? ` · only ${sea.sellers_now} sellers now (usually ${sea.sellers_usual}) - price likely to rise` : ""),
          proven: sellsIn });
      }
      if (abe.n > 0) stores.push({ store: "AbeBooks", sells: abe.avg, selling: `${abe.n} ${abe.n === 1 ? "copy" : "copies"} listed`, proven: false });
      const p = kp2 || null;
      base = {
        ident: { title: id.title || idTitle, author: id.author || idAuthor, isbn: isbn || digits(id.isbn), format: id.format || cover?.format || "", publisher: id.publisher || "",
                 edition: cover?.edition || id.edition || "", tgatb: !!id.tgatb },
        stores, scout_verdict: sc.verdict, scout_reason: sc.reason, hard: sc.hard || [], flags: (sc.flags || []).slice(0, 6), family: sc.family || "",
        amazon: { asin: p?.asin || sc.amazon?.asin || "", rank: amz.rank || null, sales90: amz.sales90 ?? null, offers: p?.stats?.current?.[12] > 0 ? p.stats.current[12] : null,
                  title: p?.title || "", image: p?.images?.[0]?.l ? "https://m.media-amazon.com/images/I/" + p.images[0].l : p?.imagesCSV ? "https://m.media-amazon.com/images/I/" + String(p.imagesCSV).split(",")[0] : "" },
        chart: p ? { price: priceSeries, rank: series(p.csv?.[3], false), years: 3, m3, season: sea } : null, v: 7,
      };
      const asin = base.amazon.asin || isbn13to10(isbn);
      const [h] = await sql`select hunter.history(${isbn || null}, ${asin || null}) as h`;
      base.history = h.h;
      const [bd] = await sql`select buy_target, sell_target from bd.check where asin = ${asin || ""}`.catch(() => [] as any[]);
      base.bargain = bd ? { buy: Number(bd.buy_target) || null, sell: Number(bd.sell_target) || null } : null;
      if (/good and the beautiful|jenny phillips/i.test([p?.manufacturer, p?.publisher, p?.title, base.ident.title, base.ident.publisher].join(" "))) base.ident.tgatb = true;
    }
    if (cover?.tgatb) base.ident.tgatb = true;
    base.id = { method, note: idNote, cover_title: cover?.title || "", cover_edition: cover?.edition || "", seller_isbn: listIsbn || "", photos_read: sent.length };
    base.from_photos = sent.length > 0;

    // ---------- profit per store and the call (profit = what it sells for minus his cost) ----------
    const stores = (base.stores || []).map((s: any) => ({ ...s, profit: r2(s.sells - cost) })).sort((a: any, b2: any) => b2.profit - a.profit);
    const proven = stores.filter((s: any) => s.proven);
    const best = proven[0] || null;   // v8f: only a store that PROVES it sells can be "best" - unproven rows are shown, never headlined
    if (best) best.best = true;
    const hard = [...(base.hard || [])];
    if (base.ident.tgatb && !hard.some((h: string) => /Good and the Beautiful/.test(h))) hard.unshift("🚨 The Good and the Beautiful — never list");
    const [mp] = await sql`select value from pipeline.config where key = 'hunter_min_profit'`;
    const minP = Number(mp?.value) || 20;
    let verdict = "PASS", why = "";
    const bp = best ? best.profit : 0;
    if (hard.length) { verdict = "PASS"; why = hard[0]; }
    else if (!best) { verdict = "PASS"; why = stores.length ? "No proof it sells on eBay or Amazon" : "Not found for sale anywhere"; }
    else if (bp >= minP && best.season) { verdict = "BUY"; why = `Amazon season ${best.season.sold_based ? "sold price" : "high"}: $${best.sells.toFixed(2)} around ${best.season.month}` + (best.season.months_away ? ` - hold ~${best.season.months_away} months` : " - in season now"); }
    else if (bp >= minP) { verdict = "BUY"; why = `Sells on ${best.store}` + (best.store === "Amazon" && best.median3 ? " · 3-year price holds" : ""); }
    else { verdict = "PASS"; why = bp > 0 ? `Profit under $${minP}` : "Costs more than it sells for"; }
    // v8e: the most he can pay for the book itself (shipping on top) and still make his minimum profit on the best proven store
    const maxOffer = best && best.proven && !hard.length ? r2(best.sells - minP - ship) : null;
    if (maxOffer != null) {
      if (maxOffer <= 0) why += " · can't reach $" + minP + " profit at any price";
      else if (verdict === "PASS") why += ` · offer at most $${maxOffer.toFixed(2)} to make $${minP}`;
      else if (maxOffer < price) why += ` · offer at most $${maxOffer.toFixed(2)}`;
      else why += ` · would still work up to $${maxOffer.toFixed(2)}`;
    }
    const amzRow = stores.find((s: any) => s.store === "Amazon");
    if (amzRow && amzRow.now && amzRow.median3 && amzRow.now > amzRow.median3 * 1.3) amzRow.note = `today $${amzRow.now.toFixed(2)} is high: 3-year middle is $${amzRow.median3.toFixed(2)}`;
    const out = { ok: true, ...base, verdict, why, cost, max_offer: maxOffer, best: best ? { store: best.store, profit: best.profit, sells: best.sells } : null, stores, hard };
    await sql`insert into hunter.checks (url, isbn, title, cost, verdict, best_store, best_profit, result)
      values (${String(b.url || "").split("?")[0] || null}, ${base.ident.isbn || null}, ${base.ident.title || title || null}, ${cost}, ${verdict}, ${best?.store || null}, ${best?.profit ?? null}, ${sql.json(base)})`;
    return json(out);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
