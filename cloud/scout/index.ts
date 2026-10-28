// Papa Duck — SCOUT. Phone page -> this function.
// v25 (2026-10-28): NON-BOOKS too ("the scout app has to have the ability to read non books and give me buy or not" — cups, jewelry,
//   miniature houses, games...). Claude says kind "book" or "item". Items: eBay searched by keywords in ALL categories (not Books),
//   an item-matching judge, eBay sold counters, priced the same way, net with Ground Advantage shipping. AbeBooks / Amazon / buyback skipped.
//   Books follow exactly the v24 path.
// v24 (09-26): priced like the chat / Drafts method — ISBN + title searches, sold counts, list = max(average, median, where copies sell, Claude's call), rounded UP to .99.
//   No shipping taken off, no track-record cut, no cheapest-copy pricing. Returns a 'grid' (eBay / AbeBooks / Amazon) like the Drafts page.
//   evaluate : photo -> Claude identifies -> eBay listings + their SOLD counters (same as papaduck_ebay.py --sold) -> BUY / PASS
//   bought   : photo -> imgbb -> pipeline.scout_buys (never lost) -> copy to Airtable "Scout Buys"
//   lookup   : photo or ISBN -> finds the book in scout_buys (where bought, what paid)
// Auth: body.pin must match backup.config.scout_pin. Secrets: ANTHROPIC_API_KEY, EBAY_CLIENT_ID/SECRET, IMGBB_KEY, AIRTABLE_TOKEN.
// Never writes to the Inventory table.
import postgres from "npm:postgres@3.4.4";

const BASE = "appdMXzb9U4sdXpAr";
const TABLE = "tblu3Bh6ntFUzsWR3"; // Scout Buys
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- his numbers ----------
// Default cost per store (sourcing-rates). Goodwill splits by format.
function defaultCost(store: string, format: string): number | null {
  const s = (store || "").toLowerCase();
  const hc = /hard/i.test(format || "");
  if (s === "goodwill") return hc ? 2.75 : 1.75;
  if (s === "goodwill bins") return 2.75;
  if (s === "st vincent") return 1.5;
  if (s === "exodus") return 0.6;
  return null;
}
// Buy when net >= $3.00. Buyer pays shipping (Media Mail calculated).
// He carries eBay's 13% fee + his 10% promoted-listing fee, both on item AND shipping, plus $0.30.
const FEE = 0.13, PROMO = 0.10;
function netOf(list: number, cost: number, weight: number) {
  const ship = weight >= 5 ? 6.5 : weight >= 2 ? 5.5 : 4.5;
  return +((list + ship) * (1 - FEE - PROMO) - ship - 0.3 - cost).toFixed(2);
}
// Non-book items ship USPS Ground Advantage (calculated, buyer pays) — a bigger shipping charge than Media Mail, same fee math.
function netItem(list: number, cost: number, weight: number) {
  const ship = weight >= 5 ? 18 : weight >= 3 ? 13 : weight >= 2 ? 10 : 7;
  return +((list + ship) * (1 - FEE - PROMO) - ship - 0.3 - cost).toFixed(2);
}
const up99 = (x: number) => { const c = Math.ceil(x - 0.99 - 1e-9) + 0.99; return c < 0.99 ? 0.99 : +c.toFixed(2); };   // smallest .99 at or above x (same as Drafts)
const n99 = (x: number) => {
  const lo = Math.floor(x);
  return [lo - 1 + 0.99, lo + 0.99, lo + 1.99].reduce((b, v) => (Math.abs(v - x) < Math.abs(b - x) ? v : b));
};

// ---------- Claude ----------
async function claude(model: string, content: any, maxTokens = 1500): Promise<any> {
  let last = "";
  for (let a = 1; a <= 3; a++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
    });
    const j = await r.json();
    if (r.ok) {
      const raw = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").replace(/```json|```/g, "").trim();
      try { return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { last = "answer was not JSON"; continue; }
    }
    last = `${r.status} ${JSON.stringify(j).slice(0, 200)}`;
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * a); continue; }
    break;
  }
  throw new Error("Claude call failed: " + last);
}

const ID_PROMPT = `You are Papa Duck's book scout. He is standing in a store holding this book and needs to know what it is. Read the photo (cover, spine, copyright page or barcode — whatever is shown). Never invent a detail you cannot read; leave it blank.

Also check for his instant-pass red flags and set each true only if you can actually see evidence:
- tgatb: The Good and the Beautiful / Jenny Phillips material
- self_printed: looks photocopied, home-printed or home-bound from a PDF
- ex_library: library stickers, stamps, call-number labels, card pockets, barcodes, Mylar wrap
- book_club: book club edition (no price on jacket, "Book Club Edition", small blind-stamp)
- international_edition: "International Edition", "Not for sale in the USA"
- college_custom: Pearson / McGraw-Hill custom or college-specific edition
- imagination_library: Dolly Parton Imagination Library seal
- occult: occult / witchcraft / tarot subject

FAMILY-FRIENDLY CHECK: Papa Duck Homeschool is a Christian, family-friendly shop. Set family_friendly=false (with a short family_note saying why) if the cover, title, publisher or what you know of this book's content shows: erotica or graphic sexual content, sexually suggestive covers, gratuitous gore or torture, content built around heavy profanity, drug glorification, or adult humor. Mainstream adult fiction with some mature themes is fine unless it is known for explicit content. When in doubt and the evidence is real, flag it — he decides.

NOT A BOOK? Papa Duck also buys and sells non-book items (cups and mugs, jewelry, miniature houses and village pieces, games and puzzles, figurines, collectibles, dishes, toys...). If the photo shows something that is NOT a book, magazine or printed booklet, set "kind":"item" and:
- title: a clear eBay-style name for THIS item: maker/brand + line/pattern/series + what it is + size/count/color (e.g. "Department 56 Snow Village Bakery Lighted House 1992", "Pfaltzgraff Yorktowne Coffee Mug Blue", "Sterling Silver Turquoise Cuff Bracelet Southwest")
- author/publisher/isbn/edition: leave blank. format: "Other". year: the year or decade if marked or clearly known.
- item: fill what you can SEE or read (maker marks on the bottom, hallmarks like 925/14K, box labels, model numbers). Never invent a maker or a hallmark.
- search: the best eBay search words for THIS exact item (maker + line/pattern + item type), no punctuation.
- weight_lb: shipping weight in whole pounds rounded up, packed.
Family-friendly and occult checks apply to items too.

Respond with ONLY JSON, no fences:
{"kind":"book | item",
 "item":{"type":"","maker":"","line_or_pattern":"","material":"","era":"","color":"","size":"","marks":"","complete":"","box":""},
 "title":"","author":"","publisher":"","year":"","isbn":"","format":"Paperback | Hardcover | Spiral | Other","edition":"","dust_jacket":false,
 "is_set":false,"weight_lb":1,"subject":"",
 "family_friendly":true,"family_note":"",
 "tgatb":false,"self_printed":false,"ex_library":false,"book_club":false,"international_edition":false,"college_custom":false,"imagination_library":false,"occult":false,
 "search":"best eBay search words for THIS exact book (title + author surname), no punctuation",
 "confidence":"high | medium | low","notes":"one short line: anything notable (first edition, signed, vintage, curriculum brand, or what you could not read)"}`;

