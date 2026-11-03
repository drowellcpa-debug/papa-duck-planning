// 🦆 Bargain Duck - "bargain-duck-offers" v5 (v5: no buy alert for books Amazon restricts; v4: the cheapest eBay copies are opened and their ISBN must match ours, overseas sellers flagged; v3: wrong-book guard - keyword hits must match the title; too-cheap copies flagged) (2026-11-03). Papa Duck: "are you sourcing from ebay and abe as well? I will buy used there many times to flip"
// + "give me the various choices with their prices along with grading good, very good, etc show the best grade on top".
// For each watched book that has a sell target: used copies on eBay (Browse API by ISBN) and AbeBooks (search page), price + shipping,
// grade (Like New / Very Good / Good / Acceptable). -> bd.offers (replaced per book), and bd.check.best_* = cheapest copy graded Good or better.
// Then the book's bucket is re-judged with that best price (buy / close). Only touches bd.*.
// POST {} = next 8 books not checked in 20 h. POST {"asins":[...]} = these. POST {"probe":"isbn"} = debug.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const r2 = (x: number) => Math.round(x * 100) / 100;
const isbn13 = (i10: string) => { if (!/^[0-9]{9}[0-9X]$/.test(i10)) return null; const s = "978" + i10.slice(0, 9); let t = 0; for (let i = 0; i < 12; i++) t += Number(s[i]) * (i % 2 ? 3 : 1); return s + ((10 - (t % 10)) % 10); };
const BAD = /international|instructor|teacher'?s|loose[- ]?leaf|access code only|code only|study guide|solutions? manual|test bank|annotated|examination copy|review copy|binder ready|ebook|pdf|digital/i;
function grade(t: string): [string, number] {
  const s = String(t || "").toLowerCase();
  if (/brand new|^new\b|\bnew\s*$|new condition|unused/.test(s) && !/like new/.test(s)) return ["New", 5];
  if (/like new|as new|fine/.test(s)) return ["Like New", 4];
  if (/very good/.test(s)) return ["Very Good", 3];
  if (/acceptable|fair|poor/.test(s)) return ["Acceptable", 1];
  if (/good/.test(s)) return ["Good", 2];
  return [t ? String(t).slice(0, 20) : "Used", 0];
}
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

