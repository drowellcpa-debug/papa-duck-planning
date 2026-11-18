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
      if (c && c.result?.v === 4) base = c.result;
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
      if (abe.n > 0) stores.push({ store: "AbeBooks", sells: abe.avg, selling: `${abe.n} ${abe.n === 1 ? "copy" : "copies"} listed`, proven: false });
      const p = kp2 || null;
      base = {
        ident: { title: id.title || idTitle, author: id.author || idAuthor, isbn: isbn || digits(id.isbn), format: id.format || cover?.format || "", publisher: id.publisher || "",
                 edition: cover?.edition || id.edition || "", tgatb: !!id.tgatb },
        stores, scout_verdict: sc.verdict, scout_reason: sc.reason, hard: sc.hard || [], flags: (sc.flags || []).slice(0, 6), family: sc.family || "",
        amazon: { asin: p?.asin || sc.amazon?.asin || "", rank: amz.rank || null, sales90: amz.sales90 ?? null, offers: p?.stats?.current?.[12] > 0 ? p.stats.current[12] : null,
                  title: p?.title || "", image: p?.images?.[0]?.l ? "https://m.media-amazon.com/images/I/" + p.images[0].l : p?.imagesCSV ? "https://m.media-amazon.com/images/I/" + String(p.imagesCSV).split(",")[0] : "" },
        chart: p ? { price: priceSeries, rank: series(p.csv?.[3], false), years: 3, m3 } : null, v: 4,
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
    const best = proven[0] || stores[0] || null;   // proven stores first; AbeBooks / unproven are only shown
    if (best) best.best = true;
    const hard = [...(base.hard || [])];
    if (base.ident.tgatb && !hard.some((h: string) => /Good and the Beautiful/.test(h))) hard.unshift("🚨 The Good and the Beautiful — never list");
    const [mp] = await sql`select value from pipeline.config where key = 'hunter_min_profit'`;
    const minP = Number(mp?.value) || 20;
    let verdict = "PASS", why = "";
    const bp = best ? best.profit : 0;
    if (hard.length) { verdict = "PASS"; why = hard[0]; }
    else if (!best) { verdict = "PASS"; why = "Not found for sale anywhere"; }
    else if (!best.proven) { verdict = "PASS"; why = "No proof it sells on eBay or Amazon"; }
    else if (bp >= minP) { verdict = "BUY"; why = `Sells on ${best.store}` + (best.store === "Amazon" && best.median3 ? " · 3-year price holds" : ""); }
    else { verdict = "PASS"; why = bp > 0 ? `Profit under $${minP}` : "Costs more than it sells for"; }
    const amzRow = stores.find((s: any) => s.store === "Amazon");
    if (amzRow && amzRow.now && amzRow.median3 && amzRow.now > amzRow.median3 * 1.3) amzRow.note = `today $${amzRow.now.toFixed(2)} is high: 3-year middle is $${amzRow.median3.toFixed(2)}`;
    const out = { ok: true, ...base, verdict, why, cost, best: best ? { store: best.store, profit: best.profit, sells: best.sells } : null, stores, hard };
    await sql`insert into hunter.checks (url, isbn, title, cost, verdict, best_store, best_profit, result)
      values (${String(b.url || "").split("?")[0] || null}, ${base.ident.isbn || null}, ${base.ident.title || title || null}, ${cost}, ${verdict}, ${best?.store || null}, ${best?.profit ?? null}, ${sql.json(base)})`;
    return json(out);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
