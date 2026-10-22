// Papa Duck — Book Station intake. Book Station's "Send to Drafts" button POSTs one book here.
// The book lands in pipeline.drafts (source = 'station', scan = 'Book Station', p = its PD number), status 'drafted',
// price_stale = true, so the price-worker prices it and writes the title + Block 1 + Block 2 exactly like a scanned book.
// Photos: listing URLs are kept exactly as the Station sent them. A reduced copy of each photo is stored in
// pipeline.photo_blobs so the Drafts page can show it.
// v3 (09-26): FAST — the draft is saved and the Station gets its answer right away; review copies are made in the background.
// v6 (2026-10-21): CLOUD READING. On 10/21 Claude's connector outage blanked the Station's identification and PD-3406
//   was priced as a blank book. Now: if the book arrives with no title, THIS function reads the stored photos itself
//   (direct Anthropic API — no connector), retries, and only THEN lets pricing run. A blank book is never priced.
//   A sweep (cron, every 2 min, x-backup-secret + {"sweep":true}) retries any book still blank, up to 5 tries.
// Auth: body.token (or x-station-token) must match pipeline.config.station_token. Called from a file:// page, so CORS is open.
import postgres from "npm:postgres@3.4.4";

const SUPA = "https://gdwxwiwckxthwcsrgywh.supabase.co";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-station-token, x-backup-secret" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_TRIES = 5;
const BLANK_FLAG = "Identification didn't come back from the Station — check the title, author and ISBN.";
const READING_FLAG = "The Station's reading didn't come back — the cloud is reading this book from its photos now (no price until it has a title).";

function bytesToB64(buf: Uint8Array): string {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
}
// a smaller copy for the review page only — never used for the listing
function viewUrl(u: string): string {
  if (u.includes("res.cloudinary.com") && u.includes("/image/upload/")) return u.replace("/image/upload/", "/image/upload/c_limit,w_1200,h_1200,q_75,f_jpg/");
  if (u.startsWith(SUPA + "/storage/v1/object/public/")) return u.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") + "?width=1200&height=1200&resize=contain&quality=75";
  return "https://wsrv.nl/?url=" + encodeURIComponent(u) + "&w=1200&h=1200&fit=inside&q=75&output=jpg";
}
async function fetchView(u: string): Promise<{ mime: string; b64: string } | null> {
  for (const src of [viewUrl(u), u]) {
    for (let a = 1; a <= 2; a++) {
      try {
        const r = await fetch(src);
        if (!r.ok) continue;
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length < 1024 || buf.length > 4_000_000) continue;
        return { mime: (r.headers.get("content-type") || "image/jpeg").split(";")[0], b64: bytesToB64(buf) };
      } catch (_) { /* retry */ }
    }
  }
  return null;
}
const normPd = (v: string) => {
  let s = String(v || "").toUpperCase().replace(/\s+/g, "");
  if (/^PD\d/.test(s)) s = "PD-" + s.slice(2);
  return s;
};
const hasTitle = (x: any) => !!(x && typeof x === "object" && String(x.title || "").trim());