async function abe(i13: string) {
  const u = `https://www.abebooks.com/servlet/SearchResults?isbn=${i13}&sortby=17&ds=30`;
  const r = await fetch(u, { headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "en-US" } });
  const h = await r.text();
  const out: any[] = [];
  for (const p of h.split(/data-test-id="listing-item-/).slice(1)) {
    const btn = (p.match(/<button data-listingid="(\d+)"[^>]*>/) || [])[0] || "";
    const attr = (k: string) => (btn.match(new RegExp(k + '="([^"]*)"')) || [])[1] || "";
    const price = Number(attr("data-csa-c-cost")), ship = Number(attr("data-csa-c-shipping-cost") || 0), id = attr("data-listingid");
    if (!price || attr("data-csa-c-purchase-currency") !== "USD") continue;
    const cond = attr("data-csa-c-item-condition").replace(/^USED_/, "").replace(/AS_NEW/, "LIKE NEW").replace(/_/g, " ");
    const seller = strip((p.match(/aria-label="Contact seller ([^"]+)"/) || [])[1] || "");
    const title = strip(attr("aria-label").replace(/^Add to basket:\s*/, ""));
    const about = strip((p.match(/data-test-id="description-\d+"[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
    const [g, gr] = grade(cond === "NEW" ? "New" : cond || about);
    out.push({ source: "AbeBooks", grade: g, grade_rank: gr, price, ship, total: r2(price + ship), url: `https://www.abebooks.com/servlet/BookDetailsPL?bi=${id}`, seller,
      note: (BAD.test(title + " " + about) ? "⚠ " : "") + about.slice(0, 120) });
  }
  return out;
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const K = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
    const e = K.ebay;
    const t = await fetch("https://api.ebay.com/identity/v1/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(`${e.app_id}:${e.cert_id}`) },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }).toString() });
    const tok = (await t.json()).access_token;
    const words = (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !/^(with|from|edition|and|the|for|book|paperback|hardcover)$/.test(w));
    const sameBook = (keepa: string, t: string) => { const k = words(keepa).slice(0, 5), e = new Set(words(t)); if (!k.length) return true; return k.filter((w) => e.has(w)).length >= Math.min(2, k.length) && e.has(k[0]); };
    const ebay = async (i13: string, ktitle = "") => {
      const seen = new Set<string>(), all: any[] = [];
      for (const mode of ["gtin", "q"]) {
        const u = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
        u.searchParams.set(mode, i13); u.searchParams.set("limit", "50"); u.searchParams.set("category_ids", "267");
        u.searchParams.set("filter", "buyingOptions:{FIXED_PRICE},priceCurrency:USD,deliveryCountry:US");
        const r = await fetch(u.toString(), { headers: { Authorization: "Bearer " + tok, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US", "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=US,zip=97030" } });
        const j = await r.json();
        for (const x of (j.itemSummaries || [])) { if (!seen.has(x.itemId) && (mode === "gtin" || sameBook(ktitle, x.title))) { seen.add(x.itemId); all.push(x); } }
      }
      return all.map((x: any) => {
        const price = Number(x.price?.value || 0), sh = x.shippingOptions?.[0]?.shippingCost?.value;
        const [g, gr] = grade(x.condition || "");
        const ship = sh != null ? Number(sh) : 0;
        const away = x.itemLocation?.country && x.itemLocation.country !== "US";
        return { source: "eBay", id: x.itemId, grade: g, grade_rank: gr, price, ship, total: r2(price + ship), url: String(x.itemWebUrl || "").split("?")[0], seller: x.seller?.username || "",
          note: (BAD.test(x.title || "") ? "⚠ " : away ? `⚠ ships from ${x.itemLocation.country} - often an international edition. ` : "") + String(x.title || "").slice(0, 120) + (sh == null ? " (shipping not shown)" : "") };
      }).filter((o: any) => o.price > 0);
    };
    if (b.probe) {
      const i13 = isbn13(String(b.probe)) || String(b.probe);
      return json({ ebay: (await ebay(i13, String(b.title || ""))).slice(0, 8), abe: (await abe(i13)).slice(0, 8) });
    }
    const list = b.asins?.length ? await sql`select w.asin, c.sell_target, c.buy_target, c.used, coalesce(c.title_keepa, w.title) kt, w.amz_ok from bd.watch w join bd.check c using(asin) where w.asin = any(${b.asins})`
      : await sql`select w.asin, c.sell_target, c.buy_target, c.used, coalesce(c.title_keepa, w.title) kt, w.amz_ok from bd.watch w join bd.check c using(asin)
          where w.status = 'watching' and c.buy_target is not null and (c.offers_at is null or c.offers_at < now() - interval '20 hours') order by c.offers_at nulls first limit 8`;
    const S = Object.fromEntries((await sql`select k, v from bd.settings`).map((r: any) => [r.k, Number(r.v)]));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const done: any[] = [], newBuys: string[] = [];
    for (const w of list as any[]) {
      const i13 = isbn13(w.asin); if (!i13) continue;
      let offers: any[] = [];
      try { offers = offers.concat(await ebay(i13, w.kt)); } catch (_) {}
      try { offers = offers.concat(await abe(i13)); } catch (_) {}
      // a copy for under 35% of Amazon's lowest used / last season's price is usually the wrong edition or book
      const ref = Math.min(Number(w.used) || Infinity, Number(w.sell_target) || Infinity);
      for (const o of offers) if (ref < Infinity && o.total < ref * 0.35 && !String(o.note).startsWith("⚠")) o.note = "⚠ price looks too low - check edition. " + o.note;
      // 2026-11-03 Papa Duck: "check them for me so I know that the editions are correct ... that is a big pain point"
      // open the 4 cheapest Good-or-better eBay copies; the listing's ISBN must be ours (one was the 11th edition hardcover when we price the 12th)
      const cands = offers.filter((o) => o.source === "eBay" && o.grade_rank >= 2 && !String(o.note).startsWith("⚠")).sort((a, b) => a.total - b.total).slice(0, 4);
      for (const o of cands) {
        try {
          const g = await (await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(o.id)}`, { headers: { Authorization: "Bearer " + tok, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } })).json();
          if (g.errors) { o.note = "⚠ listing ended. " + o.note; continue; }
          const asp: Record<string, string> = Object.fromEntries((g.localizedAspects || []).map((a: any) => [a.name, String(a.value || "")]));
          const isb = [g.gtin, asp["ISBN"], asp["ISBN-13"], asp["ISBN-10"]].filter(Boolean).join(",").replace(/[^0-9X,]/gi, "");
          if (!isb) o.note = "⚠ no ISBN on the listing - ask the seller before buying. " + o.note;
          else if (!isb.split(",").some((v) => v === i13 || v === w.asin)) o.note = `⚠ wrong edition (ISBN ${isb.split(",")[0]}${asp["Edition"] ? ", " + asp["Edition"] + " ed." : ""}). ` + o.note;
          else o.note = "✓ ISBN matches. " + o.note;
        } catch (_) {}
      }
      await sql.begin(async (tx: any) => {
        await tx`delete from bd.offers where asin = ${w.asin}`;
        for (const o of offers.slice(0, 80)) await tx`insert into bd.offers (asin, source, grade, grade_rank, price, ship, total, url, seller, note)
          values (${w.asin}, ${o.source}, ${o.grade}, ${o.grade_rank}, ${o.price}, ${o.ship}, ${o.total}, ${o.url}, ${o.seller}, ${o.note})`;
      });
      const good = offers.filter((o) => o.grade_rank >= 2 && (o.source === "AbeBooks" ? !String(o.note).startsWith("⚠") : String(o.note).startsWith("✓")) && !String(o.note).includes("shipping not shown")).sort((a, b) => a.total - b.total)[0];
      const [prev] = await sql`select bucket, used, title_keepa from bd.check where asin = ${w.asin}`;
      let bucket = prev?.bucket;
      const bt = Number(w.buy_target);
      if (good && bt && ["watching", "close", "buy"].includes(bucket)) {
        const best = Math.min(good.total, prev.used ?? Infinity);
        const nb = best <= bt ? "buy" : best <= bt * (1 + (S.close_pct ?? 0.2)) ? "close" : "watching";
        if (nb === "buy" && bucket !== "buy" && w.amz_ok !== false) newBuys.push(`${String(prev.title_keepa || w.asin).slice(0, 60)} - ${good.grade} on ${good.source} $${good.total.toFixed(2)} shipped (buy at $${bt.toFixed(2)} or less)`);
        if (rank(nb) > rank(bucket)) bucket = nb;
      }
      await sql`update bd.check set best_total = ${good ? good.total : null}, best_source = ${good ? good.source : null}, best_grade = ${good ? good.grade : null}, offers_at = now(),
        bucket = ${bucket}, bucket_since = case when bucket = ${bucket} then bucket_since else ${today}::date end where asin = ${w.asin}`;
      done.push({ asin: w.asin, n: offers.length, best: good ? `${good.grade} ${good.source} ${good.total}` : null, bucket });
    }
    if (newBuys.length) await sql`select pipeline.alert_add('Bargain Duck', ${"🦆 " + newBuys.length + " book" + (newBuys.length === 1 ? "" : "s") + " in the buy zone on eBay/AbeBooks"},
        ${newBuys.join(" · ") + ". See the Bargain Duck card."}, null, null, 'issue', ${"bdo:" + today + ":" + Date.now()})`;
    return json({ ok: true, checked: done.length, done, newBuys });
  } catch (er) { return json({ ok: false, error: String((er as Error).message || er).slice(0, 300) }, 500); }
  finally { await sql.end({ timeout: 3 }); }
});
function rank(b: string) { return b === "buy" ? 3 : b === "close" ? 2 : b === "watching" ? 1 : 0; }