// ---------- SHELF: one photo of 1-2 shelves -> every spine, in order, so he can find the good ones ----------
const SHELF_PROMPT = `Papa Duck is in a thrift store looking at a bookshelf. This photo shows one or two shelves of books, spines out.
Read EVERY spine on each shelf, in order from LEFT to RIGHT. Shelves go from top to bottom (shelf 1 is the top shelf in the photo).
Include every book you can see, even ones you cannot read, so the positions stay correct for counting. For an unreadable spine give title "" and readable false, with a short look note (color, thickness).
Books lying flat or stacked sideways: list each one in the order they sit, with note "lying flat".
Never invent a title. If you can read part of it, give just that part and readable "partial".
Respond with ONLY JSON, no fences:
{"shelves":[{"shelf":1,"books":[{"pos":1,"title":"","author":"","readable":"yes | partial | no","look":"short color/size note","format":"Hardcover | Paperback | Other"}]}],
 "notes":"one short line about the photo (glare, too far, cut off)"}`;

// One or more photos of the SAME book (cover, copyright page, barcode, spine) -> one identification
type Shot = { data: string; mt?: string };
function shotsOf(body: any): Shot[] {
  const list: Shot[] = Array.isArray(body.images) ? body.images.filter((x: any) => x && x.data).slice(0, 4) : [];
  if (!list.length && body.image) list.push({ data: body.image, mt: body.mt });
  return list;
}
async function identify(model: string, shots: Shot[]) {
  const many = shots.length > 1;
  return await claude(model, [
    ...shots.map((x) => ({ type: "image", source: { type: "base64", media_type: x.mt || "image/jpeg", data: x.data } })),
    { type: "text", text: (many ? `These ${shots.length} photos are all of the SAME book (for example the cover, the copyright page and the barcode). Combine what they show into one identification; the copyright page and barcode are the most reliable for ISBN, edition and year.\n\n` : "") + ID_PROMPT },
  ]);
}

// ---------- eBay ----------
async function ebayToken(): Promise<string> {
  const id = (Deno.env.get("EBAY_CLIENT_ID") || "").trim(), sec = (Deno.env.get("EBAY_CLIENT_SECRET") || "").trim();
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(`${id}:${sec}`) },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("eBay token refused: " + (j.error_description || r.status));
  return j.access_token;
}
async function browse(tok: string, q: string, cat: boolean): Promise<any[]> {
  const u = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  u.searchParams.set("q", q.slice(0, 100));
  u.searchParams.set("limit", "40");
  u.searchParams.set("filter", "buyingOptions:{FIXED_PRICE},priceCurrency:USD,itemLocationCountry:US");
  if (cat) u.searchParams.set("category_ids", "267");
  for (let a = 1; a <= 3; a++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
    if (r.ok) return (await r.json()).itemSummaries || [];
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * a); continue; }
    throw new Error(`eBay search refused (${r.status})`);
  }
  return [];
}
const cleanIsbn = (s: string) => { const d = String(s || "").replace(/[^0-9Xx]/g, ""); return d.length === 10 || d.length === 13 ? d.toUpperCase() : ""; };

async function comps(ident: any, tok: string) {
  const isbn = cleanIsbn(ident.isbn);
  const q = String(ident.search || [ident.title, ident.author].filter(Boolean).join(" ")).replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const seen = new Map<string, any>();
  // both searches every time (same as Drafts): the ISBN finds sellers who filled in the ISBN, the title finds everyone else
  const isItem = ident.kind === "item";   // non-books: every category, never the Books category
  const [a, b] = await Promise.all([isbn && !isItem ? browse(tok, isbn, false).catch(() => []) : Promise.resolve([]), q ? browse(tok, q, !isItem).catch(() => []) : Promise.resolve([])]);
  for (const x of [...a, ...b]) if (!seen.has(x.itemId)) seen.set(x.itemId, x);
  return [...seen.values()].filter((x) => x.price && +x.price.value > 0).slice(0, 60).map((x, k) => ({
    i: k + 1, id: String(x.itemId || ""), seller: String(x.seller?.username || ""), title: String(x.title || ""), price: +x.price.value, cond: String(x.condition || ""),
    ship: x.shippingOptions?.[0]?.shippingCost ? +x.shippingOptions[0].shippingCost.value : 0,
    url: String(x.itemWebUrl || "").split("?")[0],
  }));
}

