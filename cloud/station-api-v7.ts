// v7i 2026-11-12: Vinted on/off switch (config vinted_on).
// v7h 2026-11-12: "sticker" action for the Sorting helper (links a pre-printed PD sticker to a Quick check).
// v7g 2026-11-11: careful family check on every Quick check (photo too); low photo read re-checked by its plain title.
// v7f 2026-11-11: Quick check no longer sends ex-library books worth $12+ to Goodwill - list them with the Ex-Library note.
// v7e 2026-11-11: Vinted box item is sorted into its bag right away (vinted-sort) and the V-number is returned to the Quick check.
// v7d 2026-11-11: Vinted box keeps the snapped photo (storage p/vinted/<id>.jpg -> cleanup_piles.photo_url).
// v7c 2026-11-11: CDs/tapes/records/VHS not worth the store -> VINTED (personal Vinted box) instead of Goodwill.
// v7b 2026-11-10: CDs / tapes never asked for an ISBN; UPC read from photo; media searched by name; a photo check that found nothing retries by name across all of eBay.
// Papa Duck — Edge Function "station-api" (2026-10-21). The Book Station's back end WITHOUT the claude.ai connector.
// Papa Duck, 2026-10-21, after a Claude connector outage stalled the Station: "yes plase" (remove the connector dependence).
// The Station page is now also served as its own website (Netlify) and calls this function directly over HTTPS.
// Auth: header x-station-pass must equal pipeline.config.station_passcode (the page keeps it in the browser, never in its code).
// Actions (POST JSON {action, ...}):
//   boot  {limit}                      -> pipeline.station_boot(limit)  (settings, vendors, counters, Saved Books)
//   kv    {entries:{key:value}}        -> upsert pipeline.station_kv
//   books {ups:[{key,label,item,ts}], gone:[key]}  -> upsert pipeline.station_books / mark deleted (kept for safety)
//   store {path, b64}                  -> storage bucket "p" (Rule BZ), read back from the PUBLIC url, returns {url,bytes,w,h}
//   isbn  {isbn}                       -> Open Library, then Google Books
//   send  {payload}                    -> forwards to station-intake (the token is added here, server side)
import postgres from "npm:postgres@3.4.4";

const SUPA = "https://gdwxwiwckxthwcsrgywh.supabase.co";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-station-pass" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function b64ToBytes(b: string): Uint8Array { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function jpegDims(u: Uint8Array): { w: number; h: number } | null {
  if (u[0] !== 0xff || u[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < u.length) {
    if (u[i] !== 0xff) { i++; continue; }
    const m = u[i + 1], len = (u[i + 2] << 8) | u[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf))
      return { h: (u[i + 5] << 8) | u[i + 6], w: (u[i + 7] << 8) | u[i + 8] };
    i += 2 + len;
  }
  return null;
}

