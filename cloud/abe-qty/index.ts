// Papa Duck - Edge Function "abe-qty" v6 (2026-11-22). v5 (2026-11-17). v4 (2026-11-04; v2: strips copy-count wording from the description; v3: no qty = keep current, skips when nothing changes; v4: also "units", keeps print-run/set wording). Papa Duck: "can you dig deeper on abe books, I cant believe they have no api way of chaning quanity".
// v6 (2026-11-22, "these changes effect everything not just the airtable"): {"pd","title"} renames the AbeBooks listing too (qty kept).
// v5 (2026-11-17, "abe books you could not set the count down, we have already figured out a way to do this, please make this automatic for me"):
//   the AbeBooks listing number is no longer required. When it isn't passed (or the store audit doesn't have it), this finds it in his own
//   AbeBooks store by searching his PD number (kn=PD-xxxx, the same search the Launch Pad live check uses), then by title.
//   Not in his AbeBooks store at all (e.g. a non-book that was never on AbeBooks) -> nothing to change, answers {ok, not_on_abe}.
//   {alert:true} (sent by the sale trigger): if the count could NOT be set, a Launch Pad 'need' card says so; if it worked, any old card closes.
// AbeBooks' Inventory Update API has no quantity-only call: an "add" with the same vendorBookID REPLACES the whole listing, and any field left out is wiped.
// So this copies the listing's own details from its public AbeBooks page (title, author, publisher, year, binding, condition, description, price, ISBN,
// first edition / signed / jacket flags) and sends them back complete with the new quantity. Photos are NOT sent (uploaded separately by file name).
// POST {"pd":"PD-1279","lid":"32508032209","qty":1,"dry":true}  lid optional. dry = build + show the XML only.  Every page and XML is kept in pipeline.abe_probe.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const VCI = "91371820";   // his AbeBooks store
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Papa Duck 2026-11-04: copy counts ("Two identical copies available") "should never be on the wording of any description" - stripped on every send.
const NUM = "\\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple";
export const isCount = (s: string) => /\b(cop(y|ies)|units?)\b/i.test(s) && !/no longer available|new copies|spare copy|lot of identical copies|need(ing|s)? (multiple|matching) copies|printing|print run|numbered|limited to|edition of|copies (sold|in print|included)|\binclud(e|es|ed|ing)\b|\bset\b|bundle/i.test(s) &&
  (new RegExp(`\\b(${NUM})\\b[^.;]*\\b(copies|units)\\b`, "i").test(s) || /\b(copies|units) (are )?(available|on hand)\b/i.test(s) || /\bquantity\b/i.test(s));
export const cleanDesc = (d: string) => { const p = String(d || "").split(/(?<=[.!?])(\s+)/); let o = ""; for (let i = 0; i < p.length; i += 2) if (!(p[i] && isCount(p[i]))) o += p[i] + (p[i + 1] || ""); return o.replace(/\s{2,}/g, " ").trim(); };
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const words = (t: string, n: number) => String(t || "").replace(/['’‘]/g, "").replace(/["“”:;,.!?()\[\]]/g, " ").split(/\s+/).filter(Boolean).slice(0, n).join(" ");

// v5: find the listing number in his own store. "busy" = AbeBooks didn't answer (try later); "" = not in his store.
export async function findLid(pd: string, title: string): Promise<string> {
  const re = new RegExp(pd.replace("-", "\\-") + "(?![0-9])");
  let answered = false;
  for (const q of ["kn=" + encodeURIComponent(pd), title ? "tn=" + encodeURIComponent(words(title, 6)) : "", title ? "tn=" + encodeURIComponent(words(title, 3)) : ""]) {
    if (!q) continue;
    let html = "";
    for (let a = 0; a < 3 && !html; a++) {
      try {
        const r = await fetch(`https://www.abebooks.com/servlet/SearchResults?vci=${VCI}&${q}&rollup=off`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(25000) });
        if (r.status === 200) html = await r.text(); else await sleep(3000 * (a + 1));
      } catch (_) { await sleep(3000 * (a + 1)); }
    }
    if (!html) continue;
    answered = true;
    const b = html.split('data-test-id="listing-item-').slice(1).find((x) => re.test(x));
    const id = b ? /^([0-9]+)/.exec(b)?.[1] || "" : "";
    if (id) return id;
  }
  return answered ? "" : "busy";
}

export async function readListing(lid: string) {
  const html = await (await fetch(`https://www.abebooks.com/servlet/BookDetailsPL?bi=${lid}`, { headers: { "User-Agent": UA, Accept: "text/html" } })).text();
  let flight = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) { try { flight += JSON.parse(m[1]); } catch { /* skip */ } }
  const at = flight.indexOf(`"listing":{"listingId":${lid}`);
  if (at < 0) return { html, listing: null };
  let i = flight.indexOf("{", at + 9), d = 0, inStr = false, j = i;
  for (; j < flight.length; j++) {
    const c = flight[j];
    if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") d++; else if (c === "}") { d--; if (d === 0) break; }
  }
  return { html, listing: JSON.parse(flight.slice(i, j + 1)) };
}