// ---------- SOLD counters (same method as papaduck_ebay.py --sold) ----------
// eBay's item call reports estimatedSoldQuantity: copies that actually sold off that listing.
async function soldCounts(tok: string, items: any[]) {
  await Promise.all(items.map(async (c) => {
    try {
      const r = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(c.id)}?fieldgroups=PRODUCT`,
        { headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
      if (!r.ok) { c.sold = null; return; }
      const j = await r.json();
      const av = j.estimatedAvailabilities?.[0] || {};
      c.sold = Number(av.estimatedSoldQuantity ?? 0) || 0;
      c.seller = j.seller?.username || c.seller || "";
      if (!c.ship && j.shippingOptions?.[0]?.shippingCost) c.ship = +j.shippingOptions[0].shippingCost.value || 0;
    } catch { c.sold = null; }
  }));
  return items;
}

// ---------- AbeBooks fallback (public search page carries schema.org offers) ----------
const DIAG: Record<string, unknown> = {};
async function abeComps(ident: any) {
  const isbn = cleanIsbn(ident.isbn);
  const u = new URL("https://www.abebooks.com/servlet/SearchResults");
  if (isbn) u.searchParams.set("isbn", isbn);
  else { u.searchParams.set("tn", String(ident.title || "").slice(0, 80)); if (ident.author) u.searchParams.set("an", String(ident.author).split(/[;,&]| and /)[0].slice(0, 40)); }
  u.searchParams.set("sortby", "17");
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" } });
  DIAG.abe_status = r.status; DIAG.abe_url = String(u);
  if (!r.ok) return [];
  const html = await r.text();
  DIAG.abe_bytes = html.length;
  const out: any[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let j: any; try { j = JSON.parse(m[1]); } catch { continue; }
    const lists = [j].flat().filter((x: any) => x && x["@type"] === "ItemList");
    for (const L of lists) for (const el of (L.itemListElement || [])) {
      const it = el.item || {}, of = it.offers || {};
      const price = Number(of.price);
      if (!(price > 0) || (of.priceCurrency && of.priceCurrency !== "USD")) continue;
      const fmt = String(it.bookFormat || "").split("/").pop();
      out.push({ i: out.length + 1, title: [it.name, it.bookEdition && "(" + it.bookEdition + " ed)", fmt].filter(Boolean).join(" "),
        price, ship: 0, cond: /New/i.test(String(of.itemCondition || "")) ? "New" : "Used", seller: of.seller?.name || "", url: String(of.url || it.url || ""), sold: null });
    }
  }
  DIAG.abe_found = out.length;
  return out.slice(0, 30);
}

// ---------- last resort: Claude searches the web for used-copy prices ----------
async function webComps(model: string, ident: any) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1200, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [{ role: "user", content: `Find current prices for USED copies of this exact book (same edition and format) for sale or recently sold online (eBay, AbeBooks, Biblio, Amazon used, ThriftBooks, BookFinder):
${JSON.stringify({ title: ident.title, author: ident.author, publisher: ident.publisher, year: ident.year, isbn: ident.isbn, format: ident.format, edition: ident.edition })}
Only include prices you actually found on a page. Respond at the end with ONLY JSON: {"comps":[{"price":12.5,"title":"","seller":"site name","url":"","sold":false}]}` }] }),
  });
  DIAG.web_status = r.status;
  if (!r.ok) { DIAG.web_err = (await r.text()).slice(0, 300); return []; }
  const j = await r.json();
  const txt = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  DIAG.web_tail = txt.slice(-400);
  const a = txt.lastIndexOf('{"comps"'); if (a < 0) return [];
  try {
    const o = JSON.parse(txt.slice(a, txt.lastIndexOf("}") + 1));
    return (o.comps || []).filter((c: any) => Number(c.price) > 0).slice(0, 12)
      .map((c: any, k: number) => ({ i: k + 1, title: String(c.title || ident.title || ""), price: Number(c.price), ship: 0, cond: "Used", seller: String(c.seller || ""), url: String(c.url || ""), sold: c.sold ? 1 : null }));
  } catch { return []; }
}

// ---------- Buyback (BookScouter) ----------
// Key lives in backup.config 'bookscouter_key'. Until it is there, clean-up mode just skips SELL.
async function bestBuyback(sql: any, ident: any) {
  const isbn = cleanIsbn(ident.isbn);
  if (!isbn) return { missing: false, price: 0, note: "No ISBN, buybacks need one" };
  const [k] = await sql`select value from backup.config where key = 'bookscouter_key'`;
  if (!k || !k.value) return { missing: true, price: 0 };
  const r = await fetch(`https://api.bookscouter.com/services/v1/cachedPrices/${isbn}?apiKey=${encodeURIComponent(k.value)}`, { headers: { Accept: "application/json" } });
  const txt = await r.text();
  DIAG.bs_status = r.status; DIAG.bs_head = txt.slice(0, 300);
  if (!r.ok) return { error: `BookScouter answered ${r.status}`, price: 0 };
  let j: any; try { j = JSON.parse(txt); } catch { return { error: "BookScouter reply was not JSON", price: 0 }; }
  // Shape is confirmed on the first real call; accept the common layouts.
  const rows: any[] = j?.cachedPrices || j?.data?.Prices || j?.data?.prices || j?.Prices || j?.prices || j?.data || [];
  const offers = (Array.isArray(rows) ? rows : []).map((p: any) => ({
    vendor: String(p?.Vendor?.Name || p?.vendor?.name || p?.VendorName || p?.vendor || p?.name || "Buyback"),
    price: Number(p?.Price ?? p?.price ?? p?.Amount ?? p?.amount ?? 0),
  })).filter((o) => o.price > 0).sort((a, b) => b.price - a.price);
  return offers.length ? { price: offers[0].price, vendor: offers[0].vendor, others: offers.slice(1, 4) } : { price: 0, vendor: "", note: "No one is buying it back" };
}

// ---------- Amazon via Keepa: used buy box, sales rank, how often it sells ----------
// Key lives in backup.config 'keepa_key'. ~3 tokens per book; his plan refills 20 a minute.
async function keepaInfo(sql: any, ident: any) {
  const isbn = cleanIsbn(ident.isbn);
  if (!isbn) return null;
  const [k] = await sql`select value from backup.config where key = 'keepa_key'`;
  if (!k || !k.value) return null;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`https://api.keepa.com/product?key=${encodeURIComponent(k.value)}&domain=1&code=${isbn}&stats=90&buybox=1&history=0`, { signal: ctl.signal });
    const j = await r.json();
    DIAG.keepa_status = r.status; DIAG.keepa_tokens = j?.tokensLeft;
    const p = j?.products?.[0]; if (!p || !p.stats) return null;
    const st = p.stats, cur = st.current || [];
    const c2d = (v: any) => (typeof v === "number" && v > 0 ? +(v / 100).toFixed(2) : 0);
    return { asin: p.asin, usedBB: c2d(st.buyBoxUsedPrice), usedBBFBA: st.buyBoxUsedIsFBA === true, gradeLow: c2d(cur[21]), usedLow: c2d(cur[2]), rank: typeof cur[3] === "number" && cur[3] > 0 ? cur[3] : 0,
      drops90: typeof st.salesRankDrops90 === "number" && st.salesRankDrops90 >= 0 ? st.salesRankDrops90 : null, tokens: j.tokensLeft };
  } catch (e) { DIAG.keepa_err = String(e); return null; } finally { clearTimeout(timer); }
}

// ---------- typed / barcode-scanned ISBN (desk computer): look the book up instead of reading a photo ----------
async function isbnIdent(sql: any, raw: string) {
  const isbn = cleanIsbn(raw);
  if (!isbn) return null;
  const [k] = await sql`select value from backup.config where key = 'bookscouter_key'`;
  let b: any = null;
  if (k && k.value) {
    try {
      const r = await fetch(`https://api.bookscouter.com/services/v1/book/${isbn}?apiKey=${encodeURIComponent(k.value)}`);
      b = (await r.json())?.book || null;
    } catch (_) { b = null; }
  }
  if (!b || !b.Title) return { isbn, title: "", author: "", format: "", weight_lb: 1, family_friendly: true, confidence: "low", search: isbn };
  const fmt = /hard|library/i.test(b.Binding || "") ? "Hardcover" : /spiral|ring|comb/i.test(b.Binding || "") ? "Spiral" : /paper|soft|mass/i.test(b.Binding || "") ? "Paperback" : String(b.Binding || "");
  const pages = parseInt(b.NumberOfPages) || 0;
  const weight = fmt === "Hardcover" ? (pages > 600 ? 4 : pages > 350 ? 3 : 2) : (pages > 600 ? 3 : pages > 350 ? 2 : 1);
  const title = String(b.Title).replace(/\s*\[[^\]]*\]/g, "").trim();
  const author = Array.isArray(b.Author) ? b.Author.join("; ") : String(b.Author || "");
  const pub = String(b.Publisher || "");
  return {
    isbn, title, author, publisher: pub, year: String(b.Published || "").slice(0, 4), format: fmt, edition: String(b.Edition || ""),
    weight_lb: weight, family_friendly: true, confidence: "high", from_isbn: true,
    tgatb: /good and the beautiful|jenny phillips/i.test(title + " " + pub + " " + author),
    search: [title.split(":")[0], author.split(/[;,]/)[0].split(" ").pop()].filter(Boolean).join(" ").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim(),
  };
}

