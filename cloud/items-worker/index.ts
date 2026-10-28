// Papa Duck — Edge Function "items-worker" (2026-10-28). NON-BOOK items in Drafts (cups, jewelry, village houses, games, figurines...).
// Papa Duck: "for the draft I need the ability to identify a non book ... determine a non book item and price, grade it, write up description, etc
//   and post to ebay, or etsy" + "the description need to be technical in the make of the saucer, where it originated from, type of ceramic,
//   why it is collectable, identify any breaks, or ask me those questions" + "dont want to mess with the book process".
// Books never come here. The trigger pipeline.drafts_item_gate only holds a Station draft with NO isbn, NO author and a non-book format.
// Runs from pg_cron (pd-items-worker). One job per call:
//   1) CHECK  ident.item_check = 'pending' -> Claude looks at the photos: a book goes straight back to the book pricer (price_stale = true);
//             an item gets a full item identification + damage questions, channel 'ebay', item_stale = true.
//   2) PRICE  ident.kind = 'item' and item_stale -> eBay comps in ALL categories, sold counters, judge, his price rule (average delivered - $0.50,
//             never under $9.99), eBay category + item specifics from eBay's Taxonomy API, and the technical listing (title, Block 1, Block 2).
//             v3: vintage items (20+ years) also get their Etsy category, 13 tags and when-made (pricing.item.etsy).
// Test: {"dry": draft_id} runs step 2 on one draft and returns the result without saving.
// Auth: x-backup-secret = backup.config.cron_secret. Secrets: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET, ANTHROPIC_API_KEY.
import postgres from "npm:postgres@3.4.4";

const SUPA = "https://gdwxwiwckxthwcsrgywh.supabase.co";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const up99 = (x: number) => { const c = Math.ceil(x - 0.99 - 1e-9) + 0.99; return c < 0.99 ? 0.99 : +c.toFixed(2); };
const r50 = (x: number) => Math.round(x * 2) / 2;
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const emojiLed = (s: string) => { const t = s.trim(); return !!t && t.codePointAt(0)! > 0x2000; };
function bytesToB64(buf: Uint8Array): string { let s = ""; const CH = 0x8000; for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH)); return btoa(s); }

const FOOTER = [
  "\u{1F986} Papa Duck Homeschool | Gresham, Oregon",
  "\u{1F4E6} Carefully wrapped and boxed · Ships USPS Ground Advantage · \u{1F4CD} Gresham, Oregon · Questions welcome — we respond promptly and pack with care.",
];
const B1_FORBIDDEN = ["shipping", "ships ", "we ship", "returns", "return policy", "refund", "payment", "papa duck", "discount", "bargain",
  "great companion", "perfect for", "ideal for", "great for", "buy ", "purchase", "best offer"];

// ---------------- photos ----------------
function smallUrl(u: string) {
  if (u.startsWith(SUPA + "/storage/v1/object/public/")) return u.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") + "?width=1568&height=1568&resize=contain&quality=80";
  if (u.includes("res.cloudinary.com") && u.includes("/image/upload/")) return u.replace("/image/upload/", "/image/upload/c_limit,w_1568,h_1568,q_80,f_jpg/");
  return "https://wsrv.nl/?url=" + encodeURIComponent(u) + "&w=1568&h=1568&fit=inside&q=80&output=jpg";
}
async function photoB64(u: string): Promise<string | null> {
  for (const src of [smallUrl(u), u]) for (let a = 1; a <= 2; a++) {
    try { const r = await fetch(src); if (!r.ok) continue; const b = new Uint8Array(await r.arrayBuffer()); if (b.length > 3000 && b.length < 4_500_000) return bytesToB64(b); } catch (_) { /* retry */ }
  }
  return null;
}

// ---------------- Claude ----------------
async function claude(content: any, model: string, maxTok = 3000): Promise<any> {
  let last = "";
  for (let a = 1; a <= 3; a++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTok, messages: [{ role: "user", content }] }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const raw = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").replace(/```json|```/g, "").trim();
      try { return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { last = "answer was not JSON"; continue; }
    }
    last = `${r.status} ${JSON.stringify(j).slice(0, 200)}`;
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * a); continue; }
    break;
  }
  throw new Error("Claude call failed: " + last);
}