// ---------------- cloud reading (same prompt as the scan drafts-worker) ----------------
const ID_PROMPT = `You are identifying a used book (or a set of books) from photos for Papa Duck Homeschool, a used-book seller listing on eBay and AbeBooks. The photos are in listing order; photo 1 is the front cover.

Read every photo carefully, especially the copyright page for publisher, year, edition/printing and ISBN. Never invent a detail you cannot read: leave it blank and put it in "uncertainties".

LIBRARY CHECK, EVERY BOOK: hunt for ex-library marks — spine call-number labels, library stamps (edges, title page, inside covers), card pockets, date-due slips, barcode stickers, DISCARD/WITHDRAWN stamps, Mylar jacket wrap.

DUST JACKET, BE CONSERVATIVE: only claim a dust jacket if you can SEE a separate removable wrapper (folded flaps, or an edge standing proud). Most school textbooks and book-club hardcovers are LAMINATED PICTORIAL HARDCOVERS with no jacket. A rigid open-ended box is a SLIPCASE. Never attribute wear to a jacket you have not positively identified.

GLARE IS NOT DAMAGE: a bright streak or haze shaped like a light source is glare, not scuffing. Report surface wear only when the mark has a real edge or texture. If unsure, say it may be glare.

THE GOOD AND THE BEAUTIFUL: Papa Duck NEVER lists The Good and the Beautiful (Jenny Phillips) materials, or anything that looks self-printed / photocopied / home-bound from a PDF. If you see either, set do_not_list = true with the reason.

GRADES (pick one): "Like New" (looks unread), "Very Good" (light wear, clean inside), "Good" (honest wear, sound and complete), "Acceptable" (integrity compromised: loose/missing pages, failing binding). Age-appropriate wear on an old book is not a defect.

WEIGHT: estimate the SHIPPING weight in whole pounds, rounded UP (paperback ~1, hardcover novel ~2, large textbook 3-5). For a set, the whole set.

Respond with ONLY a JSON object, no markdown fences:
{
  "title": "", "subtitle_or_series": "", "author": "", "publisher": "", "publication_year": "", "isbn": "",
  "format": "Paperback | Hardcover | Spiral | Other", "edition_printing": "", "page_count_if_visible": "",
  "genre_or_subject": "", "audience": "homeschool curriculum | children | young adult | adult fiction | nonfiction | textbook | religious | other",
  "is_set": false, "set_books": [{"title": "", "author": "", "isbn": "", "volume": ""}],
  "copies_of_same_book": 1,
  "ex_library": "Yes (markings) / No / Unsure (why)",
  "dust_jacket": "none | present (describe) | slipcase",
  "grade": "Very Good",
  "condition_notes": ["every visible flaw, specific and located; or 'clean, no visible flaws'"],
  "weight_lb": 2,
  "do_not_list": false, "do_not_list_reason": "",
  "special_features": "signed, first edition, illustrated, vintage, maps, etc.",
  "uncertainties": ""
}`;

async function photoB64(u: string): Promise<string | null> {
  const small = u.startsWith(SUPA + "/storage/v1/object/public/")
    ? u.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") + "?width=1568&height=1568&resize=contain&quality=80"
    : viewUrl(u);
  for (const src of [small, u]) {
    for (let a = 1; a <= 2; a++) {
      try {
        const r = await fetch(src);
        if (!r.ok) continue;
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length > 3000 && b.length < 4_500_000) return bytesToB64(b);
      } catch (_) { /* retry */ }
    }
  }
  return null;
}