async function judge(model: string, ident: any, active: any[]) {
  if (!active.length) return [];
  const out = await claude(model, [{ type: "text", text: ident.kind === "item" ?
`Papa Duck is holding this item (not a book):
${JSON.stringify({ title: ident.title, item: ident.item, year: ident.year, is_set: ident.is_set })}

Listings for sale now (id, price, condition, title):
${active.map((c) => `${c.i}\t$${c.price.toFixed(2)}\t${c.condition || c.cond}\t${c.title}`).join("\n")}

Keep ONLY listings that are the SAME item: same maker and line/pattern/model, same kind of piece, comparable size. Drop: different pieces or patterns, lots/sets when his is a single piece (or singles when his is a set), reproductions when his is original (or vice versa), parts/broken/repair listings, new-in-box when his is used without a box.
Also fair_list: the list price you would set for his used one in good condition, as his pricer. Aim for the middle-to-upper part of the kept listings, never the bargain end, never below the cheapest kept listing. A number like 14.99, and fair_why in one short sentence.
Respond ONLY JSON: {"keep":[1,2,3],"fair_list":0,"fair_why":""}` :
`Papa Duck is holding this book:
${JSON.stringify({ title: ident.title, author: ident.author, publisher: ident.publisher, year: ident.year, isbn: ident.isbn, format: ident.format, edition: ident.edition, dust_jacket: ident.dust_jacket, is_set: ident.is_set })}

Listings for sale now (id, price, condition, title):
${active.map((c) => `${c.i}\t$${c.price.toFixed(2)}\t${c.cond}\t${c.title}`).join("\n")}

Keep ONLY listings that are the SAME book in a comparable edition and format. Drop: different books or volumes, lots/sets when his is single (or single when his is a set), teacher/answer keys when his is the student book (or vice versa), signed or true first editions when his is neither, Folio/Easton/leather editions, study guides, audiobooks, brand-new copies when his is used.
Also fair_list: the list price you would set for a clean used copy of his (assume Good to Very Good), as his pricer. Aim for the middle-to-upper part of the kept copies, never the bargain end — do not undercut the busy low-priced sellers, and never below the cheapest kept copy. A number like 6.99, and fair_why in one short sentence.
Respond ONLY JSON: {"keep":[1,2,3],"fair_list":0,"fair_why":""}` }], 400);
  const keep = new Set((out.keep || []).map(Number));
  const kept: any = active.filter((c) => keep.has(c.i));
  kept.fair = Number(out.fair_list) || 0; kept.fair_why = String(out.fair_why || "");
  return kept;
}

// ---------- the chat / Drafts method (Rule BQ + sold counts): never below the middle of the market ----------
function chatPrice(items: any[], fairIn: number) {
  if (!items.length) return null;
  const sorted = items.map((c) => c.price).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  let keep = items.filter((c) => !(c.price > mid * 2.5 || c.price * 2.5 < mid));
  let out = items.filter((c) => !keep.includes(c));
  if (keep.length < 2) { keep = items; out = []; }
  const vals = keep.map((c) => c.price), sv = [...vals].sort((a, b) => a - b);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const median = sv.length % 2 ? sv[(sv.length - 1) / 2] : (sv[sv.length / 2 - 1] + sv[sv.length / 2]) / 2;
  const soldTot = keep.reduce((a, c) => a + (c.sold || 0), 0);
  const soldAvg = soldTot >= 3 ? keep.reduce((a, c) => a + c.price * (c.sold || 0), 0) / soldTot : 0;
  const low = sv[0], high = sv[sv.length - 1];
  const fair = fairIn > 0 ? Math.min(Math.max(fairIn, low), high) : 0;
  const target = Math.max(avg, median, soldAvg, fair);
  const basis = target === fair && fair > 0 ? "Claude's call" : target === soldAvg && soldAvg > 0 ? "where copies are selling" : target === median && median > avg ? "median" : "average";
  return { list: up99(target), avg: +avg.toFixed(2), median: +median.toFixed(2), soldAvg: soldAvg ? +soldAvg.toFixed(2) : null, soldTot, low, high, n: vals.length, fair: fair || null, basis,
    outliers: out.map((c) => c.price) };
}

// ---------- Airtable ----------
const at = (path: string, init: RequestInit = {}) =>
  fetch(`https://api.airtable.com/v0/${BASE}/${TABLE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${Deno.env.get("AIRTABLE_TOKEN")}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
async function findBuys(sql: any, ident: any) {
  const isbn = cleanIsbn(ident.isbn);
  const t = String(ident.title || "").toLowerCase().slice(0, 40).trim();
  if (!isbn && t.length < 4) return [];
  const rows = await sql`select * from pipeline.scout_buys
    where (${isbn} <> '' and upper(replace(replace(coalesce(isbn,''),'-',''),' ','')) = ${isbn})
       or (${t.length >= 4} and position(${t} in lower(title)) > 0)
    order by date_bought desc, id desc limit 10`;
  return rows.map((x: any) => ({
    id: Number(x.id), title: x.title, isbn: x.isbn || "", store: x.store || "", location: x.location || "",
    cost: x.cost == null ? null : Number(x.cost), date: x.date_bought ? new Date(x.date_bought).toISOString().slice(0, 10) : "",
    list: x.suggested_list == null ? null : Number(x.suggested_list), copies: x.copies ?? 1, pd: x.pd_number || "", listed: !!x.listed,
    photo: x.photo_url || "", isbn_match: !!isbn && cleanIsbn(x.isbn) === isbn,
  }));
}

async function imgbb(image: string, name: string): Promise<string> {
  let last = "";
  for (let a = 1; a <= 3; a++) {
    try {
      const body = new URLSearchParams({ image, name });
      const r = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(Deno.env.get("IMGBB_KEY")!)}`, { method: "POST", body });
      const j = await r.json();
      if (j?.success) return j.data.url;
      last = j?.error?.message || `imgbb ${r.status}`;
    } catch (e) { last = String((e as Error).message || e); }
    await sleep(1500 * a);
  }
  throw new Error("Photo upload failed: " + last);
}