async function doStore(b: any) {
  const path = String(b.path || "");
  if (!/^\d{3,5}[A-Z]?\/\d{2}-[a-z0-9]{4,8}\.jpg$/.test(path)) throw new Error("bad photo path");
  const bytes = b64ToBytes(String(b.b64 || ""));
  if (bytes.length < 2000) throw new Error("no photo data arrived");
  const dims = jpegDims(bytes);
  if (!dims) throw new Error("that was not a JPEG");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  let ok = false, err = "";
  for (let a = 1; a <= 3 && !ok; a++) {
    const r = await fetch(`${SUPA}/storage/v1/object/p/${path}`, { method: "POST",
      headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": "image/jpeg", "x-upsert": "true", "cache-control": "max-age=31536000" }, body: bytes });
    if (r.ok) ok = true; else { err = r.status + " " + (await r.text()).slice(0, 120); await sleep(1000 * a); }
  }
  if (!ok) throw new Error("storage refused it: " + err);
  const url = `${SUPA}/storage/v1/object/public/p/${path}`;
  const back = await fetch(url, { cache: "no-store" });
  const got = back.ok ? new Uint8Array(await back.arrayBuffer()) : new Uint8Array();
  if (got.length !== bytes.length) throw new Error(`stored copy is ${got.length} bytes, sent ${bytes.length}`);
  return { url, bytes: bytes.length, w: dims.w, h: dims.h };
}

async function doIsbn(b: any) {
  const isbn = String(b.isbn || "").replace(/[^0-9X]/gi, "").toUpperCase();
  if (!isbn) throw new Error("no ISBN");
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const d = (await r.json())["ISBN:" + isbn];
    if (d && d.title) return { hit: { title: d.title + (d.subtitle ? ": " + d.subtitle : ""), author: (d.authors || []).map((a: any) => a.name).join(", "),
      publisher: (d.publishers || []).map((p: any) => p.name).join(", "), year: ((d.publish_date || "").match(/\d{4}/) || [""])[0], src: "Open Library" } };
  } catch (_) { /* try Google */ }
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const v = ((await r.json()).items || [])[0]?.volumeInfo;
    if (v && v.title) return { hit: { title: v.title + (v.subtitle ? ": " + v.subtitle : ""), author: (v.authors || []).join(", "),
      publisher: v.publisher || "", year: (v.publishedDate || "").slice(0, 4), src: "Google Books" } };
  } catch (_) { /* nothing */ }
  return { hit: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from pipeline.config where key = 'station_passcode'`;
    const pass = String(req.headers.get("x-station-pass") || "");
    if (!cfg || !pass || pass !== cfg.value) return json({ ok: false, error: "bad_passcode" }, 403);
    let b: any; try { b = await req.json(); } catch (_) { return json({ ok: false, error: "bad request" }, 400); }
    const act = String(b.action || "");
    if (act === "boot") {
      const [r] = await sql`select pipeline.station_boot(${Math.min(2000, Number(b.limit) || 400)}) as b`;
      return json({ ok: true, boot: r.b });
    }
    if (act === "kv") {
      const e = b.entries && typeof b.entries === "object" ? b.entries : {};
      for (const [k, v] of Object.entries(e)) {
        if (!/^[A-Za-z0-9_.-]{1,60}$/.test(k)) continue;
        await sql`insert into pipeline.station_kv(key, value, updated_at) values (${k}, to_jsonb(${String(v)}::text), now())
          on conflict (key) do update set value = excluded.value, updated_at = now()`;
      }
      return json({ ok: true });
    }
    if (act === "books") {
      const ups = Array.isArray(b.ups) ? b.ups : [], gone = Array.isArray(b.gone) ? b.gone : [];
      for (const u of ups) {
        const t = Date.parse(u.ts); const ts = isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
        await sql`insert into pipeline.station_books(key, label, item, ts, updated_at) values (${String(u.key)}, ${String(u.label || "")}, ${sql.json(u.item || {})}, ${ts}, now())
          on conflict (key) do update set label = excluded.label, item = excluded.item, updated_at = now()`;
      }
      if (gone.length) await sql`update pipeline.station_books set item = item || '{"deleted":true}'::jsonb, updated_at = now() where key = any(${gone.map(String)})`;
      return json({ ok: true, saved: ups.length, removed: gone.length });
    }
    if (act === "store") return json({ ok: true, ...(await doStore(b)) });
    if (act === "isbn") return json({ ok: true, ...(await doIsbn(b)) });
    if (act === "send") {
      const [t] = await sql`select value from pipeline.config where key = 'station_token'`;
      const payload = Object.assign({}, b.payload || {}, { token: String(t?.value || "") });
      const r = await fetch(`${SUPA}/functions/v1/station-intake`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) return json({ ok: false, error: (j && j.error) || ("Drafts answered " + r.status) }, 502);
      return json(j);
    }
    // v2 (2026-11-09): Papa Duck "it will need to be a top of the book station app so it is the first thing I do" - QUICK CHECK before photos.
    //   Cover photo or ISBN -> Scout brain in Clean-up mode (he already owns the book) -> LIST / SELL / GOODWILL / TOSS. Read-only for listings.
    // v7c (2026-11-11): Papa Duck "I would like to do my personal Vinted instead of Goodwill for my CDs, etc" - "no more than 1 item per day ... or a lot of CDs".
    //   Scout only knows LIST/SELL/GOODWILL/TOSS piles, so the Vinted box (and Maybe later) are written here.
    if (act === "pile" && ["VINTED", "MAYBE"].includes(String(b.pile))) {
      const pid = Number(b.id) || 0;
      await sql`update pipeline.cleanup_piles set pile = ${String(b.pile)} where id = ${pid}`;
      // v7d (2026-11-11): the Vinted box keeps the snapped photo -> storage p/vinted/<id>.jpg (Launch Pad Vinted sorting box, lots, V-numbers).
      if (b.pile === "VINTED" && b.image && pid) {
        try {
          const bytes = b64ToBytes(String(b.image));
          if (bytes.length > 2000 && jpegDims(bytes)) {
            const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, path = `vinted/${pid}.jpg`;
            const r = await fetch(`${SUPA}/storage/v1/object/p/${path}`, { method: "POST",
              headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": "image/jpeg", "x-upsert": "true", "cache-control": "max-age=31536000" }, body: bytes });
            if (r.ok) await sql`update pipeline.cleanup_piles set photo_url = ${`${SUPA}/storage/v1/object/public/p/${path}`} where id = ${pid}`;
          }
        } catch (_) { /* the pile is saved either way */ }
      }
      // v7e (2026-11-11): "put them in their pre-assigned V number so ... I will know what bag to put it in" -> sort into a bag now.
      if (b.pile === "VINTED" && pid) {
        try {
          const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
          const sr = await fetch(`${SUPA}/functions/v1/vinted-sort`, { method: "POST", headers: { "Content-Type": "application/json", "x-backup-secret": String(cs?.value || "") }, body: JSON.stringify({ pile: pid }) });
          const sj = await sr.json();
          if (sj && sj.vnum) return json({ ok: true, vnum: sj.vnum, group: sj.group, n: sj.n, cap: sj.cap, full: !!sj.full });
        } catch (_) { /* the cron sorts it within 2 minutes */ }
      }
      return json({ ok: true });
    }
    // v7h (2026-11-12, Sorting helper): the family sorts ahead of Papa Duck and puts the next pre-printed PD sticker on each LIST book.
    //   {id: pile id, pd: "3671" | "PD-3671"} links that sticker to the Quick check; a sticker already used is refused with what it's on.
    if (act === "sticker") {
      const pid = Number(b.id) || 0;
      const m = String(b.pd || "").toUpperCase().replace(/\s+/g, "").match(/^(?:PD-?)?(\d{3,5}[A-Z]?)$/);
      if (!pid || !m) return json({ ok: false, error: "Type the sticker number, like 3671" }, 400);
      const pd = "PD-" + m[1];
      const [dup] = await sql`select id, title from pipeline.cleanup_piles where upper(pd) = ${pd} and id <> ${pid} limit 1`;
      if (dup && !b.force) return json({ ok: false, error: `Sticker ${pd} is already on "${String(dup.title || "another book").slice(0, 60)}" - check the number`, dup: true }, 409);
      const [dr] = await sql`select ident->>'title' t from pipeline.drafts where upper(pd) = ${pd} limit 1`;
      if (dr && !b.force) return json({ ok: false, error: `${pd} is already used in Drafts ("${String(dr.t || "").slice(0, 60)}") - check the number`, dup: true }, 409);
      await sql`update pipeline.cleanup_piles set pd = ${pd}, pile = 'LIST' where id = ${pid}`;
      return json({ ok: true, pd });
    }
    if (act === "check" || act === "pile") {
      const [pin] = await sql`select value from backup.config where key = 'scout_pin'`;
      const fwd: any = act === "pile" ? { action: "pile", id: b.id, pile: b.pile }
        : { action: "evaluate", mode: "cleanup", batch: "Station " + new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }), cost: b.cost ?? null };
      if (act === "check") {
        if (b.isbn) fwd.isbn = String(b.isbn).replace(/[^0-9Xx]/g, "");
        else if (b.image) {
          // v5 (2026-11-09): Papa Duck photographed the Spurgeon copyright page, ISBN plainly printed ("0 85151 076 0"), and the quick
          //   photo read missed it. Read the photo carefully first; when an ISBN is on it, check by ISBN (exact edition, exact comps).
          let read: any = null;
          try {
            const [m] = await sql`select value from pipeline.config where key = 'claude_model'`;
            const ar = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
              headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
              body: JSON.stringify({ model: String(m?.value || "claude-sonnet-4-6"), max_tokens: 300, messages: [{ role: "user", content: [
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(b.image) } },
                { type: "text", text: 'This photo is a book\'s cover, back, title page or copyright page, or a CD, cassette, 8-track, record, VHS or DVD. Read any ISBN printed on it exactly (old books print it with spaces, e.g. "ISBN 0 85151 076 0"; a barcode\'s 978 number counts too). On music or video, put the 12-digit UPC barcode number (the digits under the bars) in isbn. Plus the title and author/artist if shown. Set kind to "media" for a CD, cassette, 8-track, record, VHS or DVD (else "book"); for media, search = the best short eBay search words: artist or series + album name + format word (CD / cassette / 8 track / vinyl LP / VHS / DVD) + set count if a set, e.g. "Grand Old Country 4 cassette tape set". Never guess a digit. Respond ONLY JSON: {"kind":"book","isbn":"","title":"","author":"","search":""}' } ] }] }) });
            const aj = await ar.json();
            const txt = (aj.content || []).map((x: any) => x.text || "").join("");
            read = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
          } catch (_) { read = null; }
          const ri = String(read?.isbn || "").replace(/[^0-9Xx]/g, "");
          const okIsbn = (d: string) => {
            if (d.length === 10) { let t = 0; for (let i = 0; i < 10; i++) t += (d[i] === "X" || d[i] === "x" ? 10 : +d[i]) * (10 - i); return t % 11 === 0; }
            if (d.length === 13) { let t = 0; for (let i = 0; i < 13; i++) t += +d[i] * (i % 2 ? 3 : 1); return t % 10 === 0; }
            if (d.length === 12) { let t = 0; for (let i = 0; i < 12; i++) t += +d[i] * (i % 2 ? 1 : 3); return t % 10 === 0; }   // v7: UPC-A on CDs / tapes
            return false;
          };
          if (okIsbn(ri)) { fwd.isbn = ri; b.read_isbn = ri; }
          // v7: CD / tape / record / VHS with no readable barcode - search eBay in every category by artist + album + format
          //   (the photo path treated a tape set as a book and searched only Books, so "Grand Old Country - 4 Tape Set" found nothing).
          else if (read && (read.kind === "media" || /8[- ]?track|stereo 8|cassette|\btapes?\b|\bcds?\b|vinyl|\blp\b|vhs|dvd/i.test(String(read.title || "") + " " + String(read.search || ""))) && (read.search || read.title)) {
            const name = String(read.title || read.search) + (read.author && !String(read.title || "").toLowerCase().includes(String(read.author).toLowerCase()) ? " - " + read.author : "");
            fwd.ident = { kind: "item", title: name.slice(0, 80), search: String(read.search || name).slice(0, 80), author: "", isbn: "", format: "Other", confidence: "medium" };
            b.read_ident = true;
          }
          else fwd.images = [{ data: String(b.image), mt: "image/jpeg" }];
        }
        else return json({ ok: false, error: "Snap the cover or type the ISBN first" }, 400);
      }
      let r = await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: String(pin?.value || ""), ...fwd }) });
      let j = await r.json().catch(() => null);
      // v7b (2026-11-10, "quick check for grand old opry is saying goodwill?"): a photo check that found nothing gets one more try by name
      //   across all of eBay (the photo path searches Books only), before anyone is told Goodwill.
      if (act === "check" && (fwd.images || fwd.ident) && j && j.list == null && (j.verdict === "GOODWILL" || j.verdict === "SELL")) {
        const nm = String((j.ident && j.ident.title) || "").trim();
        if (nm.length >= 4) {
          const f2 = { action: "evaluate", mode: "cleanup", batch: fwd.batch, cost: fwd.cost,
            ident: { kind: "item", title: nm.slice(0, 80), search: [nm, (j.ident && j.ident.author) || ""].join(" ").trim().slice(0, 80), author: "", isbn: "", format: "Other" } };
          const r2 = await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: String(pin?.value || ""), ...f2 }) });
          const j2 = await r2.json().catch(() => null);
          if (r2.ok && j2 && j2.ok !== false && !j2.error && j2.list != null) {   // only when the name search actually found copies
            if (j.pile_id) await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin: String(pin?.value || ""), action: "pile_delete", id: j.pile_id }) }).catch(() => null);
            r = r2; j = j2; b.read_ident = true;
          }
        }
      }
      if (!r.ok || !j || j.ok === false || j.error) return json({ ok: false, error: (j && j.error) || ("Scout answered " + r.status) }, 502);
      // v7g (2026-11-11, "the pocket handyman said goodwill but then I ran it again and it said list"): the photo read added a store
      //   brand, publisher and year ("Ace Handyman-In-Your Pocket Reference Book by Sequoia Publishing 2001"), found no sold copies and
      //   fell under the $12 minimum; the plain title found 9 sold. A photo check that comes back low with nothing sold is re-checked once
      //   by its plain title, and the better answer is kept.
      if (act === "check" && (fwd.images || fwd.ident) && j && j.ident && j.ident.kind !== "item" && (j.verdict === "GOODWILL" || j.verdict === "SELL") && !Number(j.soldN || 0)) {
        const plain = String(j.ident.title || "").replace(/\s+by\s+.*$/i, "").replace(/\(.*?\)/g, "").replace(/\b(1[89]|20)\d{2}\b/g, "")
          .replace(/\b(reference book|paperback|hardcover|edition|book)\b/gi, "").replace(/^\s*(ace|sears|true value|home depot|lowe'?s)\s+/i, "").replace(/\s{2,}/g, " ").trim();
        if (plain.length >= 4 && plain.toLowerCase() !== String(j.ident.title || "").toLowerCase().trim()) {
          const f3 = { action: "evaluate", mode: "cleanup", batch: fwd.batch, cost: fwd.cost,
            ident: { ...j.ident, title: plain, isbn: "", confidence: "medium" } };
          const r3 = await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: String(pin?.value || ""), ...f3 }) });
          const j3 = await r3.json().catch(() => null);
          if (r3.ok && j3 && j3.ok !== false && !j3.error && (j3.verdict === "LIST" || j3.verdict === "CHECK") && Number(j3.soldN || 0) > 0) {
            if (j.pile_id) await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin: String(pin?.value || ""), action: "pile_delete", id: j.pile_id }) }).catch(() => null);
            r = r3; j = j3; b.read_ident = true;
          } else if (j3 && j3.pile_id) await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin: String(pin?.value || ""), action: "pile_delete", id: j3.pile_id }) }).catch(() => null);
        }
      }
      // v4 (2026-11-09): Spurgeon Autobiography Vol 1 ($34.99 book) came back GOODWILL because the cover photo only gave "Autobiography"
      //   and no copies were found. "Found nothing" is not "worth nothing": say so, ask for the ISBN, and take it off the Goodwill pile list.
      // v7 (2026-11-10): "it only worked on cd with the isbn but these and tapes dont have it" - CDs, tapes, records, VHS have no ISBN,
      //   so never ask for one. Nothing found on eBay for a real item = Goodwill, said plainly, with the barcode as a double-check.
      const isItem = j.ident && j.ident.kind === "item";
      if (act === "check" && isItem && j.list == null && (j.verdict === "GOODWILL" || j.verdict === "SELL")) {
        j.verdict = "GOODWILL";
        j.reason = `Nothing like it selling on eBay${j.ident.title ? ' (looked for "' + j.ident.title + '")' : ""}. If it has a barcode, type those numbers to double-check.`;
      }
      // v7c: CDs, tapes, records, VHS, DVDs that aren't worth the store go to his personal Vinted box instead of Goodwill.
      const isMedia = isItem && /8[- ]?track|stereo 8|cassette|\btapes?\b|\bcds?\b|vinyl|\blp\b|record|vhs|dvd|blu-?ray/i.test(String(j.ident.title || "") + " " + String(j.ident.search || ""));
      // v7i (2026-11-12, "I think I will hold on that for now"): Vinted can be paused - config vinted_on = 'false' keeps media on GOODWILL.
      const [von] = await sql`select value from pipeline.config where key = 'vinted_on'`;
      if (act === "check" && isMedia && j.verdict === "GOODWILL" && String(von?.value ?? "true") !== "false") {
        j.verdict = "VINTED";
        j.reason = (j.list != null ? `Only worth about $${Number(j.list).toFixed(2)} on eBay - not worth the store. ` : "Not worth the store. ") + "Put it in your 🛍️ Vinted box (your personal Vinted: one item or one bundle a day).";
        if (j.pile_id) await sql`update pipeline.cleanup_piles set pile = 'VINTED' where id = ${Number(j.pile_id)}`;
      }
      // v7f (2026-11-11, "The Sony Vision" $24.99 -> "Ex-library markings. Won't list it."): Scout's ex-library stop is a BUYING rule.
      //   Books he already owns that are ex-library still get listed (🏷️ Ex-Library disclosed), and a price sticker can look like one.
      if (act === "check" && j.verdict === "GOODWILL" && /^Ex-library markings/i.test(String(j.reason || "")) && j.list != null && Number(j.list) >= 12) {
        j.verdict = "LIST";
        j.reason = `Ex-library markings seen, but still worth about $${Number(j.list).toFixed(2)} - list it with the 🏷️ Ex-Library note. (If it's only a price sticker, list it normally.)`;
        if (j.pile_id) await sql`update pipeline.cleanup_piles set pile = 'LIST', reason = ${j.reason} where id = ${Number(j.pile_id)}`;
      }
      if (act === "check" && !isItem && j.list == null && (j.verdict === "GOODWILL" || j.verdict === "SELL")) {
        if (j.pile_id) await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: String(pin?.value || ""), action: "pile_delete", id: j.pile_id }) }).catch(() => null);
        j.pile_id = null;
        j.verdict = "RETAKE";
        j.reason = `Couldn't find this book from the photo${j.ident && j.ident.title ? ' (read it as "' + j.ident.title + '")' : ""}. Scan or type the ISBN — it's on the back or the copyright page.`;
      }
      // v6 (2026-11-09): "A Walk in the Clouds ... it thought it was $35" - LIST priced from only 1 eBay copy and no sales.
      //   One or two copies with nothing sold is not enough to trust a price: say so and let him decide.
      const en = Number(j.grid?.ebay?.n || 0), es = Number(j.soldN || 0);
      if (act === "check" && j.verdict === "LIST" && es === 0 && en <= 2) {
        j.verdict = "CHECK";
        j.reason = `Only ${en} on eBay and none sold, so $${Number(j.list || 0).toFixed(2)} is just one seller's asking price, not a real value. Most likely a low seller — your call.`;
      }
      // Papa Duck 2026-11-09: "also family friendly check there as well". A photo check already asks it (Scout's identify);
      // an ISBN-only check looks the book up by number, so ask Claude about the title here.
      // v7g (2026-11-11, "A Separate Reality" passed the Quick check, flagged in Drafts): the careful family check now runs on EVERY
      //   check, photo or ISBN, not only when the book was looked up by number.
      if (act === "check" && j.ident && j.ident.title && !j.family) {
        try {
          const ar = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
            headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model: String((await sql`select value from pipeline.config where key = 'claude_model'`)[0]?.value || "claude-sonnet-4-6"), max_tokens: 200, messages: [{ role: "user", content:
              `Papa Duck Homeschool is a Christian, family-friendly book shop. Would a Christian homeschool parent be surprised to find this book in the shop (erotica or sexual content, sexually suggestive cover, graphic violence or gore, heavy profanity, occult/witchcraft/sorcery/shamanism or New Age spirituality focus, horror focus, drug glorification including psychedelic "spiritual" drug use, crude humor)? Judge by what the book is known for, e.g. Carlos Castaneda's Don Juan books are NOT a fit. Mainstream adult fiction with some mature themes is fine unless known for explicit content.\n${JSON.stringify({ title: j.ident.title, author: j.ident.author, publisher: j.ident.publisher, year: j.ident.year })}\nRespond ONLY JSON: {"ok":true,"note":"short reason if not ok"}` }] }) });
          const aj = await ar.json();
          const txt = (aj.content || []).map((x: any) => x.text || "").join("");
          const fj = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
          if (fj && fj.ok === false) j.family = String(fj.note || "May not fit your family-friendly shop");
          j.family_checked = true;
        } catch (_) { j.family_checked = false; }
      } else if (act === "check") j.family_checked = true;
      if (b.read_isbn) j.read_isbn = b.read_isbn;
      return json({ ...j, ok: true });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