async function cloudRead(urls: string[], model: string): Promise<{ raw: string; data: any }> {
  const content: any[] = [];
  const list = urls.slice(0, 16);
  for (let i = 0; i < list.length; i++) {
    const d = await photoB64(list[i]);
    if (!d) continue;
    content.push({ type: "text", text: `Photo ${i + 1}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: d } });
  }
  if (content.length < 2) throw new Error("couldn't load the photos back from storage");
  content.push({ type: "text", text: ID_PROMPT });
  let last = "";
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 2500, messages: [{ role: "user", content }] }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const raw = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
        const clean = raw.replace(/```json|```/g, "").trim();
        const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
        let data: any = null;
        try { data = JSON.parse(clean.slice(s, e + 1)); } catch (_) { data = null; }
        if (hasTitle(data)) return { raw, data };
        last = "answered but with no title";
      } else {
        last = `${r.status} ${(j.error && j.error.message) || ""}`.slice(0, 200);
        if (!(r.status === 429 || r.status >= 500)) break;
      }
    } catch (e) { last = String((e as Error).message || e).slice(0, 200); }
    await sleep(4000 * a);
  }
  throw new Error("cloud reading failed: " + last);
}

async function kickPricing(secret: string) {
  await fetch(`${SUPA}/functions/v1/price-worker`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-backup-secret": secret }, body: "{}" }).then((r) => r.text()).catch(() => null);
}

// Read one blank book in the cloud. Keeps what Papa Duck set in the Station (grade, set, weight, library tick).
async function readOne(id: number): Promise<{ id: number; ok: boolean; title?: string; error?: string }> {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [d] = await sql`update pipeline.drafts set ident_attempts = ident_attempts + 1, ident_at = now()
      where id = ${id} and built_at is null and coalesce(ident->>'title','') = '' and ident_attempts < ${MAX_TRIES}
      returning id, photos, ident, flags, ident_attempts, answers`;
    if (!d) return { id, ok: false, error: "nothing to read (already has a title, built, or out of tries)" };
    const urls = (Array.isArray(d.photos) ? d.photos : []).map((p: any) => String(p.url || "")).filter((u: string) => /^https:\/\//.test(u));
    const [m] = await sql`select value from pipeline.config where key = 'claude_model'`;
    try {
      const { raw, data } = await cloudRead(urls, String(m?.value || "claude-sonnet-4-6"));
      const old = d.ident || {};
      const merged: any = Object.assign({}, data);
      const st = (d.answers && d.answers.station) || {};
      if (old.grade && st.grade_from_station) merged.grade = old.grade;          // his pick in the Station wins
      if (old.is_set) { merged.is_set = true; if (Array.isArray(old.set_books) && old.set_books.length) merged.set_books = old.set_books; }
      if (old.weight_lb) merged.weight_lb = old.weight_lb;
      merged.read_by = "cloud";
      const flags = (Array.isArray(d.flags) ? d.flags : []).filter((f: string) => f !== BLANK_FLAG && f !== READING_FLAG);
      for (let i = 0; i < flags.length; i++) if (String(flags[i]).startsWith("No grade was picked")) flags[i] = "No grade was picked in the Book Station — the cloud graded it " + (merged.grade || "Good") + " from the photos. Change it here if that's wrong.";
      flags.push("Read by the cloud — check the title and details.");
      if (data.do_not_list) flags.push("DO NOT LIST: " + (data.do_not_list_reason || "The Good and the Beautiful / self-printed"));
      if (/^yes/i.test(String(data.ex_library || ""))) flags.push("Ex-library: " + data.ex_library);
      await sql`update pipeline.drafts set ident = ${sql.json(merged)}, raw_ident = ${raw}, flags = ${sql.json(flags)},
          weight_lb = coalesce(weight_lb, ${Number(merged.weight_lb) || null}),
          pricing = null, priced_at = null, price_attempts = 0, price_stale = true, error = null, updated_at = now() - interval '30 seconds'
        where id = ${id}`;
      const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
      await kickPricing(String(cs?.value || ""));
      return { id, ok: true, title: String(data.title) };
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 300);
      const out = d.ident_attempts >= MAX_TRIES;
      const flags = (Array.isArray(d.flags) ? d.flags : []).filter((f: string) => f !== READING_FLAG && !String(f).startsWith("The cloud couldn't read"));
      if (out) flags.push(`The cloud couldn't read this book after ${MAX_TRIES} tries — tell Claude the PD number (${msg.slice(0, 120)})`);
      else flags.push(READING_FLAG);
      await sql`update pipeline.drafts set flags = ${sql.json(flags)}, error = ${"cloud reading try " + d.ident_attempts + ": " + msg}, updated_at = now() where id = ${id}`;
      return { id, ok: false, error: msg };
    }
  } finally { await sql.end({ timeout: 2 }); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    let b: any;
    try { b = JSON.parse(await req.text()); } catch (_) { return json({ ok: false, error: "That was not a Book Station book." }, 400); }

    // ---- sweep / single re-read (cron or Claude): retry every book still blank ----
    if (b.sweep || b.read) {
      const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
      if (!cs || req.headers.get("x-backup-secret") !== cs.value) return json({ ok: false, error: "not allowed" }, 403);
      let ids: number[];
      if (b.read) ids = [Number(b.read)];
      else ids = (await sql`select id from pipeline.drafts where source = 'station' and built_at is null and status in ('drafted','sent')
          and coalesce(ident->>'title','') = '' and ident_attempts < ${MAX_TRIES}
          and (ident_at is null or ident_at < now() - interval '90 seconds')
          and created_at > now() - interval '5 days' order by id limit 3`).map((r: any) => Number(r.id));
      const res = await Promise.all(ids.map((id) => readOne(id)));
      return json({ ok: true, read: res });
    }

    const [cfg] = await sql`select value from pipeline.config where key = 'station_token'`;
    const tok = String(b.token || req.headers.get("x-station-token") || "");
    if (!cfg || !tok || tok !== cfg.value) return json({ ok: false, error: "Not allowed — this Book Station copy is not connected to Drafts." }, 403);

    const pd = normPd(b.pd);
    if (!/^PD-\d{3,5}[A-Z]?$/.test(pd)) return json({ ok: false, error: "No PD number on this book." }, 400);
    const photosIn = (Array.isArray(b.photos) ? b.photos : []).filter((p: any) => p && /^https:\/\//.test(String(p.url || "")));
    if (photosIn.length < 2) return json({ ok: false, error: "This book needs the cover plus at least one more photo." }, 400);

    const [old] = await sql`select id, status, built_at from pipeline.drafts where scan = 'Book Station' and p = ${pd}`;
    if (old && old.built_at) return json({ ok: false, error: pd + " was already blasted off — it can't be sent again. Use Override in the Station if you're redoing it." }, 409);
    const other = await sql`select id, scan, p from pipeline.drafts where pd = ${pd} and not (scan = 'Book Station' and p = ${pd}) limit 1`;
    const warn = other.length ? pd + " is also on a scanned draft (" + other[0].scan + " " + other[0].p + ") — check you don't list it twice." : "";

    const photos: any[] = photosIn.map((p: any, i: number) => ({ n: i + 1, url: String(p.url), name: String(p.name || ""), group: "book",
      drive_id: "blob:st-" + pd + "-" + (i + 1) + "-" + crypto.randomUUID().slice(0, 8) }));

    // identification from the Station; if it is blank, the cloud reads the book (below) before any pricing
    let ident: any = null;
    const rawIdent = typeof b.ident === "string" ? b.ident : (b.ident ? JSON.stringify(b.ident) : "");
    try { ident = typeof b.ident === "object" && b.ident ? b.ident : JSON.parse(String(b.ident || "").replace(/```json|```/g, "").trim()); } catch (_) { ident = null; }
    const flags: string[] = [];
    const blank = !hasTitle(ident);
    if (!ident || typeof ident !== "object") ident = { title: "" };
    if (blank) { ident.title = ""; ident.uncertainties = "The Station's identification did not come back — the cloud is reading it."; flags.push(READING_FLAG); }
    const grade = String(b.grade || "").trim();
    ident.grade = grade || ident.grade || "Good";
    if (!grade) flags.push("No grade was picked in the Book Station — Claude used " + ident.grade + ". Change it here if that's wrong.");
    ident.is_set = !!b.is_set;
    ident.set_books = Array.isArray(b.set_books) ? b.set_books.map((s: any) => ({ title: s.title || "", author: s.author || "", isbn: s.isbn || "" })) : [];
    if (b.weight_lb) ident.weight_lb = Number(b.weight_lb);
    if (b.lib) flags.push("You ticked Library book in the Station.");
    if (warn) flags.push(warn);

    const chan = ["both", "ebay", "abe", "amazon"].includes(b.channel) ? b.channel : "both";
    const price = parseFloat(String(b.price || "").replace(/[^0-9.]/g, ""));
    const answers = { tell: String(b.tell || "").slice(0, 6000),
      station: { qty: Math.max(1, parseInt(b.qty, 10) || 1), cost: b.cost || "", vendor: b.vendor || "", pool: b.pool || "", lib: !!b.lib,
                 grade_from_station: !!grade,
                 amazon_asin: b.asin || "", filenames: photosIn.map((p: any) => p.name || ""), sent_from_station_at: new Date().toISOString(),
                 block: String(b.block || "").slice(0, 20000) } };
    const weight = b.weight_lb ? Number(b.weight_lb) : null;
    const override = isFinite(price) && price > 0 ? price : null;
    const stale = !blank;                 // NEVER price a blank book

    let id: number;
    if (old) {
      const oldKeys = await sql`select e.v->>'drive_id' as k from pipeline.drafts d cross join lateral jsonb_array_elements(d.photos) as e(v) where d.id = ${old.id}`;
      const [r] = await sql`update pipeline.drafts set status = 'drafted', source = 'station', pd = ${pd}, photos = ${sql.json(photos)}, is_set = ${!!b.is_set},
          ident = ${sql.json(ident)}, raw_ident = ${rawIdent}, flags = ${sql.json(flags)}, questions = '[]'::jsonb, answers = ${sql.json(answers)},
          weight_lb = ${weight}, channel = ${chan}, price_override = ${override}, pricing = null, price_stale = ${stale}, price_attempts = 0,
          priced_at = null, sent_at = null, error = null, ident_attempts = 0, ident_at = null, updated_at = now() - interval '30 seconds'
        where id = ${old.id} returning id`;
      id = Number(r.id);
      const ks = oldKeys.map((x: any) => String(x.k || "")).filter((k: string) => k.startsWith("blob:")).map((k: string) => k.slice(5));
      if (ks.length) await sql`delete from pipeline.photo_blobs where key = any(${ks})`;
    } else {
      const pnum = parseInt(pd.replace(/\D/g, ""), 10) || 0;
      const [r] = await sql`insert into pipeline.drafts (scan, p, p_num, drive_folder_id, status, source, pd, photos, is_set, ident, raw_ident, flags, questions, answers,
          weight_lb, channel, price_override, price_stale, updated_at)
        values ('Book Station', ${pd}, ${pnum}, ${"station:" + pd}, 'drafted', 'station', ${pd}, ${sql.json(photos)}, ${!!b.is_set}, ${sql.json(ident)}, ${rawIdent}, ${sql.json(flags)},
          '[]'::jsonb, ${sql.json(answers)}, ${weight}, ${chan}, ${override}, ${stale}, now() - interval '30 seconds')
        returning id`;
      id = Number(r.id);
    }
    const [csk] = await sql`select value from backup.config where key = 'cron_secret'`;
    const secret = String(csk?.value || "");
    // a read book: start pricing now. A blank book: the cloud reads it first, then prices it.
    // @ts-ignore EdgeRuntime is provided by Supabase
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(blank ? readOne(id) : kickPricing(secret));
    // background: review copies of every photo for the Drafts page
    const bg = (async () => {
      const s2 = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
      try {
        const res = await Promise.all(photos.map(async (ph) => {
          const v = await fetchView(ph.url);
          if (v) await s2`insert into pipeline.photo_blobs (key, mime, b64) values (${ph.drive_id.slice(5)}, ${v.mime}, ${v.b64}) on conflict do nothing`;
          return !!v;
        }));
        const bad = res.filter((x) => !x).length;
        if (bad) {
          const fixed = photos.map((ph, i) => res[i] ? ph : { ...ph, drive_id: "none:" + ph.drive_id.slice(5) });
          await s2`update pipeline.drafts set photos = ${s2.json(fixed)}, flags = flags || ${s2.json([bad + " photo(s) couldn't be copied for this page — they're still on the listing, just not shown here."])} where id = ${id}`;
        }
      } catch (_) { /* the listing URLs are safe either way */ } finally { await s2.end({ timeout: 2 }); }
    })();
    // @ts-ignore EdgeRuntime is provided by Supabase
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(bg);
    return json({ ok: true, id, pd, replaced: !!old, photos: photos.length, shown: photos.length, warn, reading_in_cloud: blank });
  } catch (e) {
    return json({ ok: false, error: "Drafts didn't take it: " + String((e as Error).message || e).slice(0, 200) }, 500);
  } finally {
    await sql.end({ timeout: 2 });
  }
});
