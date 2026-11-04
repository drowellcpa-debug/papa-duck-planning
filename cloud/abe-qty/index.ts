// Papa Duck - Edge Function "abe-qty" v3 (2026-11-04; v2: strips copy-count wording from the description; v3: no qty = keep current, skips when nothing changes). Papa Duck: "can you dig deeper on abe books, I cant believe they have no api way of chaning quanity".
// AbeBooks' Inventory Update API has no quantity-only call: an "add" with the same vendorBookID REPLACES the whole listing, and any field left out is wiped.
// So this copies the listing's own details from its public AbeBooks page (title, author, publisher, year, binding, condition, description, price, ISBN,
// first edition / signed / jacket flags) and sends them back complete with the new quantity. Photos are NOT sent (uploaded separately by file name).
// POST {"pd":"PD-1279","lid":"32508032209","qty":1,"dry":true}  dry = build + show the XML only.  Every page and XML is kept in pipeline.abe_probe.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
// Papa Duck 2026-11-04: copy counts ("Two identical copies available") "should never be on the wording of any description" - stripped on every send.
const NUM = "\\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple";
export const isCount = (s: string) => /\b(cop(y|ies)|units?)\b/i.test(s) && !/no longer available|new copies|spare copy|lot of identical copies|need(ing|s)? (multiple|matching) copies|printing|print run|numbered|limited to|edition of|copies (sold|in print|included)|\binclud(e|es|ed|ing)\b|\bset\b|bundle/i.test(s) &&
  (new RegExp(`\\b(${NUM})\\b[^.;]*\\b(copies|units)\\b`, "i").test(s) || /\b(copies|units) (are )?(available|on hand)\b/i.test(s) || /\bquantity\b/i.test(s));
export const cleanDesc = (d: string) => { const p = String(d || "").split(/(?<=[.!?])(\s+)/); let o = ""; for (let i = 0; i < p.length; i += 2) if (!(p[i] && isCount(p[i]))) o += p[i] + (p[i + 1] || ""); return o.replace(/\s{2,}/g, " ").trim(); };
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
    const T = "@" + Date.now(), pd = String(b.pd || "").toUpperCase(), lid = String(b.lid || "").replace(/\D/g, ""), qty = Number(b.qty);
    if (!/^PD-\w+$/.test(pd) || !lid || !(b.qty == null || (qty >= 1 && qty <= 999))) return json({ ok: false, error: "need pd, lid, qty 1-999 (or no qty = keep)" }, 400);
    const before = await readListing(lid);
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"abeqty-before:" + pd + T}, ${before.html}, now())`;
    const L = before.listing;
    if (!L) return json({ ok: false, error: "could not read the listing page" });
    if (String(L.vendorListingId || "").toUpperCase() !== pd) return json({ ok: false, error: `listing ${lid} is ${L.vendorListingId}, not ${pd}` });
    const K = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).abe;
    const q = b.qty == null ? Number(L.quantity) : qty, descChanged = cleanDesc(L.description) !== String(L.description || "").replace(/\s{2,}/g, " ").trim();
    if (!descChanged && q === Number(L.quantity)) return json({ ok: true, nothing: true, pd, qty: q });
    const xml = buildXml(L, pd, q, K.username, K.password);
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"abeqty-xml:" + pd + T}, ${xml.replace(/<password>[^<]*</, "<password>***<")}, now())`;
    const keep = (x: any) => x && ({ qty: x.quantity, title: x.title, author: x.author, publisher: x.publisher, year: x.publishYear, binding: x.binding, cond: x.vendorCondition,
      price: x.priceInPurchaseCurrency?.amount, ship: (x.shippingRates || []).map((r: any) => r.shippingPriceInPurchaseCurrency?.amount), pics: (x.pictureSequence || []).length,
      bsa: x.bsaCodes, desc: String(x.description || "").slice(0, 80), isbn: x.isbn13 || x.isbn10 || "" });
    if (b.dry) return json({ ok: true, dry: true, descChanged, desc_after: cleanDesc(L.description), before: keep(L), xml: xml.replace(/<password>[^<]*</, "<password>***<") });
    const res = await (await fetch("https://inventoryupdate.abebooks.com:10027", { method: "POST", body: xml, headers: { "Content-Type": "text/xml; charset=utf-8" } })).text();
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"abeqty-res:" + pd + T}, ${res}, now())`;
    const ok = /<code>600<\/code>/.test(res);
    await new Promise((r) => setTimeout(r, Number(b.wait || 20000)));
    const after = await readListing(lid);
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"abeqty-after:" + pd + T}, ${after.html}, now())`;
    return json({ ok, res: res.replace(/\s+/g, " ").slice(0, 400), before: keep(L), after: keep(after.listing) });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
