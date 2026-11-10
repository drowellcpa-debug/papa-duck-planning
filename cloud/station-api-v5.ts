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
                { type: "text", text: 'This photo is a book\'s cover, back, title page or copyright page. Read any ISBN printed on it exactly (old books print it with spaces, e.g. "ISBN 0 85151 076 0"; a barcode\'s 978 number counts too), plus the title and author if shown. Never guess a digit. Respond ONLY JSON: {"isbn":"","title":"","author":""}' } ] }] }) });
            const aj = await ar.json();
            const txt = (aj.content || []).map((x: any) => x.text || "").join("");
            read = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
          } catch (_) { read = null; }
          const ri = String(read?.isbn || "").replace(/[^0-9Xx]/g, "");
          const okIsbn = (d: string) => {
            if (d.length === 10) { let t = 0; for (let i = 0; i < 10; i++) t += (d[i] === "X" || d[i] === "x" ? 10 : +d[i]) * (10 - i); return t % 11 === 0; }
            if (d.length === 13) { let t = 0; for (let i = 0; i < 13; i++) t += +d[i] * (i % 2 ? 3 : 1); return t % 10 === 0; }
            return false;
          };
          if (okIsbn(ri)) { fwd.isbn = ri; b.read_isbn = ri; }
          else fwd.images = [{ data: String(b.image), mt: "image/jpeg" }];
        }
        else return json({ ok: false, error: "Snap the cover or type the ISBN first" }, 400);
      }
      const r = await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: String(pin?.value || ""), ...fwd }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok === false || j.error) return json({ ok: false, error: (j && j.error) || ("Scout answered " + r.status) }, 502);
      // v4 (2026-11-09): Spurgeon Autobiography Vol 1 ($34.99 book) came back GOODWILL because the cover photo only gave "Autobiography"
      //   and no copies were found. "Found nothing" is not "worth nothing": say so, ask for the ISBN, and take it off the Goodwill pile list.
      if (act === "check" && j.list == null && (j.verdict === "GOODWILL" || j.verdict === "SELL")) {
        if (j.pile_id) await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: String(pin?.value || ""), action: "pile_delete", id: j.pile_id }) }).catch(() => null);
        j.pile_id = null;
        j.verdict = "RETAKE";
        j.reason = `Couldn't find this book from the photo${j.ident && j.ident.title ? ' (read it as "' + j.ident.title + '")' : ""}. Scan or type the ISBN — it's on the back or the copyright page.`;
      }
      // Papa Duck 2026-11-09: "also family friendly check there as well". A photo check already asks it (Scout's identify);
      // an ISBN-only check looks the book up by number, so ask Claude about the title here.
      if (act === "check" && (!b.image || b.read_isbn) && j.ident && j.ident.title && !j.family) {
        try {
          const ar = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
            headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, messages: [{ role: "user", content:
              `Papa Duck Homeschool is a Christian, family-friendly book shop. Would a Christian homeschool parent be surprised to find this book in the shop (erotica or sexual content, sexually suggestive cover, graphic violence or gore, heavy profanity, occult/witchcraft/horror focus, drug glorification, crude humor)? Mainstream adult fiction with some mature themes is fine unless known for explicit content.\n${JSON.stringify({ title: j.ident.title, author: j.ident.author, publisher: j.ident.publisher, year: j.ident.year })}\nRespond ONLY JSON: {"ok":true,"note":"short reason if not ok"}` }] }) });
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