function todayPacific() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

// ---------- main ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const [pin] = await sql`select value from backup.config where key = 'scout_pin'`;
    if (!pin || String(body.pin || "") !== pin.value) return json({ error: "Wrong PIN" }, 403);
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    const visionModel = conf.scout_model || "claude-haiku-4-5-20251001"; // fast by default, it is a scanner
    const fastModel = conf.scout_judge_model || "claude-haiku-4-5-20251001";
    const action = String(body.action || "");

    if (action === "ping") return json({ ok: true });
    if (action === "shelf") {
      const shots = shotsOf(body);
      if (!shots.length) return json({ error: "No photo" }, 400);
      const model = conf.shelf_model || "claude-sonnet-5";
      const out: any = await claude(model, [
        ...shots.map((x) => ({ type: "image", source: { type: "base64", media_type: x.mt || "image/jpeg", data: x.data } })),
        { type: "text", text: (shots.length > 1 ? `These ${shots.length} photos are different shelves. Number the shelves across all photos in order: photo 1 first (top to bottom), then photo 2.\n\n` : "") + SHELF_PROMPT },
      ], 6000);
      const shelves = (out.shelves || []).map((sh: any, i: number) => ({
        shelf: i + 1,
        books: (sh.books || []).map((b: any, k: number) => ({
          pos: k + 1, title: String(b.title || "").trim(), author: String(b.author || "").trim(),
          readable: b.readable === true ? "yes" : String(b.readable || (b.title ? "yes" : "no")),
          look: String(b.look || ""), format: String(b.format || ""),
        })),
      }));
      return json({ ok: true, shelves, notes: String(out.notes || ""), secs: Math.round((Date.now() - t0) / 1000) });
    }
    if (action === "evaluate") {
      const shots = shotsOf(body);
      if (!shots.length && !body.ident && !body.isbn) return json({ error: "No photo" }, 400);
      for (const k in DIAG) delete DIAG[k];
      const ident = shots.length ? await identify(visionModel, shots)
        : body.isbn ? await isbnIdent(sql, String(body.isbn))            // typed or barcode-scanned ISBN
        : body.ident;                                                      // ident-only = test mode
      if (!ident) return json({ ok: true, verdict: "RETAKE", reason: "That isn't a valid ISBN. Check the number and try again.", ident: { isbn: String(body.isbn || "") }, secs: 0 });
      if (!ident.title && !ident.isbn) return json({ ok: true, verdict: "RETAKE", reason: "Couldn't read it — try the barcode or cover, closer and without glare.", ident, secs: Math.round((Date.now() - t0) / 1000) });

      // eBay comps and "already bought?" at the same time
      const isItem = ident.kind === "item";   // v25: non-book — eBay only (no AbeBooks, Amazon/Keepa, BookScouter)
      const bbP = isItem ? Promise.resolve(null) : bestBuyback(sql, ident).catch((e) => ({ error: String(e?.message || e), price: 0 }));   // runs alongside eBay
      const kpP = isItem ? Promise.resolve(null) : keepaInfo(sql, ident).catch(() => null);                                                // Amazon, alongside eBay
      const tok = await ebayToken();
      const abeP = isItem ? Promise.resolve([] as any[]) : abeComps(ident).catch((e) => { DIAG.abe_err = String(e); return [] as any[]; });   // second opinion, runs alongside eBay
      const [found, prior] = await Promise.all([
        comps(ident, tok).catch(() => []),
        findBuys(sql, ident).catch(() => []),
      ]);
      // Never compare him against his own listings
      const me = String(conf.my_ebay_seller || "").toLowerCase();
      const notMine = (c: any) => !me || String(c.seller || "").toLowerCase() !== me;
      const kept0: any = await judge(fastModel, ident, found.filter(notMine));
      // sold counters on the matching copies (Drafts checks 40; a shelf sweep checks fewer to spare eBay's daily limit)
      const kept = (await soldCounts(tok, kept0.slice(0, body.quick ? 20 : 40))).filter(notMine);
      let source = kept.length ? "ebay" : "";
      let alt: any[] = [];
      const meAbe = String(conf.my_abe_seller || "").toLowerCase();
      const abeRaw = (await abeP).filter((c: any) => !meAbe || String(c.seller || "").toLowerCase() !== meAbe);
      const amazon: any = await kpP;
      // Amazon used buy box includes the buyer's ~$3.99 shipping when the seller ships it himself; his comparable list = buy box - $3.99
      const amzList = amazon && amazon.usedBB > 0 ? up99(Math.max(amazon.usedBB - (amazon.usedBBFBA ? 0 : 3.99), 0.99)) : 0;
      const amzSelling = !!amazon && amazon.drops90 != null && amazon.drops90 >= 3;
      // AbeBooks used copies: judged when the search was by title (could be other books); an ISBN search is already this book
      let abeUsed: any[] = abeRaw.filter((c: any) => c.cond !== "New");
      if (abeUsed.length && !cleanIsbn(ident.isbn)) abeUsed = await judge(fastModel, ident, abeUsed).catch(() => []);
      if (!kept.length) {
        if (abeUsed.length) { alt = abeUsed; source = "abebooks"; }
        else if (amzList) source = "amazon";
        else if (!body.quick && !isItem) { alt = await webComps(fastModel, ident).catch(() => []); if (alt.length) source = "web"; }
      }

      const store = String(body.store || "");
      const costIn = body.cost === "" || body.cost == null ? null : Number(body.cost);
      const cost = costIn != null && !isNaN(costIn) ? costIn : isItem ? null : defaultCost(store, ident.format);
      const weight = Number(ident.weight_lb) || 1;

      const flags: string[] = [];
      const hard: string[] = [];
      if (ident.tgatb) hard.push("🚨 The Good and the Beautiful — never list");
      if (ident.self_printed) hard.push("🚨 Looks self-printed / photocopied");
      if (ident.ex_library) hard.push("Ex-library markings");
      if (ident.book_club) hard.push("Book club edition");
      if (ident.international_edition) hard.push("International edition");
      if (ident.college_custom) hard.push("Custom college edition");
      if (ident.imagination_library) hard.push("Imagination Library seal");
      if (ident.occult) hard.push("Occult title — you don't carry these");
      if (ident.confidence === "low") flags.push("Low-confidence read — double-check the title");
      const family = ident.family_friendly === false ? (ident.family_note || "May not fit your family-friendly shop") : "";

      // PRICE — the same way Drafts and the chat do it: the middle of the matching copies or higher, never the bargain end.
      const selling = kept.filter((c: any) => (c.sold || 0) > 0);
      const soldN = selling.reduce((t: number, c: any) => t + (c.sold || 0), 0);
      const soldKnown = kept.some((c: any) => c.sold !== null);
      const cp = chatPrice(kept, kept0.fair || 0);
      const trimmed = cp;
      let list: number | null = cp ? cp.list : null;
      let cheapest = kept.length ? Math.min(...kept.map((c: any) => c.price + (c.ship || 0))) : 0;
      let basis = selling.length ? "sold" : kept.length ? "active" : "none";
      let altLow = 0, altHigh = 0;
      let abeGrid: any = null;
      if (abeUsed.length) {
        const ap = abeUsed.map((c: any) => c.price).sort((a: number, b: number) => a - b);
        abeGrid = { n: ap.length, low: ap[0], high: ap[ap.length - 1], avg: +(ap.reduce((t: number, v: number) => t + v, 0) / ap.length).toFixed(2) };
      }
      if (cp) {
        flags.push(`eBay: ${cp.n} matching ${cp.n === 1 ? "copy" : "copies"} $${cp.low.toFixed(2)}–$${cp.high.toFixed(2)}, average $${cp.avg.toFixed(2)}` +
          (cp.soldAvg ? `, selling at $${cp.soldAvg.toFixed(2)}` : "") + ` → list $${list!.toFixed(2)} (${cp.basis})`);
        if (kept0.fair_why) flags.push("Claude: " + kept0.fair_why);
        if (cp.n <= 2) {
          // thin eBay data: lean on the other two markets rather than cutting the price
          const others = [abeGrid ? abeGrid.avg : 0, amzList].filter((v) => v > 0);
          if (others.length) { const o = Math.max(...others); if (o > list!) { flags.push(`Only ${cp.n} on eBay — AbeBooks/Amazon say more, so priced at $${up99(o).toFixed(2)}`); list = up99(o); } }
          else flags.push(`Only ${cp.n} ${cp.n > 1 ? "copies" : "copy"} on eBay to compare`);
        }
      } else if (alt.length) {
        // off eBay: the middle of what other sellers ask (average or median, whichever is higher)
        const pool = alt.map((c: any) => c.price).sort((a: number, b: number) => a - b);
        altLow = pool[0]; altHigh = pool[pool.length - 1];
        const avgA = pool.reduce((t: number, v: number) => t + v, 0) / pool.length;
        const medA = pool.length % 2 ? pool[(pool.length - 1) / 2] : (pool[pool.length / 2 - 1] + pool[pool.length / 2]) / 2;
        list = up99(Math.max(avgA, medA));
        basis = source;
        if (amzList > list) { list = amzList; flags.push(`Amazon's used buy box supports $${amzList.toFixed(2)}`); }
      } else if (source === "amazon") { list = amzList; altLow = amazon.usedBB; basis = "amazon"; }
      const market: number | null = list, adjGroup = "";
      let verdict = "PASS", reason = "";
      // his listing minimum: lower for proven sellers (eBay sales or steady Amazon sales). pipeline.config min_list_proven / min_list
      const minL = (soldN > 0 || amzSelling) ? (Number(conf.min_list_proven) || 10) : (Number(conf.min_list) || 12);
      const net = list != null && cost != null ? (isItem ? netItem(list, cost, weight) : netOf(list, cost, weight)) : null;
      const where = source === "abebooks" ? "AbeBooks" : source === "amazon" ? "Amazon" : "the web";
      const amzSales = amazon && amazon.drops90 != null ? `about ${amazon.drops90} sale${amazon.drops90 === 1 ? "" : "s"} in 90 days` : "";
      if (hard.length) reason = hard[0];
      else if (list == null) reason = isItem ? "No matching items for sale on eBay — try a clearer photo of the maker's mark or label" : "No copies found on eBay, Amazon, AbeBooks or the web";
      else if (!kept.length && list < minL) reason = `No eBay copies. On ${where} used copies start around $${altLow.toFixed(2)} — under your $${minL} minimum`;
      else if (!kept.length && source === "amazon") {
        if (cost == null) { verdict = "CHECK"; reason = "Enter the cost to get a call"; }
        else if (net! >= 3 && amzSelling) { verdict = "BUY"; reason = `No eBay copies. Amazon used buy box $${amazon.usedBB.toFixed(2)}, ${amzSales}. List $${list.toFixed(2)}`; }
        else if (net! >= 3) { verdict = "CHECK"; reason = `No eBay copies. Amazon used buy box $${amazon.usedBB.toFixed(2)}, but ${amzSales || "no sales data"}.`; }
        else reason = `Too thin at $${cost.toFixed(2)} cost`;
      }
      else if (!kept.length) {
        const n = alt.length;
        if (cost != null && net! >= 3) { verdict = "CHECK"; reason = `Looks like a buy: no eBay copies, ${n} on ${where} from $${altLow.toFixed(2)}. No sales data to confirm.`; }
        else if (cost == null) { verdict = "CHECK"; reason = "Enter the cost to get a call"; }
        else reason = `Too thin at $${cost.toFixed(2)} cost`;
      }
      else if (list < minL) reason = `Your price would be about $${list.toFixed(2)} — under your $${minL} minimum`;
      else if (soldN === 0 && cost == null) { verdict = "CHECK"; reason = "Enter the cost to get a call"; }
      else if (soldN === 0 && net! >= 3 && amazon && amazon.drops90 === 0) {
        verdict = "CHECK";
        reason = `No sales showing on eBay or Amazon (0 in 90 days). ${kept.length} on eBay from $${cheapest.toFixed(2)} delivered.`;
      }
      else if (soldN === 0 && net! >= 3) {
        verdict = "BUY";
        reason = `${kept.length} on eBay, no sold counts showing.` + (amzSelling ? ` Amazon: ${amzSales}.` : "") + ` List $${list.toFixed(2)}`;
      }
      else if (soldN === 0) reason = `Too thin at $${cost!.toFixed(2)} cost`;
      else if (!soldKnown) { verdict = "CHECK"; reason = "Couldn't read eBay sold counters — check before buying"; }
      else if (cost == null) { verdict = "CHECK"; reason = "Enter the cost to get a call"; }
      else if (net! >= 3) { verdict = "BUY"; reason = `${soldN} sold on eBay, list $${list.toFixed(2)}`; }
      else reason = `Too thin at $${cost.toFixed(2)} cost`;
      if (soldN > 0 && soldN < 3 && verdict === "BUY") flags.push(`Only ${soldN} sold — slow mover`);
      if (selling.length && list != null && amzList >= 12 && amzList > list * 1.5 && amzSelling) flags.push(`Amazon pays more: used buy box $${amazon.usedBB.toFixed(2)} (${amzSales}) — worth listing there if you're ungated`);

      // ---------- CLEAN-UP MODE: books he already owns from lots. Cost is sunk, so the question is where each one goes. ----------
      const buyback: any = await bbP;
      if (amazon && (amazon.usedBB || amazon.usedLow || amazon.rank)) {
        const parts: string[] = [];
        parts.push(amazon.usedBB ? `used buy box $${amazon.usedBB.toFixed(2)}` : amazon.usedLow ? `lowest used $${amazon.usedLow.toFixed(2)} (no used buy box)` : "no used offers");
        if (amazon.rank) parts.push(`rank #${amazon.rank.toLocaleString("en-US")}`);
        if (amazon.drops90 != null) parts.push(`about ${amazon.drops90} sale${amazon.drops90 === 1 ? "" : "s"} in 90 days`);
        flags.push("Amazon: " + parts.join(" · "));
      }
      // Scout: a buyback offer that beats his cost is a buy on its own (World of Books, ThriftBooks, etc. via BookScouter)
      if (body.mode !== "cleanup" && !hard.length && cost != null && buyback && buyback.price > cost && verdict !== "BUY") {
        verdict = "BUY";
        reason = `Buyback: ${buyback.vendor} pays $${buyback.price.toFixed(2)} (you pay $${cost.toFixed(2)})`;
        flags.push("Quick flip: sell it straight to " + buyback.vendor + " for $" + buyback.price.toFixed(2));
      } else if (body.mode !== "cleanup" && buyback && buyback.price > 0 && verdict === "BUY") {
        flags.push(`Backup exit: ${buyback.vendor} buys it for $${buyback.price.toFixed(2)}`);
      }
      if (body.mode !== "cleanup" && buyback && buyback.missing) flags.push("Buyback check is off until the BookScouter key is added");
      if (body.mode === "cleanup") {
        const ebayNet = list != null ? (isItem ? netItem(list, 0, weight) : netOf(list, 0, weight)) : 0;          // what listing puts in his pocket, cost already spent
        const offer = buyback && buyback.price > 0 ? buyback.price : 0;
        const selling2 = kept.length > 0 || alt.length > 0 || source === "amazon";
        if (ident.self_printed) { verdict = "TOSS"; reason = "Looks self-printed or photocopied. Can't sell or donate it."; }
        else if (family || ident.occult) { verdict = "TOSS"; reason = family ? "Not a fit for a family shop: " + family : "Occult title"; }
        else if (hard.length) { verdict = "GOODWILL"; reason = hard[0].replace("🚨 ", "") + ". Won't list it."; }
        else if (list != null && list >= minL && selling2 && ebayNet >= 3 && !(offer >= ebayNet * 0.8)) {
          verdict = "LIST"; reason = kept.length ? (soldN ? `${soldN} sold on eBay.` : `${kept.length} on eBay from $${cheapest.toFixed(2)}.`) + ` List at $${list.toFixed(2)}.` : `No eBay copies, but ${where} asks $${altLow.toFixed(2)}+. List at $${list.toFixed(2)}.`;
        }
        else if (offer >= 1) { verdict = "SELL"; reason = `${buyback.vendor} pays $${offer.toFixed(2)}` + (ebayNet > 0 && list != null && list >= minL ? ` (listing nets about $${ebayNet.toFixed(2)} with the work)` : "") + "."; }
        else {
          verdict = "GOODWILL";
          const bbTxt = offer > 0 ? `Best buyback is only $${offer.toFixed(2)}.` : "No buyback offer.";
          reason = list != null && list < minL ? `Would list for about $${list.toFixed(2)}, under your $${minL} minimum. ${bbTxt}` : `Not selling on eBay. ${bbTxt}`;
        }
        if (buyback && buyback.missing) flags.push("Buyback check is off until the BookScouter key is added");
      }

      // Clean-up: keep a pile list for the batch so he can sort bins at the end
      let pile_id: number | null = null;
      if (body.mode === "cleanup" && body.batch) {
        const [row] = await sql`insert into pipeline.cleanup_piles (batch, title, isbn, author, pile, pile_suggested, list_price, buyback_vendor, buyback_price, reason)
          values (${String(body.batch).slice(0, 80)}, ${String(ident.title || "").slice(0, 250)}, ${cleanIsbn(ident.isbn) || String(ident.isbn || "")}, ${String(ident.author || "")},
                  ${verdict}, ${verdict}, ${list}, ${buyback && buyback.price > 0 ? buyback.vendor : null}, ${buyback && buyback.price > 0 ? buyback.price : null}, ${reason}) returning id`;
        pile_id = Number(row.id);
      }
      // Every scan is logged; when the same book later lands in Drafts, the Scout numbers ride along as a note
      {
        const bits = [`${verdict}${list != null ? " · list $" + list.toFixed(2) : ""}`];
        if (kept.length) bits.push(`eBay ${soldN ? soldN + " sold" : "no sold count"}, ${kept.length} listed` + (cheapest ? ` from $${cheapest.toFixed(2)} delivered` : ""));
        if (amazon && amazon.usedBB) bits.push(`Amazon used buy box $${amazon.usedBB.toFixed(2)}` + (amzSales ? `, ${amzSales}` : ""));
        if (buyback && buyback.price > 0) bits.push(`buyback ${buyback.vendor} $${buyback.price.toFixed(2)}`);
        await sql`insert into pipeline.scout_scans (isbn, title, author, mode, verdict, list, summary, pile_id)
          values (${cleanIsbn(ident.isbn) || null}, ${String(ident.title || "").slice(0, 250)}, ${String(ident.author || "")}, ${body.mode === "cleanup" ? "cleanup" : body.quick ? "shelf" : "scout"},
                  ${verdict}, ${list}, ${bits.join(" · ")}, ${pile_id})`.catch((e: any) => { DIAG.log_err = String(e); });
      }

      const result = {
        ok: true, pile_id, verdict, reason, list, cost, profit: list != null && cost != null ? +(list - cost).toFixed(2) : null,
        basis, market, adjGroup, soldN, grid: {
          ebay: { n: cp ? cp.n : 0, low: cp ? cp.low : null, avg: cp ? cp.avg : null, high: cp ? cp.high : null, sold: soldN, sold_avg: cp ? cp.soldAvg : null, found: found.length },
          abe: abeGrid || { n: 0 },
          amazon: amazon ? { used_bb: amazon.usedBB || null, used_bb_fba: !!amazon.usedBBFBA, grade_low: amazon.gradeLow || null, grade: "Good", used_low: amazon.usedLow || null,
                             rank: amazon.rank || null, sales90: amazon.drops90 } : { error: isItem ? "not a book" : cleanIsbn(ident.isbn) ? "not found on Amazon" : "no ISBN" },
          fair_why: kept0.fair_why || "" }, activeN: kept.length, low: trimmed?.low ?? 0, high: trimmed?.high ?? 0,
        hard, flags, family, ident, prior,
        source: source || "none", altLow, altHigh, buyback, amazon,
        comps: !kept.length && alt.length ? alt.slice().sort((a: any, b: any) => a.price - b.price).slice(0, 8)
          .map((c: any) => ({ price: c.price, ship: 0, sold: c.sold, seller: c.seller || "", title: c.title, cond: c.cond, url: c.url })) :
          [...kept].sort((a: any, b: any) => (b.sold || 0) - (a.sold || 0)).slice(0, 8)
          .map((c: any) => ({ price: c.price, ship: c.ship || 0, sold: c.sold, seller: c.seller || "", title: c.title, cond: c.cond, url: c.url })),
        secs: Math.round((Date.now() - t0) / 1000),
      };
      if (body.save_test) (result as any).diag = DIAG;
      if (body.save_test) await sql`insert into backup.config (key, value) values ('scout_test', ${JSON.stringify(result)}) on conflict (key) do update set value = excluded.value`;
      return json(result);
    }

    if (action === "bought") {
      const ident = body.ident || {};
      if (!ident.title && !ident.isbn) return json({ error: "Nothing to log" }, 400);
      let photoUrl = "", photoUrls: string[] = [];
      const bShots = shotsOf(body);
      if (bShots.length) {
        const slug = String(ident.title || "book").replace(/[^\w]+/g, "_").slice(0, 40);
        photoUrls = (await Promise.all(bShots.map((x, n) => imgbb(x.data, `scout_${todayPacific()}_${slug}_${n + 1}`).catch(() => "")))).filter(Boolean);
        photoUrl = photoUrls[0] || "";
      }
      const fields: Record<string, unknown> = {
        Title: String(ident.title || ident.isbn || "").slice(0, 250),
        ISBN: cleanIsbn(ident.isbn) || String(ident.isbn || ""),
        Author: String(ident.author || ""),
        "Date Bought": /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : todayPacific(),
        Store: String(body.store || ""),
        Location: String(body.location || ""),
        Trip: String(body.trip || ""),
        Copies: Math.max(1, parseInt(body.copies) || 1),
        Notes: [ident.format, ident.year, ident.publisher, ident.notes, body.notes].filter(Boolean).join(" · ").slice(0, 2000),
      };
      if (body.cost !== "" && body.cost != null && !isNaN(Number(body.cost))) fields.Cost = Number(body.cost);
      if (body.list != null && !isNaN(Number(body.list))) fields["Suggested List"] = Number(body.list);
      if (photoUrls.length) fields.Photo = photoUrls.map((url) => ({ url }));
      // 1) Postgres first — the buy is never lost
      const [row] = await sql`insert into pipeline.scout_buys (date_bought, title, isbn, author, store, location, trip, cost, suggested_list, copies, photo_url, notes)
        values (${fields["Date Bought"] as string}, ${fields.Title as string}, ${fields.ISBN as string}, ${fields.Author as string}, ${fields.Store as string},
                ${fields.Location as string}, ${fields.Trip as string}, ${(fields.Cost as number) ?? null}, ${(fields["Suggested List"] as number) ?? null},
                ${fields.Copies as number}, ${photoUrl || null}, ${[fields.Notes as string, photoUrls.length > 1 ? "More photos: " + photoUrls.slice(1).join(" ") : ""].filter(Boolean).join(" · ")}) returning id`;
      // 2) copy to Airtable Scout Buys
      let atId = "", atErr = "";
      try {
        const r = await at("", { method: "POST", body: JSON.stringify({ records: [{ fields }], typecast: true }) });
        const j = await r.json();
        if (r.ok) atId = j.records?.[0]?.id || ""; else atErr = `${r.status} ${JSON.stringify(j).slice(0, 300)}`;
      } catch (e) { atErr = String((e as Error).message || e).slice(0, 300); }
      await sql`update pipeline.scout_buys set airtable_id = ${atId || null}, airtable_error = ${atErr || null} where id = ${row.id}`;
      return json({ ok: true, id: Number(row.id), airtable: atId ? "saved" : "failed", photo: photoUrl });
    }

    if (action === "lookup") {
      let ident: any = { isbn: body.isbn || "", title: body.title || "" };
      const lShots = shotsOf(body);
      if (lShots.length) ident = await identify(visionModel, lShots);
      if (!ident.title && !ident.isbn) return json({ ok: true, ident, matches: [], note: "Couldn't read the book — try the barcode or copyright page." });
      const matches = await findBuys(sql, ident);
      return json({ ok: true, ident, matches, secs: Math.round((Date.now() - t0) / 1000) });
    }

    if (action === "pile") {          // he moved a book to another pile
      const id = parseInt(body.id), p = String(body.pile || "");
      if (!id || ["LIST", "SELL", "GOODWILL", "TOSS"].indexOf(p) === -1) return json({ error: "Bad pile" }, 400);
      await sql`update pipeline.cleanup_piles set pile = ${p} where id = ${id}`;
      return json({ ok: true });
    }
    if (action === "pile_delete") {   // a re-check with more photos replaces the earlier row
      const id = parseInt(body.id);
      if (!id) return json({ error: "Bad id" }, 400);
      await sql`delete from pipeline.cleanup_piles where id = ${id}`;
      return json({ ok: true });
    }
    if (action === "piles") {         // the sorted list for one batch
      const rows = await sql`select id, created_at, title, isbn, author, pile, pile_suggested, list_price, buyback_vendor, buyback_price
        from pipeline.cleanup_piles where batch = ${String(body.batch || "")} order by created_at`;
      return json({ ok: true, rows: rows.map((r: any) => ({ ...r, id: Number(r.id), list_price: r.list_price == null ? null : Number(r.list_price), buyback_price: r.buyback_price == null ? null : Number(r.buyback_price) })) });
    }

    if (action === "undo") {
      const id = parseInt(body.id);
      if (!id) return json({ error: "Bad id" }, 400);
      const [row] = await sql`delete from pipeline.scout_buys where id = ${id} returning airtable_id`;
      if (row?.airtable_id) await at(`/${row.airtable_id}`, { method: "DELETE" }).catch(() => null);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 600) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
