// Papa Duck — Amazon FBA Stage 1 worker logic (2026-10-07; v4 2026-10-28 weekly board).
// Papa Duck: "in the draft I need to be able to click when a book is going to FBA which means it will be exclusive to
// Amazon and not on the others. When the book is clicked it needs to automatically go and get the sku label and print it
// so I can slap it on the book and put in the box."
// v4 (2026-10-28): "I want fba ready before I even sit down so I can just print labels and pack the box when I am ready"
//   - books from the Launch Pad weekly board have NO draft (older inventory): draft_id null, condition note in it.note
//   - prep = true: the FBA offer + FNSKU are made ahead (no stock, so nothing can sell) and Airtable is NOT touched;
//     when he checks the book off, prep goes false and Airtable is written then. A prep book taken off the board is
//     deleted on Amazon without touching Airtable.
//   - a book with no draft never overwrites his Airtable title, cost, source, photos or descriptions.
// Flow per book (pipeline.fba_items.status):
//   queued        -> PUT the Amazon offer on the existing ASIN page, fulfilled by Amazon (AMAZON_NA), SKU = PD number
//   waiting_fnsku -> read the listing until Amazon hands back the FNSKU (X00...) the sticker carries
//   ready         -> waits for a print
//   removing      -> (Undo FBA / taken off the board) offer deleted on Amazon -> removed
//   error         -> shown with Amazon's own words; "Try again" puts it back to queued
import { Amazon, AT, Ctx, T_INV } from "./fba_core.ts";

export const AMZ_MKT = "ATVPDKIKX0DER";
export type Item = {
  id: number; draft_id: number | null; pd: string; box: number; asin: string; cond: string; price: number; product_type: string | null;
  title: string | null; author: string | null; cover: string | null; status: string; fnsku: string | null; error: string | null;
  attempts: number; airtable_id: string | null; airtable_dirty: boolean; created_at?: string; note?: string | null; prep?: boolean;
};
export type Draft = { id: number; pd: string; ident: any; answers: any; pricing: any; weight_lb: number | null; photos: any[] };
export type Store = {
  draft: (id: number | null) => Promise<Draft | null>;
  update: (id: number, patch: Record<string, unknown>, log?: string) => Promise<void>;
  draftBack: (draftId: number | null) => Promise<void>;          // Undo: back to To check
};

export const COND_LABEL: Record<string, string> = { new_new: "New", used_like_new: "Used - Like New", used_very_good: "Used - Very Good",
  used_good: "Used - Good", used_acceptable: "Used - Acceptable" };
const GRADE: Record<string, string> = { used_like_new: "Like New", used_very_good: "Very Good", used_good: "Good", used_acceptable: "Acceptable", new_new: "Brand New" };
const IV = { track: "fldxiwKYi6z1t0iDx", title: "fld4IZiZDz3Glnf7B", author: "fldToxEOqQy79EU3s", isbn: "fld8WfHln7hrZulAm", pub: "fldgABojxKdIZvxBn",
  acquired: "fld8vJapR4q535Nux", source: "fldDPZGsFXJ2kjOdG", cost: "fldyhCaL3G2km40fk", cond: "fldJtabBqrAQKabzS", channel: "fldfIvQkSqMc2gvL9",
  status: "fldK5pTHj5iCEmf0w", list: "fldqfykAq3wumx32C", shelf: "flduz8HOLS4UHMbQ1", notes: "fldBKdOjkh7OYKqXc", b2: "fldrnXWPJGjPj0Aih",
  b1: "fldLqaMd9rjDzi1kx", pics: "fldGcWb5ulMBU5jee", qty: "fld7MrQXX1D8iD0ap", weight: "fldIUfEuYoYofUJ5H", asin: "fldXpjtfGL5XC3nLR",
  amzDate: "fldz7squdnWkMuIYN", assign: "fldEi53MkoOuOGKGM" };
export const FBA_STATUS = "FBA – in box";

const errText = (r: { j: any; raw: string; status: number }) => {
  const iss = [...(r.j?.issues || []).filter((i: any) => i.severity === "ERROR"), ...(r.j?.errors || [])];
  return iss.map((i: any) => `${i.code || ""} ${i.message || ""}`.trim()).join("; ").slice(0, 400) || `HTTP ${r.status} ${r.raw.slice(0, 200)}`;
};

