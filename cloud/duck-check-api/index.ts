// v2 (2026-11-10): image_url + title_hint for Vinted offer emails (title_match in the answer).
// Papa Duck — Edge Function "duck-check-api" v1 (2026-11-10). Papa Duck: "teach the duck check phone app cd and tapes".
// The Duck Check phone app (papa-duck-check.netlify.app) calls this instead of Scout directly. Same PIN (Scout checks it).
// Adds what the Book Station got tonight (station-api v7b):
//   - a photo is read first: a book ISBN or a CD/tape UPC (checksum verified) is checked by number;
//   - a CD, cassette, 8-track, record, VHS or DVD is checked as an item by artist + album + format across ALL of eBay (not Books);
//   - typed text naming a format (e.g. "Grand Old Country 8 track") is checked the same way;
//   - a photo check that found nothing tries once more by name across all of eBay before saying pass.
// Everything else is forwarded to Scout unchanged (buy mode, store "Vinted").
const SUPA = "https://gdwxwiwckxthwcsrgywh.supabase.co";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const MEDIA = /8[- ]?track|stereo 8|cassette|\btapes?\b|\bcds?\b|vinyl|\blp\b|\brecord album\b|vhs|dvd|blu-?ray/i;

const okCode = (d: string) => {
  if (d.length === 10) { let t = 0; for (let i = 0; i < 10; i++) t += (d[i] === "X" || d[i] === "x" ? 10 : +d[i]) * (10 - i); return t % 11 === 0; }
  if (d.length === 13) { let t = 0; for (let i = 0; i < 13; i++) t += +d[i] * (i % 2 ? 3 : 1); return t % 10 === 0; }
  if (d.length === 12) { let t = 0; for (let i = 0; i < 12; i++) t += +d[i] * (i % 2 ? 1 : 3); return t % 10 === 0; }
  return false;
};
const scout = async (body: any) => {
  const r = await fetch(`${SUPA}/functions/v1/scout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({ error: "Scout answered " + r.status })) };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let b: any; try { b = await req.json(); } catch (_) { return json({ error: "bad request" }, 400); }
  if (b.action !== "evaluate") { const r = await scout(b); return json(r.j, r.status); }

  // v2 (2026-11-10, Vinted offers): {image_url} = a photo on the web (the Vinted offer email's item picture) - fetched here.
  if (b.image_url && !(Array.isArray(b.images) && b.images.length)) {
    try {
      const ir = await fetch(String(b.image_url));
      const u = new Uint8Array(await ir.arrayBuffer());
      let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      if (ir.ok && u.length > 1000) b.images = [{ data: btoa(s), mt: ir.headers.get("content-type") || "image/jpeg" }];
    } catch (_) { /* fall back to the title */ }
    delete b.image_url;
    if (!b.images && b.title_hint) b.ident = { kind: "book", title: String(b.title_hint), author: "", format: "", confidence: "medium" };
  }
  const fwd: any = { ...b };
  delete fwd.title_hint;
  const shot = Array.isArray(b.images) && b.images[0] && b.images[0].data ? String(b.images[0].data) : "";
  let read: any = null;
  if (shot && !b.isbn) {
    try {
      const ar = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 300, messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot } },
          { type: "text", text: 'This is a photo or screenshot of a book, or a CD, cassette, 8-track, record, VHS or DVD (it may be a listing screenshot). Read any ISBN exactly; on music or video put the 12-digit UPC barcode number in isbn. Never guess a digit. Set kind "media" for a CD, cassette, 8-track, record, VHS or DVD, else "book". For media, search = short eBay search words: artist or series + album name + format word (CD / cassette / 8 track / vinyl LP / VHS / DVD) + set count if a set. Respond ONLY JSON: {"kind":"book","isbn":"","title":"","author":"","search":""}' } ] }] }) });
      const aj = await ar.json();
      const txt = (aj.content || []).map((x: any) => x.text || "").join("");
      read = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    } catch (_) { read = null; }
    const code = String(read?.isbn || "").replace(/[^0-9Xx]/g, "");
    if (okCode(code)) { delete fwd.images; fwd.isbn = code; }
    else if (read && (read.kind === "media" || MEDIA.test(String(read.title || "") + " " + String(read.search || ""))) && (read.search || read.title)) {
      delete fwd.images;
      const name = String(read.title || read.search) + (read.author && !String(read.title || "").toLowerCase().includes(String(read.author).toLowerCase()) ? " - " + read.author : "");
      fwd.ident = { kind: "item", title: name.slice(0, 80), search: String(read.search || name).slice(0, 80), author: "", isbn: "", format: "Other", confidence: "medium", family_friendly: true };
    }
  } else if (b.ident && b.ident.title && MEDIA.test(String(b.ident.title))) {
    fwd.ident = { ...b.ident, kind: "item", search: String(b.ident.title).slice(0, 80), format: "Other" };
  }

  let r = await scout(fwd);
  // found nothing from a photo: one more try by name across all of eBay
  if (r.status === 200 && r.j && r.j.list == null && (fwd.images || fwd.ident) && r.j.verdict !== "BUY") {
    const nm = String((r.j.ident && r.j.ident.title) || "").trim();
    if (nm.length >= 4 && !(fwd.ident && fwd.ident.kind === "item" && fwd.ident.search === nm)) {
      const r2 = await scout({ ...b, images: undefined, isbn: undefined, ident: { kind: "item", title: nm.slice(0, 80), search: [nm, (r.j.ident && r.j.ident.author) || ""].join(" ").trim().slice(0, 80), author: "", isbn: "", format: "Other", family_friendly: true } });
      if (r2.status === 200 && r2.j && r2.j.list != null) r = r2;
    }
  }
  // v2: is the photo the book the seller named? (Papa Duck: "make sure it is the correct book")
  if (b.title_hint && r.j && r.j.ident) {
    const words = (t: string) => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !/^(with|from|this|that|edition|book|books|the|and)$/.test(w)));
    const A = words(b.title_hint), B = words(r.j.ident.title + " " + (r.j.ident.author || ""));
    const hit = [...A].filter((w) => B.has(w)).length;
    r.j.title_match = A.size ? +(hit / A.size).toFixed(2) : null;
  }
  return json(r.j, r.status);
});
