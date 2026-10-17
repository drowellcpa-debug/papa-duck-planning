// v22 (2026-10-17): Perplexity's changes - believable-new ceiling (new <= 3x used median; ceiling = lower of new - $1 and used 75th pct),
//   40% guard only for books already listed, grade checked against the condition notes (water damage -> Acceptable; water / stain /
//   ring / moderate wear / creasing -> no better than Good; -20 points when they disagree), flawed copies undercut better copies by $2,
//   market under $11.49 delivered -> $6.99 if 3+ sold in 180 days else "cleanup pile", confidence score (pipeline.config price_score),
//   score < 50 or rare -> pipeline.price_review (reviewer claude, waiting) and held from blast off; 50-79 = low confidence.
// v21 (2026-10-17): PRICING RULE v2 (his document) - AbeBooks + eBay comps with real shipping, condition points, anchors, weighted blend,
//   range, Amazon 180-day speed, net check and Check-price flags. Test mode {"dry": id} always uses it; it runs live ONLY when
//   pipeline.config pricing_rule = 'v2' (set after Papa Duck approves the test table). Settings: price_abe_lean 0.60,
//   price_ship_charge 4.50, price_min_net 5, min_list_drafts 6.99.
// v19.1 (2026-10-17): first re-price showed two misses - PD-3258 Artist at War $1.99 (all copies $6.73 free ship) and PD-3262
//   Rendering in Pencil $51.99 (one $162 "new" copy set the top). Now: the top of the band is never above the highest real
//   used copy, and the list never goes under $6.99 (pipeline.config min_list_drafts).
// v19 (2026-10-17): PRICE INSIDE THE BAND - eBay-only band pricing (see claude/papa-duck-rule-CE-price-inside-the-band.md).
// v18 (2026-10-11): FOXING BY NAME. v17 (2026-10-08): ABOUT THE AUTHOR. v16 (09-30): NEVER LEAVE A BOOK HANGING. v15 (09-30): PUBLISHER SEARCH.
// v14 (09-29): ETSY RECOMMENDATION. v12 (09-26): FAST (listing writer in parallel with the comps).
// Papa Duck — price worker. Runs every minute from pg_cron. Each call prices AT MOST ONE draft.
// Auth: x-backup-secret must match backup.config.cron_secret. Secrets: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, ANTHROPIC_API_KEY.
import postgres from "npm:postgres@3.4.4";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- eBay Browse (comps) ----------------
async function ebayToken(): Promise<string> {
  const id = (Deno.env.get("EBAY_CLIENT_ID") || "").trim(), sec = (Deno.env.get("EBAY_CLIENT_SECRET") || "").trim();
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(`${id}:${sec}`) },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }) });
  const j = await r.json(); if (!j.access_token) throw new Error("eBay token refused: " + (j.error_description || r.status));
  return j.access_token;
}
type Comp = { i: number; id: string; title: string; price: number; ship: number | null; cond: string; url: string; sold: number;
  ch?: string; seller?: string; info?: string; us?: boolean; ship_assumed?: boolean; cur?: string };