export async function productType(amz: Amazon, it: Item): Promise<string> {
  if (it.product_type) return it.product_type;
  const r = await amz.api("GET", `/catalog/2022-04-01/items/${it.asin}`, { marketplaceIds: AMZ_MKT, includedData: "productTypes" });
  return r.j?.productTypes?.[0]?.productType || "ABIS_BOOK";
}

export function offerBody(it: Item, pt: string, note: string) {
  return { productType: pt, requirements: "LISTING_OFFER_ONLY", attributes: {
    merchant_suggested_asin: [{ value: it.asin, marketplace_id: AMZ_MKT }],
    condition_type: [{ value: it.cond, marketplace_id: AMZ_MKT }],
    condition_note: [{ value: note.slice(0, 1000), language_tag: "en_US", marketplace_id: AMZ_MKT }],
    purchasable_offer: [{ audience: "ALL", currency: "USD", marketplace_id: AMZ_MKT, our_price: [{ schedule: [{ value_with_tax: Math.round(Number(it.price) * 100) / 100 }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_NA" }],
    // FBA asks for these two on every offer (Amazon 90220 on the 2026-10-07 preview); a printed book has neither
    batteries_required: [{ value: false, marketplace_id: AMZ_MKT }],
    supplier_declared_dg_hz_regulation: [{ value: "not_applicable", marketplace_id: AMZ_MKT }] } };
}

/** PUT the FBA offer. preview=true asks Amazon to check it without listing anything. */
export async function putOffer(amz: Amazon, seller: string, it: Item, note: string, preview = false) {
  const pt = await productType(amz, it);
  const params: Record<string, string> = { marketplaceIds: AMZ_MKT, issueLocale: "en_US" };
  if (preview) params.mode = "VALIDATION_PREVIEW";
  const r = await amz.api("PUT", `/listings/2021-08-01/items/${seller}/${encodeURIComponent(it.pd)}`, params, offerBody(it, pt, note));
  const errs = (r.j?.issues || []).filter((i: any) => i.severity === "ERROR").length + (r.j?.errors || []).length;
  const ok = (r.j?.status === "ACCEPTED" || r.j?.status === "VALID") && !errs;
  return { ok, pt, status: r.j?.status || `HTTP ${r.status}`, why: ok ? "" : errText(r), transient: r.status === 429 || r.status >= 500,
    warnings: (r.j?.issues || []).filter((i: any) => i.severity === "WARNING").map((i: any) => i.message).slice(0, 3) };
}

/** The FNSKU: listing summary first, then FBA inventory. "" while Amazon is still making it. */
export async function readFnsku(amz: Amazon, seller: string, pd: string): Promise<{ fnsku: string; error: string }> {
  const g = await amz.api("GET", `/listings/2021-08-01/items/${seller}/${encodeURIComponent(pd)}`,
    { marketplaceIds: AMZ_MKT, includedData: "summaries,issues", issueLocale: "en_US" });
  if (g.status === 404) return { fnsku: "", error: "" };                       // not visible yet - normal for a minute or two
  const sm = g.j?.summaries?.[0] || {};
  const errs = (g.j?.issues || []).filter((i: any) => i.severity === "ERROR");
  const fn = String(sm.fnSku || sm.fnsku || "");
  if (/^[A-Z0-9]{10}$/.test(fn)) return { fnsku: fn, error: "" };
  if (errs.length) return { fnsku: "", error: errs.map((i: any) => `${i.code} ${i.message}`).join("; ").slice(0, 400) };
  const inv = await amz.api("GET", "/fba/inventory/v1/summaries", { granularityType: "Marketplace", granularityId: AMZ_MKT, marketplaceIds: AMZ_MKT, sellerSkus: pd });
  const s = (inv.j?.payload?.inventorySummaries || []).find((x: any) => String(x.sellerSku || "").toUpperCase() === pd.toUpperCase());
  const fn2 = String(s?.fnSku || "");
  return { fnsku: /^[A-Z0-9]{10}$/.test(fn2) ? fn2 : "", error: "" };
}

export function airtableFields(it: Item, d: Draft | null, removed = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (removed) return { [IV.track]: it.pd, [IV.status]: "Unlisted", [IV.shelf]: "", [IV.assign]: null, [IV.amzDate]: null,
    [IV.notes]: `FBA undone ${today} - back in To check on the Drafts page.` };
  if (!d) {
    // older inventory from the weekly board: only the FBA facts; his title, cost, source, photos, descriptions and notes stay as they are
    return { [IV.track]: it.pd, [IV.status]: FBA_STATUS, [IV.channel]: "Amazon FBA", [IV.assign]: "Amazon", [IV.shelf]: `FBA Box ${it.box}`,
      [IV.list]: Number(it.price), [IV.qty]: 1, [IV.asin]: it.asin, [IV.amzDate]: today };
  }
  const i = d?.ident || {}, st = d?.answers?.station || {}, p = d?.pricing || {};
  const pics = (d?.photos || []).filter((x: any) => !x.removed && String(x.url || "").startsWith("https://")).map((x: any) => x.url).join("|");
  const author = i.author || it.author || "";
  const isbn = String(i.isbn || "");
  const f: Record<string, unknown> = {
    [IV.track]: it.pd, [IV.title]: (String(i.title || it.title || "") + (author ? " - " + author : "")).slice(0, 250), [IV.author]: author,
    [IV.pub]: i.publisher, [IV.isbn]: /\d/.test(isbn) && isbn.length < 40 ? isbn : "", [IV.cond]: GRADE[it.cond] || i.grade,
    [IV.status]: FBA_STATUS, [IV.channel]: "Amazon FBA", [IV.assign]: "Amazon", [IV.shelf]: `FBA Box ${it.box}`,
    [IV.list]: Number(it.price), [IV.qty]: 1, [IV.cost]: Number(st.cost || 0), [IV.source]: st.vendor || "",
    [IV.acquired]: today, [IV.weight]: d?.weight_lb ? Math.ceil(Number(d.weight_lb)) : null,
    [IV.pics]: pics, [IV.b1]: p.b1 || "", [IV.b2]: p.b2 || "", [IV.asin]: it.asin, [IV.amzDate]: today,
    [IV.notes]: `Amazon FBA only (not on eBay / AbeBooks / Etsy). Box ${it.box}.` + (it.fnsku ? ` FNSKU ${it.fnsku}.` : " FNSKU pending.") };
  for (const k of Object.keys(f)) if (f[k] === "" && k !== IV.shelf) delete f[k];
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

export async function writeAirtable(at: AT, it: Item, d: Draft | null, removed = false): Promise<string> {
  const r = await at.req("PATCH", T_INV, "", { performUpsert: { fieldsToMergeOn: [IV.track] }, typecast: true, returnFieldsByFieldId: true,
    records: [{ fields: airtableFields(it, d, removed) }] });
  return r.records?.[0]?.id || "";
}

/** One pass over the waiting books. Returns a short line per book. */
export async function work(ctx: Ctx, store: Store, items: Item[], amz: Amazon, seller: string, at: AT | null, opts: { pollMs?: number; polls?: number } = {}) {
  const out: string[] = [];
  const later = (n: number) => new Date(ctx.now().getTime() + Math.min(300, 20 * Math.max(1, n)) * 1000).toISOString();
  const syncAT = async (it: Item, d: Draft | null) => {
    if (!at || !it.airtable_dirty || it.prep) return;          // made ahead: Airtable waits until he checks the book off
    try { const id = await writeAirtable(at, it, d); await store.update(it.id, { airtable_id: id, airtable_dirty: false }, "Airtable written"); it.airtable_dirty = false; }
    catch (e) { await store.update(it.id, {}, "Airtable failed: " + String((e as Error).message).slice(0, 200)); out.push(`${it.pd} Airtable FAILED ${(e as Error).message}`); }
  };
  const fresh: Item[] = [];
  for (const it of items) {
    try {
      if (it.status === "queued" || it.status === "listing") {
        const d = it.draft_id ? await store.draft(it.draft_id) : null;
        const note = String(d?.pricing?.b1 || it.note || "").trim();
        if (!note) { await store.update(it.id, { status: "error", error: "No condition description yet." }); out.push(`${it.pd} no Block 1`); continue; }
        await store.update(it.id, { status: "listing" });
        const r = await putOffer(amz, seller, it, note);
        if (!r.ok) {
          if (r.transient && it.attempts < 5) { await store.update(it.id, { status: "queued", attempts: it.attempts + 1, next_try: later(it.attempts + 1) }, "Amazon busy: " + r.why); out.push(`${it.pd} Amazon busy, retry`); continue; }
          await store.update(it.id, { status: "error", error: "Amazon refused the FBA listing: " + r.why }, "PUT refused " + r.status);
          out.push(`${it.pd} REFUSED ${r.why}`); continue;
        }
        await store.update(it.id, { status: "waiting_fnsku", product_type: r.pt, attempts: 0, next_try: later(1), error: null },
          "Amazon accepted the FBA offer" + (r.warnings.length ? " (note: " + r.warnings.join("; ") + ")" : ""));
        it.status = "waiting_fnsku"; it.attempts = 0; it.product_type = r.pt;
        await syncAT(it, d);
        fresh.push(it); out.push(`${it.pd} offer accepted`);
      } else if (it.status === "waiting_fnsku") {
        fresh.push(it);
      } else if (it.status === "ready" && it.airtable_dirty) {
        await syncAT(it, it.draft_id ? await store.draft(it.draft_id) : null);
      } else if (it.status === "removing") {
        const p = `/listings/2021-08-01/items/${seller}/${encodeURIComponent(it.pd)}`;
        const r = await amz.api("DELETE", p, { marketplaceIds: AMZ_MKT });
        if (!(r.status === 404 || r.j?.status === "ACCEPTED")) {
          await store.update(it.id, { attempts: it.attempts + 1, next_try: later(it.attempts + 1), error: "Amazon did not take the offer down yet: " + errText(r) });
          out.push(`${it.pd} undo retry`); continue;
        }
        if (at && !it.prep) { try { await writeAirtable(at, it, null, true); } catch (e) { out.push(`${it.pd} Airtable undo FAILED ${(e as Error).message}`); } }
        if (it.draft_id) await store.draftBack(it.draft_id);
        await store.update(it.id, { status: "removed", error: null, print_requested_at: null },
          it.prep ? "Taken off the weekly board: Amazon offer deleted, nothing else changed" : "Undo: Amazon offer deleted, book back in To check");
        out.push(`${it.pd} undone`);
      }
    } catch (e) {
      await store.update(it.id, { attempts: it.attempts + 1, next_try: later(it.attempts + 1) }, "error: " + String((e as Error).message).slice(0, 200));
      out.push(`${it.pd} ERROR ${(e as Error).message}`);
    }
  }
  // FNSKU: books just accepted get a few quick looks so the sticker is ready while he is still holding the book
  const polls = opts.polls ?? 6, wait = opts.pollMs ?? 12000;
  for (let round = 0; fresh.length && round < polls; round++) {
    if (round > 0 || fresh.some((x) => x.attempts === 0)) await ctx.sleep(wait);
    for (const it of [...fresh]) {
      try {
        const r = await readFnsku(amz, seller, it.pd);
        if (r.fnsku) {
          it.fnsku = r.fnsku; it.airtable_dirty = !it.prep;
          await store.update(it.id, { status: "ready", fnsku: r.fnsku, error: null, airtable_dirty: !it.prep }, "FNSKU " + r.fnsku + " - sticker ready to print");
          await syncAT(it, it.draft_id ? await store.draft(it.draft_id) : null);
          fresh.splice(fresh.indexOf(it), 1); out.push(`${it.pd} FNSKU ${r.fnsku}`);
        } else if (r.error) {
          await store.update(it.id, { status: "error", error: "Amazon listed a problem: " + r.error });
          fresh.splice(fresh.indexOf(it), 1); out.push(`${it.pd} listing problem ${r.error}`);
        }
      } catch (e) { out.push(`${it.pd} FNSKU read error ${(e as Error).message}`); }
    }
  }
  for (const it of fresh) {
    const n = it.attempts + 1;
    if (n > 60) await store.update(it.id, { status: "error", error: "Amazon still has not given this book an FNSKU after several hours. Press Try again, or tell Claude." });
    else await store.update(it.id, { attempts: n, next_try: later(n) });
    out.push(`${it.pd} waiting for FNSKU (look ${n})`);
  }
  return out;
}