const CHECK_PROMPT = `Papa Duck Homeschool (a Christian, family-friendly used-goods seller in Gresham, Oregon) photographed this. First decide: is it a BOOK or an ITEM?
- "book": any book, booklet, magazine, printed map, guide, card deck of printed educational cards, sheet music or other printed paper item that is sold like a book.
- "item": everything else - cups, mugs, saucers, plates, dishes, glassware, pottery, figurines, miniature / village houses, jewelry, games, puzzles, toys, records (vinyl LPs), CDs/DVDs, collectibles, decor.
If it is a book, answer ONLY {"kind":"book"}.

If it is an ITEM, identify it like an expert antiques and collectibles appraiser. Read every photo closely - especially the BOTTOM / BACKSTAMP / HALLMARK / LABEL / BOX. Never invent a maker, pattern, hallmark or date you cannot read or are not sure of; leave it blank and say so in "uncertainties".
- Pottery & china: maker, pattern name, the backstamp text exactly as printed, country of origin, the ceramic body (porcelain, bone china, fine china, ironstone, stoneware, earthenware, semi-porcelain, majolica...), decoration method (transferware, hand-painted, decal, gilt trim, embossed, glaze type), era of the backstamp.
- Jewelry: metal and hallmarks (925, sterling, 10K/14K/18K, GF, GP), stones (only call a stone real when marked or certain), maker/signature, clasp type, length/size.
- Village houses / figurines: series (e.g. Department 56 Snow Village / Dickens Village), piece name, item number and year on the bottom, lighted or not, cord/bulb, box and sleeve.
- Games / puzzles / toys: publisher, year, edition, piece count, whether the box is sealed, complete or unknown.
DAMAGE - look hard and report every one you can see, located precisely: chips, flea bites, cracks, hairline cracks, crazing, glaze loss, utensil marks, gold/silver trim wear, stains, repairs or glue, discoloration, missing parts, broken pieces, tarnish, loose stones, box wear. Glare is not damage.
GRADE (pick one, same scale as his books): "Like New" (unused look), "Very Good" (light signs of use, no damage), "Good" (honest wear, no chips or cracks), "Acceptable" (chip, crack, repair, missing part or heavy wear).
QUESTIONS for Papa Duck, who is holding it: ask ONLY what the photos cannot settle and a buyer would want to know. ALWAYS ask about damage you cannot rule out from the photos (e.g. "Any chips or cracks you can feel on the rim or foot?", "Any crazing or hairlines when held to the light?", "Does the light / cord work?", "Is every piece there?"). Each question has 2-4 short click options and MUST include a plain no-problem answer ("No chips or cracks", "Works", "Complete"). Ask for measurements if size matters to the price ("Height in inches?" with options like ["About 3 in", "About 4 in", "About 6 in", "Other"]). 2-6 questions.
FAMILY-FRIENDLY: set do_not_list = true with the reason only for clearly adult, occult or offensive items.
WEIGHT: packed shipping weight in whole pounds, rounded up.

Respond with ONLY JSON, no fences:
{"kind":"item","title":"clear eBay-style name: maker + line/pattern + what it is + size/color","item":{"type":"","maker":"","line_or_pattern":"","item_number":"","backstamp_or_marks":"exact text on the bottom/label","country_of_origin":"","material":"","decoration":"","era":"","color":"","size":"","count":"","complete":"","box":"","collectible_why":"one or two sentences, only facts you are sure of"},
 "format":"Other","grade":"Very Good","condition_notes":["every visible flaw, located; or 'no chips, cracks or repairs seen'"],"weight_lb":2,
 "search":"best eBay search words for THIS exact item","do_not_list":false,"do_not_list_reason":"",
 "questions":[{"q":"","options":["",""]}],"uncertainties":""}`;