async function browse(tok: string, q: string, cat: boolean): Promise<any[]> {
  const u = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  u.searchParams.set("q", q.slice(0, 100));
  u.searchParams.set("limit", "50");
  u.searchParams.set("filter", "buyingOptions:{FIXED_PRICE},priceCurrency:USD,itemLocationCountry:US");
  if (cat) u.searchParams.set("category_ids", "267");
  for (let a = 1; a <= 3; a++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
    if (r.ok) return (await r.json()).itemSummaries || [];
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * a); continue; }
    throw new Error(`eBay search refused (${r.status})`);
  }
  throw new Error("eBay search kept failing");
}
// sold counters (same numbers Papa Duck's papaduck_ebay.py --sold shows): getItem -> estimatedAvailabilities[].estimatedSoldQuantity
async function soldCounts(tok: string, comps: Comp[]): Promise<void> {
  const todo = comps.slice(0, 40);
  for (let k = 0; k < todo.length; k += 20) {
    await Promise.all(todo.slice(k, k + 20).map(async (c) => {
      try {
        const r = await fetch("https://api.ebay.com/buy/browse/v1/item/" + encodeURIComponent(c.id), { headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
        if (!r.ok) return;
        const j = await r.json();
        c.sold = (j.estimatedAvailabilities || []).reduce((a: number, e: any) => a + (Number(e.estimatedSoldQuantity) || 0), 0);
      } catch (_) { /* leave 0 */ }
    }));
  }
}
// ---------- market grid: AbeBooks used copies + Amazon via Keepa (same sources as the Scout app) ----------
async function abeMarket(isbn: string) {
  if (!isbn) return null;
  try {
    const u = new URL("https://www.abebooks.com/servlet/SearchResults");
    u.searchParams.set("isbn", isbn); u.searchParams.set("sortby", "17");
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" } });
    if (!r.ok) return { error: "AbeBooks answered " + r.status };
    const html = await r.text();
    const prices: number[] = [];
    for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
      let j: any; try { j = JSON.parse(m[1]); } catch { continue; }
      for (const L of [j].flat().filter((x: any) => x && x["@type"] === "ItemList")) for (const el of (L.itemListElement || [])) {
        const of = (el.item || {}).offers || {}; const price = Number(of.price);
        if (price > 0 && (!of.priceCurrency || of.priceCurrency === "USD") && !/NewCondition/i.test(String(of.itemCondition || ""))) prices.push(price);
      }
    }
    if (!prices.length) return { n: 0 };
    prices.sort((a, b) => a - b);
    return { n: prices.length, low: prices[0], high: prices[prices.length - 1], avg: +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2),
      url: String(u) };
  } catch (e) { return { error: String((e as Error).message || e).slice(0, 120) }; }
}
async function keepaMarket(sql: any, isbn: string, grade: string) {
  if (!isbn) return null;
  const [k] = await sql`select value from backup.config where key = 'keepa_key'`;
  if (!k || !k.value) return { error: "no Keepa key" };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://api.keepa.com/product?key=${encodeURIComponent(k.value)}&domain=1&code=${isbn}&stats=180&buybox=1&history=0`, { signal: ctl.signal });
    const j = await r.json();
    const p = j?.products?.[0]; if (!p || !p.stats) return { error: j?.error?.message || "not on Amazon" };
    const st = p.stats, cur = st.current || [];
    const c2d = (v: any) => (typeof v === "number" && v > 0 ? +(v / 100).toFixed(2) : null);
    const gi: Record<string, number> = { "like new": 19, "very good": 20, "good": 21, "acceptable": 22 };
    const g = gi[grade.toLowerCase()] || 21;
    return { asin: p.asin, used_bb: c2d(st.buyBoxUsedPrice), used_bb_fba: st.buyBoxUsedIsFBA === true, used_bb_cond: st.buyBoxUsedCondition ?? null,
      used_low: c2d(cur[2]), grade_low: c2d(cur[g]), grade, rank: typeof cur[3] === "number" && cur[3] > 0 ? cur[3] : null,
      sales90: typeof st.salesRankDrops90 === "number" && st.salesRankDrops90 >= 0 ? st.salesRankDrops90 : null,
      sales180: typeof st.salesRankDrops180 === "number" && st.salesRankDrops180 >= 0 ? st.salesRankDrops180 : null,
      new_low: c2d(cur[1]), amazon_price: c2d(cur[0]), tokens: j.tokensLeft };
  } catch (e) { return { error: String((e as Error).message || e).slice(0, 120) }; } finally { clearTimeout(timer); }
}
function cleanIsbn(s: string): string { const d = String(s || "").replace(/[^0-9Xx]/g, ""); return d.length === 10 || d.length === 13 ? d : ""; }
// v15: the short brand name sellers actually type ("A Beka Book / Pensacola Christian College" -> "Abeka", "Bob Jones University Press" -> "Bob Jones University")
function pubBrand(p: string): string {
  let b = String(p || "").split(/[\/,(;]|\s-\s| a division| an imprint| a ministry| originally/i)[0].trim();
  if (/^a\s?beka/i.test(b)) return "Abeka";
  if (/^bju\b|bob jones/i.test(b)) return "BJU Press";
  b = b.replace(/\b(publishing|publishers|publisher|press|company|co\.?|inc\.?|llc|ltd\.?|house|books?)\b/gi, " ").replace(/\s+/g, " ").trim();
  return b.split(" ").length > 4 ? "" : b;
}

// ---------------- v19 band arithmetic ----------------
const GRADES = ["poor", "fair", "acceptable", "good", "very good", "near fine", "like new", "as new", "fine", "new"];
const BANDS: Record<string, number> = { durable: 0.72, standard: 0.65, perishable: 0.58, low: 0.60 };
const SHIP_EST = 4.50;                                   // what a buyer pays us for Media Mail, on top of our list price
const POS: Record<string, number> = { "like new": 0.75, "as new": 0.75, "fine": 0.75, "near fine": 0.6, "very good": 0.5, "good": 0.2, "acceptable": 0.1, "fair": 0.05, "poor": 0 };
const r50 = (x: number) => Math.round(x * 2) / 2;
const up99 = (x: number) => { const c = Math.ceil(x - 0.99 - 1e-9) + 0.99; return c < 0.99 ? 0.99 : c; };
const down99 = (x: number) => { const c = Math.floor(x - 0.99 + 1e-9) + 0.99; return c < 0.99 ? 0.99 : c; };   // largest .99 at or below x
const gIdx = (g: string) => GRADES.indexOf(String(g || "").toLowerCase());
type Judged = Comp & { fmt: string; jacket: boolean; grade: string; relevant: boolean; why: string };
function priceFromComps(comps: Judged[], ourFmt: string, ourJacket: boolean, ourGrade: string, bandIn: string, fairIn = 0, minList = 6.99) {
  const rel: Judged[] = [], drop: { c: Judged; why: string }[] = [];
  for (const c of comps) {                                // same book, same format, same jacket - EVERY grade (v19)
    let why = "";
    if (!c.relevant) why = c.why || "different book / edition";
    else if ((c.fmt || "").toLowerCase() !== ourFmt.toLowerCase()) why = "format " + c.fmt;
    else if (!!c.jacket !== !!ourJacket) why = "jacket " + (c.jacket ? "yes" : "no");
    else if (!(c.price > 0)) why = "no price";
    if (why) drop.push({ c, why }); else rel.push(c);
  }
  if (!rel.length) return { error: "No matching copies on eBay right now (no relevant comps — type your own price).", dropped: drop };
  const dl = (c: Judged) => +(c.price + (c.ship ?? SHIP_EST)).toFixed(2);     // delivered: what the buyer actually pays
  const newC = rel.filter((c) => c.grade === "new");
  const usedAll = rel.filter((c) => c.grade !== "new");
  // outliers among the used copies (delivered), named in the note
  let keep = usedAll, out: Judged[] = [];
  if (usedAll.length >= 3) {
    const sv = usedAll.map(dl).sort((a, b) => a - b), mid = sv[Math.floor(sv.length / 2)];
    keep = usedAll.filter((c) => !(dl(c) > mid * 2.5 || dl(c) * 2.5 < mid));
    out = usedAll.filter((c) => !keep.includes(c));
    if (keep.length < 2) { keep = usedAll; out = []; }
  }
  const newMin = newC.length ? Math.min(...newC.map(dl)) : null;
  const ug = ourGrade.toLowerCase();
  let targetDel: number, basis: string, floorDel: number | null = null, topDel: number | null = null, rare = false;
  if (!keep.length) {                                     // only new copies on eBay: a used copy sits a fair step under new
    targetDel = newMin! * (POS[ug] ?? 0.35) + newMin! * 0.15; basis = "only new copies on eBay - priced under new";
    floorDel = null; topDel = newMin;
  } else {
    floorDel = Math.min(...keep.map(dl));
    topDel = Math.min(newMin ?? Infinity, Math.max(...keep.map(dl)));   // v19.1: a $162 "new" copy never lifts the top above the real used copies
    if (topDel < floorDel) topDel = floorDel;
    rare = newMin === null && keep.length < 3;
    if (rare) {                                           // old / rare: just under the closest matching copy
      const og = gIdx(ug);
      const closest = [...keep].sort((a, b) => (Math.abs(gIdx(a.grade || ug) - og) - Math.abs(gIdx(b.grade || ug) - og)) || (dl(a) - dl(b)))[0];
      targetDel = dl(closest) - 1; basis = `rare: $1 under the closest matching copy ($${dl(closest).toFixed(2)} delivered, ${closest.grade || "used"})`;
    } else {
      const p = POS[ug] ?? 0.35;
      targetDel = floorDel + p * (topDel - floorDel);
      basis = `${Math.round(p * 100)}% up the band for ${ourGrade}`;
    }
  }
  let capped = false;
  if (newMin !== null && targetDel > newMin - 1) { targetDel = newMin - 1; capped = true; }   // never more than a new copy
  let lst = +down99(targetDel - SHIP_EST).toFixed(2);
  // v19.1 floor: never below the minimum list (pipeline.config min_list_drafts, default $6.99). Artist at War: every copy $6.73 free shipping -> band math said $1.99.
  const floored = lst < minList; if (floored) lst = +minList.toFixed(2);
  const band = lst < 12 ? "low" : (BANDS[bandIn] ? bandIn : "standard");
  const auto = r50(lst * 0.80), mn = r50(lst * BANDS[band]);
  const vals = keep.map((c) => c.price);
  const low = vals.length ? Math.min(...vals) : null, high = vals.length ? Math.max(...vals) : null;
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const sv2 = [...vals].sort((a, b) => a - b);
  const median = sv2.length ? (sv2.length % 2 ? sv2[(sv2.length - 1) / 2] : (sv2[sv2.length / 2 - 1] + sv2[sv2.length / 2]) / 2) : null;
  const soldTot = keep.reduce((a, c) => a + (c.sold || 0), 0);
  const problems: string[] = [];
  if (!(mn <= auto && auto < lst)) problems.push(`Min ≤ Auto < List failed (${mn}/${auto}/${lst})`);
  const f2 = (x: number | null) => (x === null ? "-" : "$" + x.toFixed(2));
  let note = `PRICED INSIDE THE BAND (v19): ${ourFmt}${ourJacket ? " with jacket" : " no jacket"}, ${ourGrade}. Delivered prices (item + shipping): `
    + `cheapest used ${f2(floorDel)}, top ${f2(topDel)}${newMin !== null ? " (cheapest new " + f2(newMin) + ")" : " (no new copy on eBay)"}, ${keep.length} used + ${newC.length} new matching copies. `
    + `${basis} -> ${f2(targetDel)} delivered${capped ? " (held $1 under the new copy)" : ""} -> list ${f2(lst)}${floored ? " (raised to the $" + minList.toFixed(2) + " minimum)" : ""} + ~$${SHIP_EST.toFixed(2)} Media Mail. `
    + `Auto 80% $${auto.toFixed(2)}, Min ${band} band $${mn.toFixed(2)}.` + (fairIn > 0 ? ` (Claude's own guess was $${fairIn.toFixed(2)} - not used.)` : "")
    + ` Source: eBay active fixed-price copies (Browse API).`;
  if (out.length) note += " OUTLIERS DROPPED AND NAMED: " + out.map((c) => `$${dl(c).toFixed(2)} ${c.title.slice(0, 50)}`).join(", ") + ".";
  if (drop.length) note += " NOT RELEVANT: " + drop.slice(0, 12).map((d) => `$${d.c.price.toFixed(2)} (${d.why})`).join(", ") + (drop.length > 12 ? "..." : "") + ".";
  return { list: lst, auto, min: mn, avg: avg === null ? null : +avg.toFixed(2), median, sold_avg: null, sold_total: soldTot,
    fair: fairIn || null, basis, low, high, n: keep.length + newC.length, band, note, problems, rare, capped_by_new: capped,
    band_low: floorDel, band_top: topDel, new_low: newMin, target_delivered: +targetDel.toFixed(2),
    used: [...keep, ...newC].map((c) => ({ price: c.price, ship: c.ship, delivered: dl(c), grade: c.grade || "used", title: c.title, cond: c.cond, url: c.url, sold: c.sold || 0 })),
    outliers: out.map((c) => ({ price: c.price, title: c.title, url: c.url })),
    dropped: drop.map((d) => ({ price: d.c.price, title: d.c.title, why: d.why, url: d.c.url })) };
}

// ================= PRICING RULE v2 (Papa Duck, "PapaDuck Pricing Rule v2: Instructions for Claude", 2026-10-17) =================
// Step 1 collect: up to 30 AbeBooks copies (sorted by lowest TOTAL, same as AbeBooks shows buyers) + the eBay copies + cheapest new anywhere.
// Step 2 clean: Claude drops lots/sets/POD/reprints/BCE/ex-lib/wrong edition; code drops wrong binding, non-US sellers with silly
//   shipping, non-US$ prices, and anything over 5x the median. Missing shipping = $4.50, marked assumed.
// Step 3 condition points (New 5, LN 4, NF/VG+ 3.5, VG 3, G 2, Acc 1); compare only copies within 1 point of ours or better.
// Step 4 anchors: AbeBooks = 2nd-lowest total; eBay = median of the 3 lowest totals.
// Step 5 blend: w_abe = (lean*5 + n_abe) / (5 + n_abe + n_ebay), lean = pipeline.config price_abe_lean (0.60).
// Step 6 range: floor = blended cheapest; ceiling = cheapest new - $1, else 75th percentile; LN 85% / VG 50% / G 20%;
//   target = 0.5*anchor + 0.5*position. Rare (no new, < 3 comps): $1 under the closest copy, flagged.
// Step 6b Amazon sales in 180 days: 20+ -> +10% of the range; 0-2 -> never below the anchor, flagged.
// Step 7 list = target - shipping charged (price_ship_charge, $4.50), to .99; net eBay / AbeBooks Premium; net floor price_min_net ($5).
// Step 8 guards -> flags (Check price): >40% from old, < $6.99 or > 2x highest comp, < 2 good comps, title-only match, assumed shipping.
const ABE_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" };
const decH = (s: string) => String(s || "").replace(/\u00a0/g, " ").replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
const moneyOf = (s: string) => { const m = String(s).replace(/,/g, "").match(/(US\$|£|€|CA\$|AU\$)?\s*([0-9]+(?:\.[0-9]+)?)/); return m ? { cur: m[1] || "US$", v: +m[2] } : null; };
function parseAbe(html: string) {
  const out: any[] = [];
  const starts = [...html.matchAll(/data-test-id="listing-item-(\d+)"/g)];
  for (let k = 0; k < starts.length; k++) {
    const id = starts[k][1], blk = html.slice(starts[k].index!, k + 1 < starts.length ? starts[k + 1].index : starts[k].index! + 40000);
    const g = (re: RegExp) => { const m = blk.match(re); return m ? decH(m[1]) : ""; };
    const pub = g(/data-test-id="publisher-\d+"[^>]*>([\s\S]*?)<\/p>/);
    const attrs = [...blk.matchAll(/<li [^>]*><span [^>]*aria-label="([^"]*)"/g)].map((m) => decH(m[1]));
    const shipTxt = decH(((blk.match(/data-test-id="item-shipping-price-\d+">([\s\S]*?)(?=data-test-id="snippet-shopping|Ships (?:within|from))/) || ["", ""])[1]).replace(/<button[\s\S]*?<\/button>/g, ""));
    const shipsFrom = g(/(Ships (?:within|from)[^<]{0,80})</);
    const p = moneyOf(g(/data-test-id="listing-price"[^>]*>([^<]*)</));
    let ship: number | null = null, assumed = false;
    if (/free shipping/i.test(shipTxt)) ship = 0; else { const sm = moneyOf(shipTxt); if (sm) ship = sm.v; }
    if (ship === null) { ship = 4.5; assumed = true; }
    out.push({ id, title: g(/data-test-id="listing-title"[^>]*>([\s\S]*?)<\/h2>/), seller: g(/data-test-id="seller-info"[^>]*>([\s\S]*?)<\/p>/).replace(/^Seller:\s*/, ""),
      cond: g(/data-test-id="listing-condition"[^>]*>([^<]*)</), cur: p?.cur || "", price: p?.v ?? 0, ship, ship_assumed: assumed,
      us: /Ships within U\.S\.A/i.test(shipsFrom), ships_from: shipsFrom, binding: attrs.find((a) => /hardcover|softcover|paperback|spiral|leather/i.test(a)) || "",
      attrs, publisher: pub, year: (pub.match(/\b(1[5-9]\d\d|20\d\d)\b/) || [])[1] || "",
      desc: g(/data-test-id="description-\d+"[^>]*>([\s\S]*?)<\/(?:p|div)>/).slice(0, 220),
      url: `https://www.abebooks.com/servlet/BookDetailsPL?bi=${id}` });
  }
  return out;
}
async function abeListings(isbn: string, title: string, author: string) {
  const u = new URL("https://www.abebooks.com/servlet/SearchResults");
  if (isbn) u.searchParams.set("isbn", isbn); else { if (!title) return { weak: true, rows: [] as any[], url: "" }; u.searchParams.set("tn", title.slice(0, 80)); if (author) u.searchParams.set("an", author.split(/[;,&]| and /)[0].slice(0, 40)); }
  u.searchParams.set("sortby", "17"); u.searchParams.set("ds", "30");
  try {
    const r = await fetch(u, { headers: ABE_UA });
    if (!r.ok) return { weak: !isbn, rows: [], url: String(u), error: "AbeBooks answered " + r.status };
    return { weak: !isbn, rows: parseAbe(await r.text()), url: String(u) };
  } catch (e) { return { weak: !isbn, rows: [], url: String(u), error: String((e as Error).message).slice(0, 120) }; }
}
const PTS = (g: string): number | null => {
  const t = String(g || "").toLowerCase();
  if (!t || t === "used") return null;
  if (/brand new|^new|\bnew\b(?!.*used)/.test(t) && !/like new|as new|used/.test(t)) return 5;
  if (/like new|as new|\bfine\b(?!.*near)/.test(t) && !/near fine/.test(t)) return 4;
  if (/near fine|very good\s*\+|vg\+/.test(t)) return 3.5;
  if (/very good/.test(t)) return 3;
  if (/\bgood\b/.test(t)) return 2;
  if (/acceptable|fair|poor|reading copy/.test(t)) return 1;
  return null;
};
const POS2: Record<number, number> = { 5: 0.95, 4: 0.85, 3.5: 0.65, 3: 0.5, 2: 0.2, 1: 0.1 };
const near99 = (x: number) => { const lo = Math.floor(x); const c = [lo - 1 + .99, lo + .99, lo + 1.99].reduce((b, v) => Math.abs(v - x) < Math.abs(b - x) ? v : b); return Math.max(0.99, +c.toFixed(2)); };
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const pct = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return 0; const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
// v22 Perplexity's changes (2026-10-17): grade vs condition notes, believable-new ceiling, below-floor rule, confidence score.
const PTS_NAME: Record<number, string> = { 5: "New", 4: "Like New", 3.5: "Very Good+", 3: "Very Good", 2: "Good", 1: "Acceptable" };
function gradeCap(flawText: string): { cap: number | null; why: string } {
  const t = String(flawText || "").toLowerCase();
  if (/water[- ]?damage|water[- ]?damaged|water[- ]?logged|warped from water|swollen from water/.test(t)) return { cap: 1, why: "water damage" };
  const m = t.match(/water|stain|\bring(s|ed)?\b|ring mark|moderate wear|creas/);
  return m ? { cap: 2, why: m[0] } : { cap: null, why: "" };
}
const SCORE_DEF: Record<string, number> = { anchors_2x: 30, anchors_15x: 15, old_new: 25, few_comps: 20, one_channel: 15, title_only: 15, edition_unclear: 15,
  ship_assumed: 10, slow: 10, at_edge: 10, grade_notes: 20, cut_save: 80, cut_hold: 50 };
function priceV2(o: { comps: Comp[]; judged: any[]; ourFmt: string; ourJacket: boolean; grade: string; isbn: string; weakAbe: boolean; amz: any; conf: any; oldList: number | null;
    listed?: boolean; flawText?: string; year?: string }) {
  const lean = Number(o.conf.price_abe_lean) || 0.60, shipCharge = Number(o.conf.price_ship_charge) || 4.50, minNet = Number(o.conf.price_min_net) || 5, minList = Number(o.conf.min_list_drafts) || 6.99;
  let SC = { ...SCORE_DEF }; try { SC = { ...SC, ...(typeof o.conf.price_score === "string" ? JSON.parse(o.conf.price_score) : (o.conf.price_score || {})) }; } catch (_) { /* defaults */ }
  const flags: string[] = [];
  const gradedPts = PTS(o.grade) ?? 2;
  const gc = gradeCap(o.flawText || "");
  const gradeMismatch = gc.cap !== null && gradedPts > gc.cap;
  const ourPts = gradeMismatch ? gc.cap! : gradedPts;          // price it as the grade the notes support
  if (gradeMismatch) flags.push(`grade and notes disagree: graded ${o.grade} but notes say ${gc.why} - priced as ${PTS_NAME[ourPts]}, suggest ${PTS_NAME[ourPts]}`);
  const rows = o.comps.map((c) => {
    const j = o.judged.find((x: any) => x.i === c.i) || {};
    const pts = c.ch === "abe" ? PTS(c.cond) : (PTS(c.cond) ?? PTS(j.grade));
    return { ...c, relevant: j.relevant !== false && !!j.fmt, fmt: j.fmt || "", jacket: !!j.jacket, why: j.why || (j.fmt ? "" : "not judged"), pts, total: +(c.price + (c.ship ?? 4.5)).toFixed(2) };
  });
  const kept: any[] = [], dropped: any[] = [];
  for (const r of rows) {
    let why = "";
    if (!r.relevant) why = r.why || "not the same book/edition";
    else if (r.fmt && o.ourFmt && r.fmt !== o.ourFmt.toLowerCase()) why = "binding " + r.fmt;
    else if (o.ourJacket && !r.jacket && r.ch === "ebay") why = "no dust jacket";
    else if (r.cur && r.cur !== "US$") why = "not priced in US$";
    else if (r.ch === "abe" && !r.us && (r.ship ?? 0) > 8) why = `ships from abroad, $${(r.ship ?? 0).toFixed(2)} shipping`;
    else if (r.pts !== null && r.pts < ourPts - 1) why = "worse condition";
    else if (r.pts === null) why = "condition unknown";
    if (why) dropped.push({ ...r, why }); else kept.push(r);
  }
  const med = median(kept.map((r) => r.total));
  for (const r of [...kept]) if (med > 0 && r.total > 5 * med) { kept.splice(kept.indexOf(r), 1); dropped.push({ ...r, why: "over 5x the median" }); }
  // cheapest new copy anywhere: AbeBooks / eBay new copies of the same edition + Amazon new
  const newTotalsAll = rows.filter((r) => r.relevant && r.pts === 5 && (!r.fmt || r.fmt === o.ourFmt.toLowerCase())).map((r) => r.total);
  if (o.amz?.new_low) newTotalsAll.push(+(o.amz.new_low + 3.99).toFixed(2));
  const usedTotals = kept.filter((r) => (r.pts ?? 0) < 5).map((r) => r.total);
  const usedMed = median(usedTotals);
  // v22: a "new" copy is believable only up to 3x the used median ($166 / $354 listings are ignored)
  const newTotals = usedMed > 0 ? newTotalsAll.filter((t) => t <= 3 * usedMed) : newTotalsAll;
  const newMin = newTotals.length ? Math.min(...newTotals) : null;
  const newIgnored = newTotalsAll.filter((t) => !newTotals.includes(t));
  const abe = kept.filter((r) => r.ch === "abe").sort((a, b) => a.total - b.total), eb = kept.filter((r) => r.ch !== "abe").sort((a, b) => a.total - b.total);
  const nA = abe.length, nE = eb.length;
  const abeAnchor = nA ? (nA >= 2 ? abe[1].total : abe[0].total) : null;
  const ebAnchor = nE ? median(eb.slice(0, 3).map((r) => r.total)) : null;
  let w = (lean * 5 + nA) / (5 + nA + nE);
  let anchor: number | null;
  if (abeAnchor !== null && ebAnchor !== null) anchor = w * abeAnchor + (1 - w) * ebAnchor;
  else if (abeAnchor !== null) { anchor = abeAnchor; w = 1; flags.push("single channel: AbeBooks only"); }
  else if (ebAnchor !== null) { anchor = ebAnchor; w = 0; flags.push("single channel: eBay only"); }
  else anchor = null;
  const assumedUsed = [...abe.slice(0, 3), ...eb.slice(0, 3)].some((r) => r.ship_assumed || r.ship === null);
  if (assumedUsed) flags.push("shipping assumed on a key comp");
  if (o.weakAbe || !o.isbn) flags.push("weak match: no ISBN, matched by title");
  const s180 = o.amz && typeof o.amz.sales180 === "number" ? o.amz.sales180 : null;
  const calc: any = { lean, w_abe: +w.toFixed(3), n_abe: nA, n_ebay: nE, abe_anchor: abeAnchor, ebay_anchor: ebAnchor, anchor: anchor === null ? null : +anchor.toFixed(2),
    new_low: newMin, new_ignored: newIgnored, sales180: s180, our_points: ourPts, graded_points: gradedPts, ship_charge: shipCharge };
  if (anchor === null) { flags.push("no comparable copies on AbeBooks or eBay"); return { ok: false, calc, flags, kept, dropped }; }
  const total = nA + nE;
  let target: number, floor: number, ceiling: number, position: number | null = null, rare = false;
  const abeMin = nA ? abe[0].total : null, ebMin = nE ? eb[0].total : null;
  floor = abeMin !== null && ebMin !== null ? w * abeMin + (1 - w) * ebMin : (abeMin ?? ebMin)!;
  const p75u = usedTotals.length ? pct(usedTotals, 0.75) : (newMin !== null ? newMin - 1 : floor);
  ceiling = newMin !== null ? Math.min(newMin - 1, p75u) : p75u;          // v22: the lower of believable new - $1 and the used 75th percentile
  if (ceiling < floor) ceiling = floor;
  if (newMin === null && total < 3) {
    rare = true;
    const closest = [...kept].sort((a, b) => Math.abs((a.pts ?? ourPts) - ourPts) - Math.abs((b.pts ?? ourPts) - ourPts) || a.total - b.total)[0];
    target = closest.total - 1; flags.push("rare: fewer than 3 comps and no new copy - review");
  } else {
    position = floor + (POS2[ourPts] ?? 0.35) * (ceiling - floor);
    target = 0.5 * anchor + 0.5 * position;
  }
  let speed = "no Amazon sales data";
  if (s180 !== null && !rare) {
    if (s180 >= 20) { target = Math.min(ceiling, target + 0.10 * (ceiling - floor)); speed = `fast (${s180} sold in 180 days): +10% of the range`; }
    else if (s180 >= 3) speed = `normal (${s180} sold in 180 days)`;
    else { if (target < anchor) target = anchor; speed = `slow (${s180} sold in 180 days): kept at or above the anchor`; flags.push("slow seller - review"); }
  }
  if (newMin !== null && target > newMin - 1) target = newMin - 1;
  // v22: a copy with disclosed flaws (stains, water, rings, wear, creases) must undercut cheaper copies in BETTER condition by $2
  let undercut: any = null;
  if (gc.cap !== null) {
    const better = kept.filter((r) => (r.pts ?? 0) > ourPts && (r.pts ?? 0) < 5).sort((a, b) => a.total - b.total)[0];
    if (better && target > better.total - 2) { undercut = { total: better.total, ch: better.ch, cond: better.cond }; target = better.total - 2; }
  }
  // v22 below-floor rule: market anchor under the minimum delivered price ($6.99 + shipping)
  const floorTot = minList + shipCharge;
  let cleanup = false, belowFloorSells = false;
  if (anchor < floorTot) {
    if ((s180 ?? 0) >= 3) belowFloorSells = true;
    else { cleanup = true; flags.push(`cleanup pile: market is about $${anchor.toFixed(2)} delivered (under $${floorTot.toFixed(2)}) and ${s180 === null ? "no Amazon sales data" : s180 + " sold in 180 days"} - lot, bundle or donate`); }
  }
  let list = near99(target - shipCharge);
  if (list < minList) { if (!belowFloorSells && !cleanup) flags.push(`under the $${minList.toFixed(2)} minimum (math said $${list.toFixed(2)})`); list = minList; }
  const tot = list + shipCharge;
  const netEbay = +(tot - 0.153 * (tot * 1.07) - (tot <= 10 ? 0.30 : 0.40) - shipCharge).toFixed(2);
  const abeCom = Math.min(40, Math.max(0.50, 0.08 * tot));                  // Premium: 8% of book + shipping (min $0.50, max $40) + 5.5% processing
  const netAbe = +(tot - abeCom - 0.055 * tot - shipCharge).toFixed(2);
  if (netEbay < minNet && !belowFloorSells && !cleanup) flags.push(`not worth listing: eBay net $${netEbay.toFixed(2)} is under $${minNet.toFixed(2)}`);
  const hi = kept.length ? Math.max(...kept.map((r) => r.total)) : 0;
  if (hi && tot > 2 * hi) flags.push("over 2x the highest comparable copy");
  if (total < 2) flags.push("fewer than 2 good comps");
  if (o.listed && o.oldList && Math.abs(list - o.oldList) / o.oldList > 0.40) flags.push(`more than 40% from the old price ($${o.oldList.toFixed(2)})`);
  // ---- Step 8b confidence score ----
  let score = 100; const lost: string[] = [];
  const minus = (k: string, why: string) => { score -= SC[k] || 0; lost.push(`-${SC[k] || 0} ${why}`); };
  if (abeAnchor && ebAnchor) { const r = Math.max(abeAnchor, ebAnchor) / Math.min(abeAnchor, ebAnchor); if (r > 2) minus("anchors_2x", "AbeBooks and eBay anchors differ more than 2x"); else if (r >= 1.5) minus("anchors_15x", "anchors differ 1.5-2x"); }
  if (o.listed && o.oldList && (list / o.oldList < 0.6 || list / o.oldList > 1.6)) minus("old_new", "new price is far from the old price");
  if (total < 3) minus("few_comps", "fewer than 3 good comps");
  if ((nA === 0) !== (nE === 0)) minus("one_channel", "only one channel had comps");
  if (o.weakAbe || !o.isbn) minus("title_only", "title-only match, no ISBN");
  if (!o.isbn && !o.year) minus("edition_unclear", "edition / printing unclear");
  if (assumedUsed) minus("ship_assumed", "shipping assumed on a comp used");
  if (s180 !== null && s180 <= 2) minus("slow", "slow seller");
  if (list === minList || Math.abs(target - floor) < 0.02 * Math.max(1, floor) || Math.abs(target - ceiling) < 0.02 * Math.max(1, ceiling)) minus("at_edge", "price sits at the floor or ceiling");
  if (gradeMismatch) minus("grade_notes", "grade and condition notes disagree");
  score = Math.max(0, Math.min(100, score));
  const hold = !cleanup && (score < SC.cut_hold || rare), low = !cleanup && !hold && score < SC.cut_save;
  Object.assign(calc, { floor: +floor.toFixed(2), ceiling: +ceiling.toFixed(2), p75_used: +p75u.toFixed(2), position: position === null ? null : +position.toFixed(2), target: +target.toFixed(2), rare, speed,
    undercut, grade_cap: gc.cap, grade_mismatch: gradeMismatch, below_floor_sells: belowFloorSells, cleanup,
    list, total: +tot.toFixed(2), net_ebay: netEbay, net_abe: netAbe, score, score_lost: lost, hold, low_confidence: low, check_price: flags.length > 0 });
  return { ok: true, list, calc, flags, kept, dropped, score, hold, low, cleanup, suggestedGrade: gradeMismatch ? PTS_NAME[ourPts] : null };
}

// ---------------- Blocks (§3) + validator (port of claude/validate-blocks.py) ----------------
const FOOTER = [
  "\u{1F986} Papa Duck Homeschool | Gresham, Oregon",
  "\"Every book opens a door to knowledge; wisdom begins when we step through it.\"",
  "\u{1F4E6} Ships via USPS Media Mail · \u{1F4CD} Gresham, Oregon · Questions welcome — we respond promptly and pack with care.",
];
const B1_FORBIDDEN = ["shipping", "ships ", "we ship", "returns", "return policy", "refund", "payment", "papa duck", "discount", "bargain",
  "great companion", "perfect for", "ideal for", "great for", "buy ", "purchase", "best offer"];
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const emojiLed = (s: string) => { const t = s.trim(); return !!t && t.codePointAt(0)! > 0x2000; };
function buildB2(t: any, grade: string): string {
  const details: string[] = (t.details || []).map((x: string) => String(x).trim()).filter(Boolean);
  let cond: string[] = (t.condition || []).map((x: string) => String(x).trim()).filter(Boolean);
  cond = [...cond.filter((x) => !x.startsWith("✅")), ...cond.filter((x) => x.startsWith("✅"))];   // must END on ✅
  const li = (x: string) => `<li>${esc(x)}</li>`;
  return `<div style="font-family:Georgia,serif;max-width:820px;line-height:1.6;color:#222">`
    + `<h2 style="color:#1E5B43">${esc(t.h2 || "")}</h2>`
    + `<p>${esc(t.intro || "")}</p>`
    + `<h3>\u{1F4DA} Book Details</h3><ul>${details.map(li).join("")}</ul>`
    + `<h3>\u{1F4CB} Condition: ${esc(grade)}</h3><ul>${cond.map(li).join("")}</ul>`
    + (t.closing ? `<p>${esc(t.closing)}</p>` : "")
    + (String(t.about_author || "").trim() ? `<h3>\u{270D}\u{FE0F} About the Author</h3><p>${esc(String(t.about_author).trim())}</p>` : "")
    + `<p>${FOOTER.map(esc).join("<br>")}</p></div>`;
}
function validate(b1: string, b2: string, title: string, grade: string): string[] {
  const f: string[] = [];
  const low = b1.toLowerCase();
  if (!b1.trim()) f.push("Block 1 is blank");
  if (/<[a-zA-Z/][^>]*>/.test(b1)) f.push("Block 1 must be plain text");
  if (/\$\s?\d/.test(b1)) f.push("Block 1 has a price in it");
  const hits = B1_FORBIDDEN.filter((w) => low.includes(w)); if (hits.length) f.push("Block 1 has eBay-forbidden words: " + hits.join(", "));
  if (!b1.startsWith(`${grade} as graded in hand`)) f.push(`Block 1 must start with exactly "${grade} as graded in hand"`);
  if (b1.length > 700) f.push(`Block 1 is ${b1.length} characters - keep it to 250-600, short and buyer-friendly`);
  // photo / uncertainty talk. Block 2 may legitimately say a book is "illustrated with photographs", so it gets the narrower list.
  const HEDGE_B2 = ["photographed", "in the photos", "in the photo", "pictured", "scanner", "scanned", "could not be", "cannot be", "can't be", "ruled out", "not confirmed", "unable to", "appears to", "appear to", "visible in"];
  const hedge = [...new Set([...["photograph", "observed"].concat(HEDGE_B2).filter((w) => b1.toLowerCase().includes(w)),
                             ...HEDGE_B2.filter((w) => b2.replace(/<[^>]+>/g, " ").toLowerCase().includes(w))])];
  if (hedge.length) f.push("Talks about photos or uncertainty, which buyers should never read (" + hedge.join(", ") + ") - state facts plainly and leave unknowns out");
  if (b2.length < 500) f.push(`Block 2 is only ${b2.length} characters (min 500) — the intro needs to be longer`);
  if (!b2.includes("Book Details")) f.push("Block 2 missing \"Book Details\"");
  if (/\$\s?\d/.test(b2)) f.push("Block 2 has a price or dollar amount in it (never allowed)");
  FOOTER.forEach((l, i) => { if (!b2.includes(esc(l)) && !b2.includes(l)) f.push(`footer line ${i + 1} missing`); });
  const lis = [...b2.matchAll(/<li[^>]*>\s*(.*?)\s*<\/li>/gs)].map((m) => m[1].replace(/<[^>]+>/g, ""));
  const bad = lis.filter((x) => !emojiLed(x)); if (bad.length) f.push(`${bad.length} list line(s) do not start with an emoji: ` + bad.slice(0, 2).join(" | "));
  const ci = b2.indexOf("\u{1F4CB}");
  const condLis = [...b2.slice(ci).matchAll(/<li[^>]*>\s*(.*?)\s*<\/li>/gs)].map((m) => m[1]);
  if (!condLis.length || !condLis[condLis.length - 1].trim().startsWith("✅")) f.push("Condition list must end on a ✅ line");
  if (!title.trim()) f.push("eBay title is blank");
  if (title.length > 80) f.push(`eBay title is ${title.length} characters (max 80)`);
  return f;
}

// ---------------- Claude ----------------
function prompt(d: any, grade: string, comps: Comp[], fix: string[]): string {
  const id = d.ident || {};
  const qa = (d.questions || []).map((q: any, i: number) => ({ q: q.q, a: (d.answers || {})[String(i)] || "(not answered yet)" }));
  const tell = String((d.answers || {}).tell || "").trim().slice(0, 6000);
  const ih = (d.answers || {}).inhand || {};
  const inhand = Object.fromEntries(Object.entries(ih).filter(([, v]: any) => v && v.on).map(([k, v]: any) => [k, { pct: v.pct || undefined, choice: v.pick || undefined, note: v.note || undefined }]));
  return `You are writing the eBay listing for ONE used book (or set) for Papa Duck Homeschool, Gresham, Oregon.

THE COPY IN HAND (identified from photos; Papa Duck may have corrected fields). condition_notes are the flaws Papa Duck CHECKED and wants disclosed, in his wording where he changed it - disclose exactly these; condition_skipped are things he checked in hand and says are NOT flaws - NEVER mention them anywhere:
${JSON.stringify({ ...id, grade_in_hand: grade, weight_lb: d.weight_lb, is_set: d.is_set }, null, 1)}

PAPA DUCK'S ANSWERS (facts from the man holding the book — disclose every flaw he reports in Block 1 AND the Condition list):
${JSON.stringify(qa, null, 1)}

${tell ? "PAPA DUCK'S OWN WORDS FOR THIS LISTING (he typed this himself - it is a FACT and an instruction; work every point into the listing: condition facts go in Block 1 AND the Condition list, anything else goes in the intro or Book Details; if it contradicts the photos, his words win):\n" + tell + "\n\n" : ""}PAPA DUCK'S IN-HAND CHECKLIST (he flipped the whole book; these are FACTS and beat anything guessed from photos; pct = percent of pages):
${Object.keys(inhand).length ? JSON.stringify(inhand, null, 1) : "(nothing ticked — describe only what the photos show)"}
Keys: highlight / pencil / ink (pct of pages), spine (damaged spine), stain (stained pages), foxing, water (water damage), odour (smell), loose (loose/detached pages), missing (something missing), first (FIRST EDITION), signed (SIGNED BY AUTHOR), old (printed before the year given), dj (DUST JACKET present, choice = jacket condition), insc (previous owner's inscription: choice "Leave it" = describe it honestly as provenance; "Black it out" = the name/details must NOT appear anywhere, and state in Block 1 AND Block 2 that the inscription has been obscured to protect the prior owner's privacy), bce (book club edition), remainder (remainder mark), exlib (ex-library), other.
Disclose every ticked flaw in Block 1 AND the Condition list. If first or signed is ticked, judge comps as a COLLECTIBLE (only first editions / signed copies are relevant) and say so in the listing. If dj is ticked, our copy HAS a jacket (our_jacket = true) and its condition goes in the Condition list. If bce is ticked only book club copies are relevant.
FOXING (Papa Duck 2026-10-11, "indicate foxing"): brown, tan or rust-colored age spots, speckling or browning on the paper - page edges, endpapers, title page or text pages - is FOXING. Whenever foxing is ticked, or Papa Duck's words, the condition notes or the identification mention foxing, brown spots, age spots, spotting, speckling or toning on the paper, CALL IT FOXING BY NAME in Block 1 AND as its own "⚠️" Condition line, saying where it is and how heavy (light, moderate or heavy), e.g. "Light foxing to the page edges and title page." Never call foxing "stains", "dirt" or "mold". If it is light and kept to the edges or preliminary pages, add that the text pages are otherwise clean.

WRITE THE LISTING (master §3; no price anywhere; no previous owner's name anywhere):
- ebay_title: at most 80 characters. Title + author + key identifiers (edition, format, HC/PB, year, ISBN-less keywords buyers search). No colons are fine, no ALL CAPS words except abbreviations, no "L@@K".
- b1 (Block 1, eBay Condition Description): written FOR THE BUYER by a confident seller who has the book in his hands. Plain text, 250-600 characters, 3-5 short sentences. It MUST begin with exactly "${grade} as graded in hand." Then state the physical facts plainly and specifically: cover, spine/binding, pages, and every flaw (from the photos, the answers, the checklist and his notes), each said once. End with ONE short, warm human line about the condition only.
  NEVER in Block 1 (or anywhere a buyer reads): anything about photos, scanning, lighting or what could or couldn't be seen or confirmed ("photographed", "scanner", "appear", "visible", "observed", "could not be confirmed", "cannot be ruled out"); bibliographic uncertainty (year, page count, edition) - that is not condition; hedging; repeating the grade words; marketing, audience, shipping, returns, payment, pricing, brand or seller-name words (eBay rejects them). If nothing is wrong with a part, say so briefly ("Pages are clean and tight").
  GOOD EXAMPLE: "Good as graded in hand. Light creasing and surface wear on the covers, with minor scuffing along the back edges. A small holiday sticker covers the barcode on the back. Pages are clean, bright and free of writing or highlighting, and the binding is tight. A sturdy, well-kept reading copy."
- h2: an emoji + the full book title for the heading.
- intro: a beefy, engaging narrative paragraph, 4–6 sentences: hook, context (who wrote it, why this book/edition matters, what's notable about this printing), and the sell. No bullets. Never invent facts you were not given, and never talk about photos or what couldn't be confirmed — if a detail is unknown, simply leave it out.
- details: list of lines, ONE emoji at the start of EACH line, in this order, skipping any you do not know: "✍️ Author: …", "🎨 Illustrated by: …", "🏢 Publisher: …", "📅 Year: …", "📄 Format: … (pages if known)", "🔖 ISBN: …" (only if given), "📖 Edition: …" (first edition / signed / intact dust jacket noted here), "✅ Best For: …" (audience + use cases).
- condition: list of lines, "⚠️ …" for each flaw and "✅ …" for each positive, mirroring Block 1 — never contradict it. At least one ✅ line.
- closing: one warm human sentence about this copy (no price, no shipping).
- about_author: ONE or TWO plain sentences (under 300 characters) about the author - who they were and what they are known for - ONLY when the author is well known and you are completely sure of every fact (no dates, awards or numbers you are not certain of). Leave it EMPTY ("") for textbooks, workbooks, homeschool curriculum, teacher guides, answer keys, corporate or committee authors, unknown authors, or whenever you are unsure. Never mention this copy, price or shipping here.
${fix.length ? `\nYOUR PREVIOUS ATTEMPT FAILED THESE CHECKS — FIX EVERY ONE:\n- ${fix.join("\n- ")}\n` : ""}
Respond with ONLY a JSON object, no markdown fences:
{"ebay_title":"","b1":"","h2":"","intro":"","details":[""],"condition":[""],"closing":"","about_author":""}`;
}
// the comp judge + Claude's price call — a short, separate call so it can run beside the listing writer
function judgePrompt(d: any, grade: string, comps: Comp[]): string {
  const id = d.ident || {};
  const ih = (d.answers || {}).inhand || {};
  const on = Object.entries(ih).filter(([, v]: any) => v && v.on).map(([k, v]: any) => k + (v.pick ? "=" + v.pick : ""));
  const tell = String((d.answers || {}).tell || "").trim().slice(0, 1500);
  return `You are Papa Duck's book pricer. Our copy:
${JSON.stringify({ title: id.title, author: id.author, publisher: id.publisher, year: id.year, isbn: id.isbn, format: id.format, edition: id.edition, dust_jacket: id.dust_jacket, is_set: d.is_set, set_books: id.set_books, grade_in_hand: grade })}
In-hand checklist ticks: ${on.join(", ") || "(none)"} (first = FIRST EDITION, signed = SIGNED, dj = has DUST JACKET, bce = book club edition, exlib = ex-library)
${tell ? "His notes: " + tell + "\n" : ""}
EBAY ACTIVE FIXED-PRICE COPIES (i, price + shipping, how many that listing has SOLD, seller's condition, title):
${comps.map((c) => `${c.i}\t${c.ch === "abe" ? "AbeBooks" : "eBay"}\t$${c.price.toFixed(2)}${c.ship ? " +$" + c.ship.toFixed(2) + " ship" : " free ship"}\t${c.sold ? c.sold + " sold" : "0 sold"}\t${c.cond || "-"}\t${c.title}${c.info ? "\t[" + c.info + "]" : ""}`).join("\n") || "(none found)"}

TASK 1 — JUDGE EVERY COMP (Rule BQ.2). Relevant ONLY if it is the SAME work in a comparable edition. Not relevant: a different book or volume, a lot or set when ours is single (or single when ours is a set), teacher/answer-key-only when ours is the student book (or vice versa), signed or true first editions when ours is neither (if first/signed is ticked, ONLY first/signed copies are relevant), Folio / Easton / leather gift editions, modern reprints of an older book, study guides, audiobooks, ebooks. If bce is ticked only book club copies are relevant. A NEW copy of the same book IS relevant - mark its grade n (it sets the price ceiling). ALSO NOT RELEVANT (r = 0, and say which in why): lots, sets and "choose your title" listings; print-on-demand, facsimile or reprint copies when ours is an original (and originals when ours is a reprint); book club editions when ours is not one; ex-library copies when ours is not one. AbeBooks rows show [binding | publisher, edition, year | description] - use them.
One line per comp in "c", compact: "i|r|fmt|j|grade|why" — r = 1 relevant or 0 not; fmt = h (hardcover) | p (paperback, incl. mass market) | s (spiral) | o (other); j = 1 if the title says dust jacket/DJ else 0; grade = ln | vg | g | a | n (new) | u (just "used"); why = 2-4 words, only when r = 0.
TASK 2 — our_format (hardcover | paperback | spiral | other), our_jacket (true if dj ticked or the identification says a jacket is present), band: durable (reference, classic curriculum, collectible) | standard | perishable (dated, trendy, stale workbooks).
fair_list: the list price YOU would set for this exact copy. ALWAYS give one, even when no copy above is a match or none were found: then price it from the closest similar items above and what you know this kind of item sells for used, and start fair_why with "No direct match:". A used copy must cost the buyer less, shipping included, than a new copy of the same book; place ours between the cheapest used and the cheapest new copy by grade. A number like 6.99, and fair_why in one short sentence.
TASK 3 — ETSY. etsy_rec: would THIS copy sell on Etsy as a vintage item? Etsy shoppers buy gifts, decor, nostalgia and collectibles, not reading copies. Recommend (true) for things like: vintage Bibles and hymnals (family Bibles, leather KJV, pocket New Testaments); attractive pre-1970 hardcovers with decorative / gilt / cloth covers; vintage illustrated children's books (Little Golden Books, old picture books); vintage school readers bought for nostalgia (Dick and Jane, McGuffey, 1950s-60s readers); vintage cookbooks; old Oregon / Pacific Northwest history. Do NOT recommend (false): plain reading copies that only just pass 20 years, 1990s-2000s reprints of older books, textbooks, homeschool curriculum or workbooks, modern Christian living paperbacks. etsy_why: one short plain sentence.
Respond with ONLY JSON: {"our_format":"hardcover","our_jacket":false,"band":"standard","fair_list":0,"fair_why":"","etsy_rec":false,"etsy_why":"","c":["1|1|h|0|g|","2|0|p|0|vg|different volume"]}`;
}
const FMT: Record<string, string> = { h: "hardcover", p: "paperback", s: "spiral", o: "other" };
const GRD: Record<string, string> = { ln: "like new", vg: "very good", g: "good", a: "acceptable", n: "new", u: "" };
function parseJudge(out: any): any[] {
  return (Array.isArray(out.c) ? out.c : []).map((line: any) => {
    const [i, r, f, j, g, ...w] = String(line).split("|");
    return { i: Number(i), relevant: r === "1", fmt: FMT[(f || "").trim()] || "", jacket: j === "1", grade: GRD[(g || "").trim()] ?? "", why: w.join("|").trim() };
  });
}
async function askClaude(text: string, model: string, maxTok = 3000): Promise<any> {
  let last = "";
  for (let a = 1; a <= 3; a++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTok, messages: [{ role: "user", content: text }] }) });
    const j = await r.json();
    if (r.ok) {
      const raw = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").replace(/```json|```/g, "").trim();
      try { return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); }
      catch { last = "answer was not JSON"; continue; }
    }
    last = `${r.status} ${JSON.stringify(j).slice(0, 200)}`;
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * a); continue; }
    break;
  }
  throw new Error("Claude call failed: " + last);
}