export function buildXml(L: any, pd: string, qty: number, user: string, pass: string) {
  const bsa: string[] = L.bsaCodes || [];
  const hard = /hard/i.test(L.binding || "") || bsa.includes("HARD_COVER");
  const isbn = L.isbn13 || L.isbn10 || L.isbn || "";
  const t = [
    `<transactionType>add</transactionType>`, `<vendorBookID>${esc(pd)}</vendorBookID>`,
    L.author ? `<author>${esc(L.author)}</author>` : "", `<title>${esc(L.title)}</title>`,
    L.publisher ? `<publisher>${esc(L.publisher)}</publisher>` : "",
    `<price currency="${esc(L.priceInPurchaseCurrency?.currency || "USD")}">${Number(L.priceInPurchaseCurrency?.amount).toFixed(2)}</price>`,
    L.binding ? `<binding type="${hard ? "hard" : "soft"}">${esc(L.binding)}</binding>` : "",
    `<firstEdition>${bsa.includes("FIRST_EDITION") ? "true" : "false"}</firstEdition>`,
    `<signed>${bsa.includes("SIGNED") ? "true" : "false"}</signed>`,
    bsa.includes("DUST_JACKET") ? `<dustJacket>true</dustJacket>` : "",
    L.jacketCondition ? `<jacketCondition>${esc(L.jacketCondition)}</jacketCondition>` : "",
    `<description>${esc(cleanDesc(L.description))}</description>`,
    L.vendorCondition ? `<bookCondition>${esc(L.vendorCondition)}</bookCondition>` : "",
    L.illustrator ? `<illustrator>${esc(L.illustrator)}</illustrator>` : "",
    isbn ? `<isbn>${esc(isbn)}</isbn>` : "",
    L.publishPlace ? `<publishPlace>${esc(L.publishPlace)}</publishPlace>` : "",
    L.publishYear ? `<publishYear>${esc(L.publishYear)}</publishYear>` : "",
    L.edition ? `<editionList><edition>${esc(L.edition)}</edition></editionList>` : "",
    `<quantity amount="${qty}"></quantity>`,
  ].filter(Boolean).map((x) => "      " + x).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<inventoryUpdateRequest version="1.0">\n  <action name="bookupdate">\n    <username>${esc(user)}</username>\n    <password>${esc(pass)}</password>\n  </action>\n  <AbebookList>\n    <Abebook>\n${t}\n    </Abebook>\n  </AbebookList>\n</inventoryUpdateRequest>\n`;
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const out = async (o: any, s = 200) => {
      if (b.alert && /^PD-/i.test(String(b.pd || ""))) {
        const P = String(b.pd).toUpperCase();
        if (!o.ok && !o.not_on_abe) await sql`select pipeline.alert_add('AbeBooks', ${P + " — set AbeBooks copies to " + b.qty}, ${"A copy sold elsewhere and I could not lower the AbeBooks count automatically: " + String(o.error || "unknown").slice(0, 200)}, ${P}, null, 'need', ${"abeqty-" + P + "-" + b.qty})`.catch(() => null);
        else await sql`update pipeline.alerts set kind = 'handled' where source = 'AbeBooks' and pd = ${P} and kind = 'need' and title like '%set AbeBooks copies%'`.catch(() => null);
      }
      return json(o, s);
    };
    const T = "@" + Date.now(), pd = String(b.pd || "").toUpperCase(), qty = Number(b.qty);
    const newTitle = String(b.title || "").replace(/\s+/g, " ").trim().slice(0, 500);
    let lid = String(b.lid || "").replace(/\D/g, "");
    if (!/^PD-\w+$/.test(pd) || !(b.qty == null || (qty >= 1 && qty <= 999))) return await out({ ok: false, error: "need pd, qty 1-999 (or no qty = keep)" }, 400);
    if (!lid) {
      lid = await findLid(pd, String(b.title || ""));
      if (lid === "busy") return await out({ ok: false, busy: true, error: "AbeBooks did not answer the store search - try again later" });
      if (!lid) return await out({ ok: true, not_on_abe: true, pd, note: "not in the AbeBooks store - nothing to change" });    }
    const before = await readListing(lid);
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"abeqty-before:" + pd + T}, ${before.html}, now())`;
    const L = before.listing;
    if (!L) return await out({ ok: false, error: "could not read the listing page", lid });
    if (String(L.vendorListingId || "").toUpperCase() !== pd) return await out({ ok: false, error: `listing ${lid} is ${L.vendorListingId}, not ${pd}` });
    const titleChanged = newTitle.length >= 3 && newTitle !== String(L.title || "");
    if (titleChanged) L.title = newTitle;
    const K = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).abe;
    const q = b.qty == null ? Number(L.quantity) : qty, descChanged = cleanDesc(L.description) !== String(L.description || "").replace(/\s{2,}/g, " ").trim();
    if (!descChanged && !titleChanged && q === Number(L.quantity)) return await out({ ok: true, nothing: true, pd, lid, qty: q });
    const xml = buildXml(L, pd, q, K.username, K.password);
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"abeqty-xml:" + pd + T}, ${xml.replace(/<password>[^<]*</, "<password>***<")}, now())`;
    const keep = (x: any) => x && ({ qty: x.quantity, title: x.title, author: x.author, publisher: x.publisher, year: x.publishYear, binding: x.binding, cond: x.vendorCondition,
      price: x.priceInPurchaseCurrency?.amount, ship: (x.shippingRates || []).map((r: any) => r.shippingPriceInPurchaseCurrency?.amount), pics: (x.pictureSequence || []).length,
      bsa: x.bsaCodes, desc: String(x.description || "").slice(0, 80), isbn: x.isbn13 || x.isbn10 || "" });
    if (b.dry) return await out({ ok: true, dry: true, lid, descChanged, titleChanged, desc_after: cleanDesc(L.description), before: keep(L), xml: xml.replace(/<password>[^<]*</, "<password>***<") });
    const res = await (await fetch("https://inventoryupdate.abebooks.com:10027", { method: "POST", body: xml, headers: { "Content-Type": "text/xml; charset=utf-8" } })).text();
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"abeqty-res:" + pd + T}, ${res}, now())`;
    const ok = /<code>600<\/code>/.test(res);
    await new Promise((r) => setTimeout(r, Number(b.wait || 20000)));
    const after = await readListing(lid);
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"abeqty-after:" + pd + T}, ${after.html}, now())`;
    return await out({ ok, lid, res: res.replace(/\s+/g, " ").slice(0, 400), before: keep(L), after: keep(after.listing) });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);   // (trigger calls: the next audit catches it)
  } finally { await sql.end({ timeout: 3 }); }
});