// ---------------- eBay ----------------
async function ebayToken(): Promise<string> {
  const id = (Deno.env.get("EBAY_CLIENT_ID") || "").trim(), sec = (Deno.env.get("EBAY_CLIENT_SECRET") || "").trim();
  let last = "";
  for (let a = 1; a <= 4; a++) {   // eBay's token server has short hiccups; try again before giving up
    try {
      const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(`${id}:${sec}`) },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }) });
      const j = await r.json().catch(() => ({}));
      if (j.access_token) return j.access_token;
      last = j.error_description || String(r.status);
    } catch (e) { last = String((e as Error).message || e); }
    await sleep(2000 * a);
  }
  throw new Error("eBay token refused: " + last);
}
const H = (tok: string) => ({ Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" });
async function browse(tok: string, q: string): Promise<any[]> {
  const u = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  u.searchParams.set("q", q.slice(0, 100)); u.searchParams.set("limit", "50");
  u.searchParams.set("filter", "buyingOptions:{FIXED_PRICE},priceCurrency:USD,itemLocationCountry:US");
  for (let a = 1; a <= 3; a++) {
    const r = await fetch(u, { headers: H(tok) });
    if (r.ok) return (await r.json()).itemSummaries || [];
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * a); continue; }
    throw new Error(`eBay search refused (${r.status})`);
  }
  return [];
}
async function soldCounts(tok: string, items: any[]) {
  await Promise.all(items.map(async (c) => {
    try {
      const r = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(c.id)}`, { headers: H(tok) });
      if (!r.ok) { c.sold = null; return; }
      const j = await r.json();
      c.sold = Number(j.estimatedAvailabilities?.[0]?.estimatedSoldQuantity ?? 0) || 0;
      if (c.ship == null && j.shippingOptions?.[0]?.shippingCost) c.ship = +j.shippingOptions[0].shippingCost.value || 0;
    } catch { c.sold = null; }
  }));
}
async function categoryFor(tok: string, q: string, comps: any[]) {
  // eBay's own suggestion for the words, cross-checked with the categories the matching listings actually use
  const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(q.slice(0, 100))}`, { headers: H(tok) });
  const sug = r.ok ? ((await r.json()).categorySuggestions || []).map((s: any) => ({ id: String(s.category.categoryId), name: String(s.category.categoryName),
    path: (s.categoryTreeNodeAncestors || []).map((a: any) => a.categoryName).reverse().concat(s.category.categoryName).join(" > ") })) : [];
  const tally = new Map<string, number>();
  for (const c of comps) for (const id of (c.cats || [])) tally.set(id, (tally.get(id) || 0) + 1);
  return { suggestions: sug.slice(0, 8), used_by_matches: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) };
}
async function aspectsFor(tok: string, catId: string) {
  const r = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${catId}`, { headers: H(tok) });
  if (!r.ok) return [];
  return ((await r.json()).aspects || []).filter((a: any) => a.aspectConstraint?.aspectRequired || a.aspectConstraint?.aspectUsage === "RECOMMENDED")
    .slice(0, 25).map((a: any) => ({ name: a.localizedAspectName, required: !!a.aspectConstraint?.aspectRequired, mode: a.aspectConstraint?.aspectMode,
      values: (a.aspectValues || []).slice(0, 25).map((v: any) => v.localizedValue) }));
}

// ---------------- the listing ----------------
function buildB2(t: any, grade: string): string {
  const li = (x: string) => `<li>${esc(x)}</li>`;
  const details = (t.details || []).map((x: string) => String(x).trim()).filter(Boolean);
  let cond = (t.condition || []).map((x: string) => String(x).trim()).filter(Boolean);
  cond = [...cond.filter((x: string) => !x.startsWith("✅")), ...cond.filter((x: string) => x.startsWith("✅"))];
  return `<div style="font-family:Georgia,serif;max-width:820px;line-height:1.6;color:#222">`
    + `<h2 style="color:#1E5B43">${esc(t.h2 || "")}</h2>`
    + `<p>${esc(t.intro || "")}</p>`
    + (String(t.history || "").trim() ? `<h3>\u{1F3DB}\u{FE0F} Maker &amp; History</h3><p>${esc(t.history)}</p>` : "")
    + `<h3>\u{1F50E} Item Details</h3><ul>${details.map(li).join("")}</ul>`
    + `<h3>\u{1F4CB} Condition: ${esc(grade)}</h3><ul>${cond.map(li).join("")}</ul>`
    + (t.closing ? `<p>${esc(t.closing)}</p>` : "")
    + `<p>${FOOTER.map(esc).join("<br>")}</p></div>`;
}
function validate(b1: string, b2: string, title: string, grade: string): string[] {
  const f: string[] = [], low = b1.toLowerCase();
  if (!b1.trim()) f.push("Block 1 is blank");
  if (/<[a-zA-Z/][^>]*>/.test(b1)) f.push("Block 1 must be plain text");
  if (/\$\s?\d/.test(b1)) f.push("Block 1 has a price in it");
  const hits = B1_FORBIDDEN.filter((w) => low.includes(w)); if (hits.length) f.push("Block 1 has eBay-forbidden words: " + hits.join(", "));
  if (!b1.startsWith(`${grade} as graded in hand`)) f.push(`Block 1 must start with exactly "${grade} as graded in hand"`);
  if (b1.length > 700) f.push(`Block 1 is ${b1.length} characters - keep it to 250-600`);
  const HEDGE = ["photographed", "in the photos", "in the photo", "pictured", "could not be", "cannot be", "can't be", "ruled out", "not confirmed", "unable to", "appears to", "appear to", "visible in"];
  const hd = HEDGE.filter((w) => (b1 + " " + b2.replace(/<[^>]+>/g, " ")).toLowerCase().includes(w));
  if (hd.length) f.push("Talks about photos or uncertainty (" + hd.join(", ") + ") - state facts plainly and leave unknowns out");
  if (b2.length < 600) f.push(`Block 2 is only ${b2.length} characters - the intro and history need more substance`);
  if (/\$\s?\d/.test(b2)) f.push("Block 2 has a dollar amount in it");
  const lis = [...b2.matchAll(/<li[^>]*>\s*(.*?)\s*<\/li>/gs)].map((m) => m[1].replace(/<[^>]+>/g, ""));
  const bad = lis.filter((x) => !emojiLed(x)); if (bad.length) f.push(`${bad.length} list line(s) do not start with an emoji`);
  const ci = b2.indexOf("\u{1F4CB}");
  const condLis = [...b2.slice(ci).matchAll(/<li[^>]*>\s*(.*?)\s*<\/li>/gs)].map((m) => m[1]);
  if (!condLis.length || !condLis[condLis.length - 1].trim().startsWith("✅")) f.push("Condition list must end on a ✅ line");
  if (!title.trim()) f.push("eBay title is blank");
  if (title.length > 80) f.push(`eBay title is ${title.length} characters (max 80)`);
  return f;
}
function writePrompt(d: any, grade: string, cat: any, aspects: any[], fix: string[]): string {
  const id = d.ident || {};
  const qa = (d.questions || []).map((q: any, i: number) => ({ q: q.q, a: (d.answers || {})[String(i)] || "(not answered yet)" }));
  const tell = String((d.answers || {}).tell || "").trim().slice(0, 4000);
  return `You are writing the eBay listing for ONE used NON-BOOK item for Papa Duck Homeschool, Gresham, Oregon. Write like an expert antiques and collectibles dealer: technical, specific and accurate.

THE ITEM IN HAND (identified from photos; Papa Duck may have corrected fields):
${JSON.stringify({ ...id, grade_in_hand: grade, weight_lb: d.weight_lb }, null, 1)}

PAPA DUCK'S ANSWERS (facts from the man holding it; every flaw he reports goes in Block 1 AND the Condition list; an unanswered damage question means do not claim the item is free of that flaw):
${JSON.stringify(qa, null, 1)}
${tell ? "\nPAPA DUCK'S OWN WORDS (facts and instructions; his words win over the photos):\n" + tell + "\n" : ""}
EBAY CATEGORY CHOSEN: ${cat.name} (${cat.id})
ITEM SPECIFICS eBay wants for this category (name, required?, mode, allowed values):
${JSON.stringify(aspects)}

WRITE (no price anywhere; never invent a maker, pattern, mark, date or material you were not given):
- ebay_title: max 80 characters. Maker + line/pattern + what it is + key identifiers buyers search (material, color, size, era, "Vintage" only if the era is 20+ years old). No ALL CAPS words except abbreviations.
- b1 (eBay Condition Description): plain text, 250-600 characters, 3-5 short sentences, MUST begin with exactly "${grade} as graded in hand." Then the physical facts: surfaces/glaze or metal, edges/rim/foot, trim, marks, and EVERY flaw (chips, cracks, crazing, wear, repairs, missing parts), each said once with its location. End with one short warm line about the condition only. Never mention photos, lighting or what could or couldn't be seen; no shipping, returns, payment or marketing words.
- h2: an emoji + the full item name.
- intro: 4-6 sentences that sell it: what it is, who made it, the look and the use or display.
- history: 3-5 TECHNICAL sentences: the maker and where it originated, the material and how it was made (for ceramics: the ceramic body - porcelain, bone china, ironstone, stoneware, earthenware - and the decoration method such as transferware, hand-painting, decals, gilding), the pattern or series and its era, how to read the backstamp/hallmark, and WHY collectors seek it. Only facts you are sure of; leave out anything uncertain.
- details: lines each starting with ONE emoji, in this order, skipping unknowns: "🏭 Maker: …", "🎨 Pattern / Series: …", "🔖 Marks: …" (backstamp or hallmark text), "🌍 Origin: …", "🧱 Material: …", "🖌️ Decoration: …", "📅 Era: …", "📏 Size: …", "🎨 Color: …", "📦 Includes: …" (box, pieces, cord), "✅ Best For: …" (collectors, display, use).
- condition: lines "⚠️ …" for each flaw and "✅ …" for each positive, mirroring Block 1. At least one ✅ line.
- closing: one warm sentence about this piece (no price, no shipping).
- specifics: an object of eBay item specifics for the category above. Fill every REQUIRED one and the recommended ones you know. Use an allowed value when the mode is SELECTION_ONLY; otherwise a short plain value. Never guess a brand: use "Unbranded" only if the category requires Brand and no maker is known.
- etsy_rec: true only if it is truly vintage (20+ years old, with a confirmed era) and the kind of thing Etsy shoppers buy (vintage dishes, pottery, jewelry, decor, Christmas village pieces); etsy_why: one short sentence.
${fix.length ? `\nYOUR PREVIOUS ATTEMPT FAILED THESE CHECKS - FIX EVERY ONE:\n- ${fix.join("\n- ")}\n` : ""}
Respond with ONLY JSON, no fences:
{"ebay_title":"","b1":"","h2":"","intro":"","history":"","details":[""],"condition":[""],"closing":"","specifics":{},"etsy_rec":false,"etsy_why":""}`;
}

// ---------------- Etsy (vintage items only, 20+ years) ----------------
// Etsy's own category list lives in pipeline.etsy_taxonomy (etsy-items-setup). Shortlist the leaf categories whose words match
// the item, then Claude picks one and writes 13 tags.
function whenMade(y: number): string {
  if (y >= 2000) return "2000_2006";
  if (y >= 1900) return `${Math.floor(y / 10) * 10}s`;
  if (y >= 1800) return "1800s";
  if (y >= 1700) return "1700s";
  return "before_1700";
}
const STOP = new Set(["the", "and", "with", "for", "vintage", "antique", "used", "set", "of", "in", "a", "an", "lot", "piece", "pieces", "style", "made", "inch", "in."]);
async function etsyPick(sql: any, ident: any, title: string, model: string) {
  const it = ident.item || {};
  const words = [...new Set([it.type, it.material, it.line_or_pattern, it.decoration, title].join(" ").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(es|s)$/, "")))].slice(0, 25);
  const rows = await sql`select id, path from pipeline.etsy_taxonomy where leaf
      and path ~ '^(Home & Living|Art & Collectibles|Jewelry|Toys & Games|Books, Movies & Music|Accessories|Craft Supplies & Tools)'`;
  const scored = rows.map((r: any) => { const p = String(r.path).toLowerCase(); return { id: Number(r.id), path: r.path, s: words.reduce((t, w) => t + (p.includes(w) ? 1 : 0), 0) }; })
    .filter((r: any) => r.s > 0).sort((a: any, b: any) => b.s - a.s).slice(0, 45);
  const always = rows.filter((r: any) => /(Figurines & Knick Knacks|Dolls & Miniatures|Drinkware|> Plates$|> Bowls$|Serving Odds & Ends|Home Decor > Ornaments|Seasonal Decor|Vinyl Records|Board Games|Jigsaw Puzzles|Collectibles >)/.test(r.path))
    .map((r: any) => ({ id: Number(r.id), path: r.path }));
  const cands = [...new Map([...scored, ...always].map((c: any) => [c.id, c])).values()];
  const out = await claude([{ type: "text", text: `Pick the best Etsy category for this vintage item and write its Etsy tags.
Item: ${JSON.stringify({ title, type: it.type, maker: it.maker, line_or_pattern: it.line_or_pattern, material: it.material, era: it.era, color: it.color })}
Categories (id | path):
${cands.map((c: any) => `${c.id} | ${c.path}`).join("\n")}
tags: exactly 13 Etsy tags for THIS item that shoppers search (maker, pattern, item type, material, era/decade, color, style, gift ideas like "christmas decor"). Each lowercase, 20 characters or fewer, only letters, numbers, spaces, apostrophes and hyphens. No repeats.
Respond ONLY JSON: {"taxonomy_id":0,"tags":[""]}` }], model, 800);
  const tid = Number(out.taxonomy_id);
  const pick = cands.find((c: any) => c.id === tid);
  const tags: string[] = [];
  for (const raw of [...(out.tags || []), "vintage", "vintage find", "retro decor", "collectible", "gift idea", "old fashioned", "vintage gift", "home decor", "nostalgic gift", "estate find", "vintage style", "keepsake", "antique style"]) {
    const t = String(raw || "").toLowerCase().trim().replace(/\s+/g, " ");
    if (t && !tags.includes(t) && t.length <= 20 && /^[a-z0-9 '\-]+$/.test(t)) tags.push(t);
    if (tags.length === 13) break;
  }
  return pick ? { taxonomy_id: pick.id, path: pick.path, tags } : null;
}

// ---------------- step 1: book or item? ----------------
async function checkOne(sql: any, d: any, model: string) {
  const urls = (Array.isArray(d.photos) ? d.photos : []).map((p: any) => String(p.url || "")).filter((u: string) => /^https:\/\//.test(u)).slice(0, 12);
  const content: any[] = [];
  for (let i = 0; i < urls.length; i++) { const b = await photoB64(urls[i]); if (b) { content.push({ type: "text", text: `Photo ${i + 1}` }); content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b } }); } }
  if (!content.length) throw new Error("couldn't load the photos");
  content.push({ type: "text", text: CHECK_PROMPT });
  const out = await claude(content, model, 2500);
  if (out.kind !== "item" || !String(out.title || "").trim()) {
    await sql`update pipeline.drafts set ident = ident || '{"item_check":"book"}'::jsonb, price_stale = true, updated_at = now() - interval '30 seconds' where id = ${d.id}`;
    return { id: d.id, kind: "book" };
  }
  const old = d.ident || {};
  const st = (d.answers && d.answers.station) || {};
  const merged: any = { ...out, kind: "item", item_check: "item", station_read: { title: old.title || "", format: old.format || "" } };
  if (old.grade && st.grade_from_station) merged.grade = old.grade;            // his pick in the Station wins
  if (old.weight_lb) merged.weight_lb = old.weight_lb;
  const flags = (Array.isArray(d.flags) ? d.flags : []).filter((f: string) => !String(f).startsWith("No grade was picked"));
  flags.unshift("🏺 NON-BOOK ITEM — eBay only (never Amazon or AbeBooks). Answer the questions so the write-up is right.");
  if (out.do_not_list) flags.unshift("DO NOT LIST: " + (out.do_not_list_reason || "not family-friendly"));
  const qs = (Array.isArray(out.questions) ? out.questions : []).filter((q: any) => q && q.q && Array.isArray(q.options) && q.options.length >= 2).slice(0, 6);
  qs.push({ q: "Anything the photos can't show?", options: ["None", "Chip or crack", "Repair / glue", "Missing piece", "Other"] });
  await sql`update pipeline.drafts set ident = ${sql.json(merged)}, flags = ${sql.json(flags)}, questions = ${sql.json(qs)},
      channel = ${out.do_not_list ? "dont_list" : "ebay"}, weight_lb = coalesce(weight_lb, ${Number(out.weight_lb) || null}),
      pricing = null, priced_at = null, item_stale = true, price_stale = false, error = null, updated_at = now() - interval '30 seconds'
    where id = ${d.id}`;
  return { id: d.id, kind: "item", title: out.title };
}

// ---------------- step 2: price + write ----------------
async function priceOne(sql: any, d: any, conf: any, dry: boolean) {
  const t0 = Date.now();
  const ident = d.ident || {};
  const grade = String(ident.grade || "Good").trim();
  const model = conf.claude_model || "claude-sonnet-4-6";
  const tok = await ebayToken();
  const it = ident.item || {};
  const q = String(ident.search || [it.maker, it.line_or_pattern, it.type].filter(Boolean).join(" ") || ident.title || "").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const q2 = String(ident.title || "").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const res = await Promise.all([...new Set([q, q2].filter(Boolean))].map((x) => browse(tok, x).catch(() => [])));
  const seen = new Map<string, any>(); for (const x of res.flat()) if (!seen.has(x.itemId)) seen.set(x.itemId, x);
  const me = String(conf.my_ebay_seller || "").toLowerCase();
  const found = [...seen.values()].filter((x) => x.price && +x.price.value > 0 && (!me || String(x.seller?.username || "").toLowerCase() !== me)).slice(0, 60)
    .map((x, k) => ({ i: k + 1, id: String(x.itemId), title: String(x.title || ""), price: +x.price.value, cond: String(x.condition || ""),
      ship: x.shippingOptions?.[0]?.shippingCost ? +x.shippingOptions[0].shippingCost.value : null, seller: String(x.seller?.username || ""),
      url: String(x.itemWebUrl || "").split("?")[0], cats: (x.categories || []).map((c: any) => String(c.categoryId)), sold: 0 as number | null }));
  // judge: same item only, plus Claude's own price call
  const qa = (d.questions || []).map((qq: any, i: number) => ({ q: qq.q, a: (d.answers || {})[String(i)] || "" }));
  const judge = await claude([{ type: "text", text: `Papa Duck is pricing this used item (not a book):
${JSON.stringify({ title: ident.title, item: it, grade, condition_notes: ident.condition_notes, answers: qa })}
Listings for sale now on eBay (i, price, shipping, condition, title):
${found.map((c) => `${c.i}\t$${c.price.toFixed(2)}\t${c.ship == null ? "ship ?" : c.ship ? "+$" + c.ship.toFixed(2) : "free ship"}\t${c.cond}\t${c.title}`).join("\n") || "(none found)"}
Keep ONLY listings that are the SAME item: same maker and line/pattern/model, same kind of piece, comparable size and count. Drop different pieces or patterns, lots/sets when ours is single (or singles when ours is a set), reproductions vs originals, parts/broken listings, new-in-box when ours is used without a box.
fair_list: the price YOU would list ours at given its condition (never the bargain end, never below the cheapest kept listing; if nothing matches, price it from the closest similar items and what this sells for used, and start fair_why with "No direct match:"). band: durable (collectible that holds value) | standard | perishable (common, slow).
Respond ONLY JSON: {"keep":[1,2],"fair_list":0,"fair_why":"","band":"standard"}` }], conf.judge_model || model, 1200);
  const keepSet = new Set((judge.keep || []).map(Number));
  const kept = found.filter((c) => keepSet.has(c.i)).slice(0, 30);
  await soldCounts(tok, kept);
  // his rule (CG): average DELIVERED price of the matching listings - $0.50, never under $9.99; Claude's call when nothing matches
  const minList = Number(conf.min_list_drafts) || 9.99;
  const deliv = kept.map((c) => c.price + (c.ship ?? 0)).sort((a, b) => a - b);
  let list = 0, basis = "", note = "";
  const fair = Number(judge.fair_list) || 0;
  const soldTot = kept.reduce((t, c) => t + (c.sold || 0), 0);
  if (deliv.length) {
    const mid = deliv[Math.floor(deliv.length / 2)];
    const pool = deliv.filter((v) => !(v > mid * 2.5 || v * 2.5 < mid));
    const avg = pool.reduce((t, v) => t + v, 0) / pool.length;
    list = up99(Math.max(avg - 0.5, minList));
    basis = "average delivered price of matching listings - $0.50";
    note = `${kept.length} matching on eBay, delivered $${deliv[0].toFixed(2)}–$${deliv[deliv.length - 1].toFixed(2)}, average $${avg.toFixed(2)}${soldTot ? `, ${soldTot} sold off those listings` : ""} -> list $${list.toFixed(2)}.`;
    if (kept.length <= 2 && fair > list) { list = up99(fair); basis = "Claude's call (only " + kept.length + " match)"; note += ` Thin data — Claude's call $${fair.toFixed(2)} used.`; }
  } else if (fair > 0) {
    list = up99(Math.max(fair, minList)); basis = "Claude's call (no direct eBay match)";
    note = `NO DIRECT eBAY MATCH: ${found.length} listings found, none the same item. ${String(judge.fair_why || "")}`;
  }
  const BANDS: Record<string, number> = { durable: 0.72, standard: 0.65, perishable: 0.58, low: 0.60 };
  const band = list && list < 12 ? "low" : (BANDS[String(judge.band)] ? String(judge.band) : "standard");
  const pr: any = list ? { list, auto: r50(list * 0.8), min: r50(list * BANDS[band]), band, basis, note, n: kept.length, sold_total: soldTot,
      low: deliv[0] ?? null, high: deliv[deliv.length - 1] ?? null, fair: fair || null, no_comps: !kept.length, problems: [] }
    : { error: "No matching items found and no price call — check the title and answers", n: 0 };
  // category + specifics
  const cats = await categoryFor(tok, q || q2, kept);
  const pick = cats.suggestions.find((s: any) => cats.used_by_matches.some(([id]: any) => id === s.id)) || cats.suggestions[0] || null;
  const cat = pick ? { id: pick.id, name: pick.path || pick.name } : { id: "", name: "(eBay had no suggestion)" };
  const aspects = cat.id ? await aspectsFor(tok, cat.id) : [];
  // the listing, with its checks (3 tries)
  let fix: string[] = [], o: any = {}, b1 = "", b2 = "", title = "", fails: string[] = [];
  for (let a = 1; a <= 3; a++) {
    o = await claude([{ type: "text", text: writePrompt(d, grade, cat, aspects, fix) }], model, 4000);
    b1 = String(o.b1 || "").trim(); title = String(o.ebay_title || "").trim(); b2 = buildB2(o, grade);
    fails = validate(b1, b2, title, grade);
    if (!fails.length || Date.now() - t0 > 120000) break;
    fix = fails;
  }
  const missingReq = aspects.filter((x: any) => x.required && !String((o.specifics || {})[x.name] || "").trim()).map((x: any) => x.name);
  if (missingReq.length) fails.push("eBay needs these item specifics: " + missingReq.join(", "));
  if (!cat.id) fails.push("No eBay category found — tell Claude what the item is");
  const yr = Number((String(it.era || "").match(/(1[5-9]\d\d|20\d\d)/) || [])[1]) || 0;
  const vintage = !!yr && yr <= new Date().getFullYear() - 20;
  const etsyRec = { rec: !!o.etsy_rec && vintage, why: String(o.etsy_why || "").slice(0, 200) || (yr ? (vintage ? "" : `${yr} is too new for Etsy (needs 20+ years).`) : "No confirmed era — Etsy needs 20+ years old."),
    year: yr || null, at: new Date().toISOString() };
  // vintage items get their Etsy category, 13 tags and when-made ready, so the Etsy switch in Drafts just works
  let etsy: any = null;
  if (vintage) {
    try { const e = await etsyPick(sql, ident, title || String(ident.title || ""), conf.judge_model || model); if (e) etsy = { ...e, when_made: whenMade(yr), year: yr, section: "Vintage Collectibles" }; }
    catch (e) { etsy = { error: String((e as Error).message || e).slice(0, 200) }; }
  }
  const ebayAll = found.map((c) => c.price).sort((a, b) => a - b);
  const pricing = { ...pr, kind: "item", market: { ebay: { n: kept.length, low: pr.low ?? null, high: pr.high ?? null, sold: soldTot, found: found.length,
        all_low: ebayAll[0] ?? null, all_high: ebayAll[ebayAll.length - 1] ?? null }, at: new Date().toISOString() },
    fair_why: String(judge.fair_why || ""), grade, queries: [q, q2].filter(Boolean),
    used: kept.map((c) => ({ ch: "eBay", seller: c.seller, cond: c.cond, price: c.price, ship: c.ship, sold: c.sold, title: c.title.slice(0, 70), url: c.url })),
    item: { category_id: cat.id, category_name: cat.name, cond_id: 3000, specifics: o.specifics || {}, aspects_required: aspects.filter((x: any) => x.required).map((x: any) => x.name),
      ship: "Calculated Package · USPS Ground Advantage", category_choices: cats.suggestions.slice(0, 5), etsy },
    ebay_title: title, b1, b2, checks_failed: fails, model, at: new Date().toISOString() };
  if (dry) return { ok: true, dry: true, draft: d.id, pricing, etsyRec, secs: Math.round((Date.now() - t0) / 1000) };
  await sql`update pipeline.drafts set pricing = ${sql.json(pricing)}, etsy_rec = ${sql.json(etsyRec)}, priced_at = now(),
      item_stale = (updated_at::text <> ${String(d.stamp_txt)}), price_attempts = 0 where id = ${d.id}`;
  return { ok: true, draft: d.id, title, list: pr.list ?? null, n: kept.length, category: cat.name, checks_failed: fails, secs: Math.round((Date.now() - t0) / 1000) };
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  let id = 0;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (!cfg || req.headers.get("x-backup-secret") !== cfg.value) return json({ error: "not allowed" }, 403);
    const body = await req.json().catch(() => ({}));
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    const model = conf.claude_model || "claude-sonnet-4-6";
    if (body.dry) {
      const [d] = await sql`select *, updated_at::text as stamp_txt from pipeline.drafts where id = ${Number(body.dry)}`;
      if (!d) return json({ ok: false, error: "no such draft" }, 404);
      return json(await priceOne(sql, d, conf, true));
    }
    // 1) book-or-item checks first (they hold a book back from pricing)
    const [c] = await sql`update pipeline.drafts set ident = ident || jsonb_build_object('item_check_claim', now())
      where id = (select id from pipeline.drafts where ident->>'item_check' = 'pending' and built_at is null
                    and (ident->>'item_check_claim' is null or (ident->>'item_check_claim')::timestamptz < now() - interval '3 minutes')
                  order by id limit 1 for update skip locked) returning *`;
    if (c) { id = Number(c.id); return json({ ok: true, check: await checkOne(sql, c, model) }); }
    // 2) price + write one item
    const [d] = await sql`update pipeline.drafts set price_claimed_at = now(), price_attempts = price_attempts + 1
      where id = (select id from pipeline.drafts where ident->>'kind' = 'item' and item_stale and built_at is null and status in ('drafted','sent')
                    and price_attempts < 3 and updated_at < now() - interval '20 seconds'
                    and (price_claimed_at is null or price_claimed_at < now() - interval '3 minutes')
                  order by updated_at limit 1 for update skip locked) returning *, updated_at::text as stamp_txt`;
    if (!d) return json({ ok: true, idle: true });
    id = Number(d.id);
    // the claim itself changed updated_at; keep the stamp from the claimed row so his later edits re-price
    return json(await priceOne(sql, d, conf, false));
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 600);
    if (id) await sql`update pipeline.drafts set error = ${"items-worker: " + msg}, price_claimed_at = null where id = ${id}`.catch(() => null);
    return json({ ok: false, draft: id, error: msg }, 500);
  } finally { await sql.end({ timeout: 5 }); }
});