// ---------------- main ----------------
Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now();
  let id: number | null = null;
  let dry = 0;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (!cfg || req.headers.get("x-backup-secret") !== cfg.value) return json({ error: "not allowed" }, 403);
    const body = await req.json().catch(() => ({}));
    dry = Number(body?.dry || 0);
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    let d: any;
    if (dry) {   // v19 test mode: price this draft, change nothing
      [d] = await sql`select *, updated_at::text as stamp_txt from pipeline.drafts where id = ${dry}`;
      if (!d) return json({ ok: false, error: "no such draft" }, 404);
    } else {
      // claim: two workers must never price the same draft (price_claimed_at blocks it for 3 minutes)
      [d] = await sql`update pipeline.drafts set price_attempts = price_attempts + 1, price_claimed_at = now()
        where id = (select id from pipeline.drafts
                    where status in ('drafted','sent') and built_at is null and price_stale and price_attempts < 3 and ident is not null
                      and updated_at < now() - interval '20 seconds'
                      and (price_claimed_at is null or price_claimed_at < now() - interval '3 minutes')
                    order by updated_at limit 1 for update skip locked)
        returning *, updated_at::text as stamp_txt`;
      if (!d) return json({ ok: true, idle: true, note: "nothing waiting for a price" });
      id = Number(d.id);
    }
    const stamp = String(d.stamp_txt);
    const ident = d.ident || {};
    const grade = String(ident.grade || "Good").trim();

    const model = conf.claude_model || "claude-sonnet-4-6";
    // A) the listing writer starts NOW — it doesn't need the comps — and re-tries itself until the checks pass (skipped in test mode)
    const listingP = dry ? Promise.resolve({ b1: "", b2: "", title: "", fails: [] as string[] }) : (async () => {
      let fix: string[] = [], o: any = null, b1 = "", b2 = "", title = "", fails: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        o = await askClaude(prompt(d, grade, [], fix), model, 3000);
        b1 = String(o.b1 || "").trim(); title = String(o.ebay_title || "").trim(); b2 = buildB2(o, grade);
        fails = validate(b1, b2, title, grade);
        const aa = String(o.about_author || "").trim();
        if (aa.length > 350) fails.push(`About the Author is ${aa.length} characters - keep it to one or two sentences, under 300`);
        if (/\$\s?\d|papa duck|shipping|this copy/i.test(aa)) fails.push("About the Author must only be about the author (no price, shipping or this copy)");
        if (!fails.length || Date.now() - t0 > 110000) break;
        fix = fails;
      }
      return { b1, b2, title, fails };
    })();
    listingP.catch(() => null);   // a failure is re-thrown where it is awaited below

    // B) meanwhile: comps — all searches at once, then every sold counter at once, then the short judge call
    const tok = await ebayToken();
    const isbn = cleanIsbn(ident.isbn);
    const abeP = abeMarket(isbn).catch(() => null), kpP = keepaMarket(sql, isbn, grade).catch(() => null);   // run alongside eBay
    const useV2 = !!dry || String(conf.pricing_rule || "") === "v2";
    const abeLP: Promise<any> = useV2 ? abeListings(isbn, String(ident.title || ""), String(ident.author || "")).catch((e) => ({ rows: [], weak: !isbn, error: String(e) })) : Promise.resolve(null);
    const tidy = (s: string) => s.replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
    const titleQ = tidy([ident.title, ident.author ? String(ident.author).replace(/^(editors?|edited by|compiled by)\s*:?\s*/i, "").split(/[;,&]| and /)[0] : ""].filter(Boolean).join(" "));
    const brand = pubBrand(ident.publisher);
    const pubQ = ident.title && brand ? tidy(`${brand} ${ident.title}`) : "";        // v15: how sellers actually list curriculum
    const queries: string[] = [...new Set([isbn, titleQ, pubQ].filter(Boolean))];
    const results = await Promise.all(queries.map((q) => browse(tok, q, q !== isbn)));
    const seen = new Map<string, any>();
    for (const x of results.flat()) if (!seen.has(x.itemId)) seen.set(x.itemId, x);
    const comps: Comp[] = [...seen.values()].filter((x) => x.price && +x.price.value > 0).slice(0, 60).map((x, k) => ({
      i: k + 1, id: x.itemId, title: String(x.title || ""), price: +x.price.value,
      ship: x.shippingOptions?.[0]?.shippingCost ? +x.shippingOptions[0].shippingCost.value : null,
      cond: String(x.condition || ""), url: String(x.itemWebUrl || "").split("?")[0], sold: 0,
      ch: "ebay", seller: String(x.seller?.username || ""), cur: x.price?.currency === "USD" ? "US$" : String(x.price?.currency || ""),
      ship_assumed: !x.shippingOptions?.[0]?.shippingCost }));
    await soldCounts(tok, comps);
    const abeL: any = await abeLP;
    if (useV2 && abeL?.rows?.length) {
      for (const a of abeL.rows.slice(0, 30)) comps.push({ i: comps.length + 1, id: "abe" + a.id, title: a.title, price: a.price, ship: a.ship, cond: a.cond, url: a.url, sold: 0,
        ch: "abe", seller: a.seller, us: a.us, ship_assumed: a.ship_assumed, cur: a.cur,
        info: [a.binding, a.publisher, a.ships_from, a.attrs.filter((t: string) => t !== a.binding).join(", "), a.desc].filter(Boolean).join(" | ").slice(0, 300) });
    }
    const out: any = await askClaude(judgePrompt(d, grade, comps), conf.judge_model || model, 3000);   // v16: always asked, so there is always a fair_list
    const jl = parseJudge(out);
    const { b1, b2, title, fails } = await listingP;
    const judged: Judged[] = comps.map((c) => {
      const j: any = jl.find((x: any) => x.i === c.i) || {};
      return { ...c, relevant: j.relevant !== false && !!j.fmt, why: j.why || (j.fmt ? "" : "not judged"), fmt: j.fmt || "", jacket: !!j.jacket, grade: j.grade || "" };
    });
    // v22: the flaws to check the grade against = the Condition list's warning lines + his own words + his in-hand ticks
    const b2src = String(b2 || d.pricing?.b2 || "");
    const warnLines = [...b2src.matchAll(/<li[^>]*>\s*(⚠[^<]*)<\/li>/g)].map((m) => m[1]).join(" ");
    const ihOn = Object.entries((d.answers || {}).inhand || {}).filter(([, v]: any) => v && v.on).map(([k, v]: any) => ({ water: "water damage", stain: "stained pages" } as any)[k] ? ({ water: "water damage", stain: "stained pages" } as any)[k] + " " + (v.note || "") : "").join(" ");
    const flawText = [warnLines, ihOn, String((d.answers || {}).tell || "").replace(/^FROM THE BOOK STATION[^\n]*\n?/, "")].join(" ");
    const v2 = useV2 ? priceV2({ comps, judged: jl, ourFmt: String(out.our_format || ident.format || "paperback"), ourJacket: !!out.our_jacket, grade, isbn,
      weakAbe: !!abeL?.weak, amz: await kpP, conf, oldList: Number(d.pricing?.list) || null, listed: !!d.built_at, flawText,
      year: String(ident.publication_year || ident.year || "") }) : null;
    let pr: any = priceFromComps(judged.filter((c) => c.ch !== "abe"), String(out.our_format || ident.format || "paperback"), !!out.our_jacket, grade.toLowerCase(), String(out.band || "standard"), Number(out.fair_list) || 0, Number(conf.min_list_drafts) || 6.99);
    // v16 — NEVER LEAVE A BOOK HANGING: no matching copy on eBay -> Claude's own call becomes the price, clearly marked.
    const fairOnly = Number(out.fair_list) || 0;
    if (pr.error && fairOnly > 0) {
      const lst = +up99(fairOnly).toFixed(2);
      const band = lst < 12 ? "low" : (BANDS[String(out.band)] ? String(out.band) : "standard");
      const auto = r50(lst * 0.80), mn = r50(lst * BANDS[band]);
      pr = { list: lst, auto, min: mn, avg: null, median: null, sold_avg: null, sold_total: 0, fair: fairOnly, basis: "Claude's call (no direct eBay match)",
        low: null, high: null, n: 0, band, no_comps: true, problems: mn <= auto && auto < lst ? [] : [`Min ≤ Auto < List failed (${mn}/${auto}/${lst})`],
        note: `NO DIRECT eBAY MATCH (v16): ${comps.length} eBay listings found, none the same item in the same format. Claude's call $${fairOnly.toFixed(2)} -> listed $${lst.toFixed(2)}. ${String(out.fair_why || "")} Auto 80% $${auto.toFixed(2)}, Min ${band} band $${mn.toFixed(2)}.`,
        used: [], outliers: [], dropped: pr.dropped || [] };
    }
    const cmp = (r: any) => ({ ch: r.ch === "abe" ? "AbeBooks" : "eBay", seller: (r.seller || "").slice(0, 40), cond: r.cond, pts: r.pts, price: r.price, ship: r.ship,
      ship_assumed: !!r.ship_assumed, total: r.total, fmt: r.fmt, why: r.why || "", info: (r.info || "").slice(0, 120), title: (r.title || "").slice(0, 70), url: r.url });
    if (dry) return json({ ok: true, dry: true, draft: dry, pd: d.pd, title: ident.title, grade, format: out.our_format, jacket: !!out.our_jacket, isbn,
      old_list: d.pricing?.list ?? null, v19_list: pr.list ?? null, v2: v2 ? { list: v2.list ?? null, ok: v2.ok, flags: v2.flags, calc: v2.calc, score: v2.score ?? null,
        hold: v2.hold ?? null, low: v2.low ?? null, cleanup: v2.cleanup ?? null, suggested_grade: v2.suggestedGrade ?? null, flaw_text: flawText.slice(0, 400),
        kept: v2.kept.sort((a: any, b: any) => a.total - b.total).map(cmp), dropped: v2.dropped.map(cmp) } : null,
      abe_url: abeL?.url, abe_error: abeL?.error, amazon: await kpP, fair: Number(out.fair_list) || null, secs: Math.round((Date.now() - t0) / 1000) });
    if (v2 && String(conf.pricing_rule || "") === "v2") {     // live v2 (only after Papa Duck's OK)
      if (v2.ok && v2.list) {
        const band = v2.list < 12 ? "low" : (BANDS[String(out.band)] ? String(out.band) : "standard");
        const auto = r50(v2.list * 0.80), mn = r50(v2.list * BANDS[band]);
        pr = { ...pr, list: v2.list, auto, min: mn, band, basis: "Pricing Rule v2", v2: v2.calc, check_price: v2.flags, confidence: v2.score,
          low_confidence: v2.low ? v2.calc.score_lost : null, price_hold: !!v2.hold, cleanup: v2.cleanup ? (v2.flags.find((f: string) => f.startsWith("cleanup pile")) || "cleanup pile") : null,
          suggested_grade: v2.suggestedGrade ?? null,
          note: `PRICING RULE v2: anchor $${v2.calc.anchor} (AbeBooks $${v2.calc.abe_anchor ?? "-"} x ${v2.calc.w_abe} + eBay $${v2.calc.ebay_anchor ?? "-"}), range $${v2.calc.floor}-$${v2.calc.ceiling}, target $${v2.calc.target} -> list $${v2.list}. ${v2.calc.speed}.` + (v2.flags.length ? " CHECK PRICE: " + v2.flags.join("; ") + "." : ""),
          used: v2.kept.map(cmp), dropped: v2.dropped.map(cmp), problems: mn <= auto && auto < v2.list ? [] : [`Min ≤ Auto < List failed (${mn}/${auto}/${v2.list})`] };
        delete pr.error;
      } else pr = { ...pr, check_price: v2.flags, price_hold: true, confidence: 0 };
      // Step 8c: under 50 (or rare / no comps) -> Perplexity's review table, reviewer claude, status waiting. Blast off skips it until approved.
      if (pr.price_hold) {
        const [open] = await sql`select id from pipeline.price_review where draft_id = ${d.id} and status in ('waiting','needs_papa_duck','reviewed') limit 1`;
        const ev = { title: ident.title, author: ident.author, year: ident.publication_year || ident.year || null, edition: ident.edition || null, grade, isbn: isbn || null,
          comps: v2.kept.map(cmp), dropped: v2.dropped.slice(0, 40).map(cmp), abe_anchor: v2.calc.abe_anchor, ebay_anchor: v2.calc.ebay_anchor, w_abe: v2.calc.w_abe,
          floor: v2.calc.floor, ceiling: v2.calc.ceiling, proposed: v2.list ?? null, score: v2.score ?? 0, problems: [...(v2.calc.score_lost || []), ...v2.flags], checked_at: new Date().toISOString() };
        if (open) await sql`update pipeline.price_review set recommended_price = ${v2.list ?? null}, confidence = ${v2.score ?? 0}, evidence = ${sql.json(ev)},
            suggested_grade = ${v2.suggestedGrade ?? null}, reason = ${"Claude v2: " + (v2.flags.join("; ") || "low confidence")} where id = ${open.id} and status = 'waiting' and reviewer = 'claude'`;
        else await sql`insert into pipeline.price_review (pd, draft_id, current_price, recommended_price, suggested_grade, confidence, reason, evidence, reviewer, status)
            values (${d.pd}, ${d.id}, ${Number(d.price_override || d.pricing?.list) || null}, ${v2.list ?? null}, ${v2.suggestedGrade ?? null}, ${v2.score ?? 0},
                    ${"Claude v2: " + (v2.flags.join("; ") || "low confidence")}, ${sql.json(ev)}, 'claude', 'waiting')`;
      }
    }
    const ebayAll = comps.map((c) => c.price).sort((a, b) => a - b);
    const market = {
      ebay: { n: pr.n ?? 0, low: pr.low ?? null, avg: pr.avg ?? null, high: pr.high ?? null, sold: pr.sold_total ?? 0, sold_avg: pr.sold_avg ?? null, found: comps.length,
              all_low: ebayAll[0] ?? null, all_high: ebayAll[ebayAll.length - 1] ?? null },
      abe: await abeP, amazon: await kpP, at: new Date().toISOString() };
    // Etsy recommendation (v14): Claude's call, then the hard 20-year gate in code
    const yr = Number((String(ident.publication_year || "").match(/(1[5-9]\d\d|20\d\d)/) || [])[1]) || 0;
    const cutoff = new Date().getFullYear() - 20;
    let etsyRec = { rec: !!out.etsy_rec, why: String(out.etsy_why || "").slice(0, 200), year: yr || null, at: new Date().toISOString() };
    if (!yr) etsyRec = { ...etsyRec, rec: false, why: "No confirmed year — Etsy only takes books 20+ years old." };
    else if (yr > cutoff) etsyRec = { ...etsyRec, rec: false, why: `${yr} is too new for Etsy (needs ${cutoff} or older).` };
    else if (d.channel === "amazon") etsyRec = { ...etsyRec, rec: false, why: "Amazon-only book." };
    const pricing = { ...pr, market, fair_why: String(out.fair_why || ""), grade, our_format: out.our_format, our_jacket: !!out.our_jacket, queries, found: comps.length,
      ebay_title: title, b1, b2, checks_failed: fails, model, at: new Date().toISOString() };

    // don't overwrite if he edited the draft while we were working — it will be re-priced next minute. A description that still fails its checks is retried (price_attempts caps it at 3).
    const res = await sql`update pipeline.drafts set pricing = ${sql.json(pricing)}, etsy_rec = ${sql.json(etsyRec)}, priced_at = now(), price_claimed_at = null,
        price_stale = (updated_at::text <> ${stamp}) or ${fails.length > 0}, price_attempts = case when updated_at::text <> ${stamp} then 0 else price_attempts end
      where id = ${id} returning price_stale`;
    return json({ ok: true, draft: id, title: ident.title, found: comps.length, list: pr.list ?? null, n: pr.n ?? 0,
      error: pr.error || null, checks_failed: fails, restale: res[0]?.price_stale, secs: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 800);
    if (id && !dry) await sql`update pipeline.drafts set pricing = coalesce(pricing, '{}'::jsonb) || ${sql.json({ error: "Pricing failed: " + msg, at: new Date().toISOString() })},
        price_stale = price_attempts < 3, price_claimed_at = null where id = ${id}`;
    return json({ ok: false, draft: id || dry, error: msg }, 500);
  } finally { await sql.end({ timeout: 5 }); }
});
