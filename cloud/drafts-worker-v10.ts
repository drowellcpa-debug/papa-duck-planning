// Papa Duck — drafts worker. Runs every minute from pg_cron. Each call handles AT MOST ONE P folder:
//   Drive P folder (settled) -> photos to imgbb (each verified live) -> Claude identifies + grades -> pipeline.drafts
// Auth: x-backup-secret header must match backup.config.cron_secret. Secrets: GOOGLE_SA_JSON, IMGBB_KEY, ANTHROPIC_API_KEY.
// v10 (2026-10-29): Papa Duck "the scan should look for any date that is today in that directory no matter what day they are in" -
//   photos shot into an older-named Scan folder (e.g. Scan 092926 PM instead of 102926) are picked up too: the Scan folders checked
//   are the ones holding P folders with photos added in the last 4 days, whatever date the folder name says.
//   (Non-book items: the drafts_item_gate trigger now covers Drive scans too, so games/dishes get the item write-up.)
import postgres from "npm:postgres@3.4.4";

const INBOX = "1L5MIqZS4ZAiXD-u-qTCKKQQoKmv6geU0";
const FOLDER = "application/vnd.google-apps.folder";
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64url = (b: ArrayBuffer | string) => {
  const s = typeof b === "string" ? btoa(b) : btoa(String.fromCharCode(...new Uint8Array(b)));
  return s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
};
function bytesToB64(buf: Uint8Array): string {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
}

// ---------------- Google Drive ----------------
async function driveToken(): Promise<string> {
  const sa = JSON.parse(Deno.env.get("GOOGLE_SA_JSON") || "{}");
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claim}`));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${b64url(sig)}` }) });
  const j = await r.json(); if (!j.access_token) throw new Error("Google token refused: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}
type DFile = { id: string; name: string; mimeType: string; size?: string; modifiedTime: string; createdTime: string };
async function list(tok: string, parent: string): Promise<DFile[]> {
  const out: DFile[] = []; let pageToken = "";
  do {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q", `'${parent}' in parents and trashed = false`);
    u.searchParams.set("fields", "nextPageToken, files(id,name,mimeType,size,modifiedTime,createdTime)");
    u.searchParams.set("pageSize", "1000");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
    const j = await r.json(); if (!r.ok) throw new Error("Drive list failed: " + JSON.stringify(j).slice(0, 200));
    out.push(...(j.files || [])); pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}
async function download(tok: string, id: string): Promise<Uint8Array> {
  for (let a = 1; a <= 3; a++) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
    await sleep(1500 * a);
  }
  throw new Error("Drive download failed for " + id);
}
const pnum = (n: string) => { const m = /^P\s*(\d+)$/i.exec(n.trim()); return m ? parseInt(m[1], 10) : -1; };
const snum = (n: string) => { const m = /^S\s*(\d+)$/i.exec(n.trim()); return m ? parseInt(m[1], 10) : -1; };

// ---------------- imgbb (upload + live verify, like Book Station v33+) ----------------
async function imgbbUpload(bytes: Uint8Array, name: string): Promise<string> {
  const key = Deno.env.get("IMGBB_KEY")!;
  let last = "";
  for (let a = 1; a <= 3; a++) {
    try {
      const body = new URLSearchParams({ image: bytesToB64(bytes), name: name.replace(/\.[^.]+$/, "") });
      const r = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, { method: "POST", body });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error?.message || `imgbb ${r.status}`);
      const url: string = j.data.url;
      // verify: a dead imgbb link still answers 200 with a ~1 KB placeholder PNG — judge size and type, never the status
      await sleep(800);
      const v = await fetch(url, { headers: { "User-Agent": "PapaDuckCloud/1" } });
      const ct = (v.headers.get("content-type") || "").toLowerCase();
      const got = new Uint8Array(await v.arrayBuffer());
      if (!v.ok || !ct.startsWith("image") || got.length < 4000) throw new Error(`verify failed (${v.status} ${ct} ${got.length} bytes)`);
      return url;
    } catch (e) { last = String((e as Error).message || e); await sleep(2000 * a); }
  }
  throw new Error(`photo ${name} could not be verified live on imgbb after 3 tries: ${last}`);
}

// ---------------- Claude ----------------
const ID_PROMPT = `You are identifying a used book (or a set of books) from photos for Papa Duck Homeschool, a used-book seller listing on eBay and AbeBooks. The photos are in listing order; photo 1 is the front cover (for a set, photo 1 is a group shot and each book's photos follow in its own group — the group label is given before each photo).

Read every photo carefully, especially the copyright page for publisher, year, edition/printing and ISBN. Never invent a detail you cannot read: leave it blank and put it in "uncertainties".

LIBRARY CHECK, EVERY BOOK: hunt for ex-library marks — spine call-number labels, library stamps (edges, title page, inside covers), card pockets, date-due slips, barcode stickers, DISCARD/WITHDRAWN stamps, Mylar jacket wrap.

DUST JACKET, BE CONSERVATIVE: only claim a dust jacket if you can SEE a separate removable wrapper (folded flaps, or an edge standing proud). Most school textbooks and book-club hardcovers are LAMINATED PICTORIAL HARDCOVERS with no jacket. A rigid open-ended box is a SLIPCASE. Never attribute wear to a jacket you have not positively identified.

GLARE IS NOT DAMAGE: a bright streak or haze shaped like a light source is glare, not scuffing. Report surface wear only when the mark has a real edge or texture. If unsure, say it may be glare.

WASHED-OUT PHOTOS: these may be taken with a phone document-scanner that whitens paper. If the photos look too flattened/whitened to judge stains, toning or wear honestly, set photos_too_washed_out = true.

THE GOOD AND THE BEAUTIFUL: Papa Duck NEVER lists The Good and the Beautiful (Jenny Phillips) materials, or anything that looks self-printed / photocopied / home-bound from a PDF. If you see either, set do_not_list = true with the reason.

GRADES (pick one): "Like New" (looks unread), "Very Good" (light wear, clean inside), "Good" (honest wear, sound and complete — marked-up or shelf-worn but holding together is still Good), "Acceptable" (integrity compromised: loose/missing pages, failing binding). Age-appropriate wear on an old book is not a defect.

WEIGHT: estimate the SHIPPING weight in whole pounds, rounded UP (paperback ~1, hardcover novel ~2, large textbook 3-5). For a set, the whole set.

QUESTIONS: list ONLY things Papa Duck must decide or confirm that the photos cannot settle (e.g. "Is the answer key included?", "Set of 4 — is anything missing?", "Is the CD present?"). Every question MUST have 2-4 short click options. Do NOT ask about things you can see. Do NOT ask about price. Do NOT ask about spine condition, writing, highlighting, stamps, markings, stains, smell or loose pages - Papa Duck has a checklist for all of those. Every question MUST include a plain "no problem" answer (e.g. "No, it's fine" / "Not included" / "Nothing missing") so he is never forced to pick a flaw; the page adds an "Other" box automatically. If you cannot find or read the PUBLICATION YEAR, ASK: {"q": "What year is printed on the copyright page?", "options": ["No year printed", "Other"]}. Papa Duck is holding the book, so ask him rather than guessing; never ask about page count. Zero questions is fine.

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
  "photos_too_washed_out": false,
  "do_not_list": false, "do_not_list_reason": "",
  "special_features": "signed, first edition, illustrated, vintage, maps, etc.",
  "questions": [{"q": "", "options": ["", ""]}],
  "uncertainties": ""
}`;

// Photos go to Claude as base64 (Anthropic fetching imgbb URLs timed out on 12 of 20 books, 2026-09-24).
// Drive's thumbnail service gives a ~1568px JPEG, small enough for the API; the original is the fallback.
async function photoForClaude(tok: string, driveId: string): Promise<{ data: string; mt: string }> {
  try {
    const m = await fetch(`https://www.googleapis.com/drive/v3/files/${driveId}?fields=thumbnailLink,mimeType,size`, { headers: { Authorization: `Bearer ${tok}` } });
    const j = await m.json();
    if (j.thumbnailLink) {
      const u = String(j.thumbnailLink).replace(/=s\d+(-[a-z]+)?$/, "=s1568");
      const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
      const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
      const b = new Uint8Array(await r.arrayBuffer());
      if (r.ok && ct.startsWith("image") && b.length > 3000) return { data: bytesToB64(b), mt: ct };
    }
    if (Number(j.size || 0) > 0 && Number(j.size) < 3_500_000) {
      const b = await download(tok, driveId);
      return { data: bytesToB64(b), mt: j.mimeType && String(j.mimeType).startsWith("image") ? j.mimeType : "image/jpeg" };
    }
  } catch (_) { /* fall through */ }
  throw new Error("could not prepare photo " + driveId + " for Claude (too large and no thumbnail)");
}

async function identify(tok: string, photos: { drive_id: string; group: string }[], model: string): Promise<{ raw: string; data: any }> {
  const content: any[] = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const img = await photoForClaude(tok, p.drive_id);
    content.push({ type: "text", text: `Photo ${i + 1} (${p.group})` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mt, data: img.data } });
  }
  content.push({ type: "text", text: ID_PROMPT });
  let last = "";
  for (let a = 1; a <= 3; a++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 2500, messages: [{ role: "user", content }] }),
    });
    const j = await r.json();
    if (r.ok) {
      const raw = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      const clean = raw.replace(/```json|```/g, "").trim();
      const s = clean.indexOf("{"), e = clean.lastIndexOf("}");
      try { return { raw, data: JSON.parse(clean.slice(s, e + 1)) }; }
      catch { return { raw, data: null }; }
    }
    last = `${r.status} ${JSON.stringify(j).slice(0, 300)}`;
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * a); continue; }
    break;
  }
  throw new Error("Claude call failed: " + last);
}

// ---------------- main ----------------
Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now();
  let draftId: number | null = null;
  const L = (m: string) => console.log(`[dw ${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  try {
    L("start");
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (!cfg || req.headers.get("x-backup-secret") !== cfg.value) return json({ error: "not allowed" }, 403);
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    const settleMs = (parseFloat(conf.settle_minutes) || 3) * 60000;
    L("db ok");
    const tok = await driveToken();
    L("drive token ok");

    // find the next settled P folder that has photos and no finished draft
    const done = new Set((await sql`select drive_folder_id from pipeline.drafts
      where status in ('drafted','sent','dont_list') or (status = 'processing' and updated_at > now() - interval '10 minutes')
         or (status = 'failed' and attempts >= 3)`).map((r: any) => r.drive_folder_id));
    // ONE Drive search for photos added in the last 4 days, then only open the P folders that actually got photos.
    const cutoff = Date.now() - 4 * 86400000;
    const since = new Date(cutoff).toISOString();
    const recent: (DFile & { parents?: string[] })[] = [];
    { let pt = "";
      do {
        const u = new URL("https://www.googleapis.com/drive/v3/files");
        u.searchParams.set("q", `mimeType contains 'image/' and trashed = false and (createdTime > '${since}' or modifiedTime > '${since}')`);
        u.searchParams.set("fields", "nextPageToken, files(id,name,mimeType,size,modifiedTime,createdTime,parents)");
        u.searchParams.set("pageSize", "1000");
        u.searchParams.set("includeItemsFromAllDrives", "true"); u.searchParams.set("supportsAllDrives", "true");
        if (pt) u.searchParams.set("pageToken", pt);
        const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
        const j = await r.json(); if (!r.ok) throw new Error("Drive search failed: " + JSON.stringify(j).slice(0, 200));
        recent.push(...(j.files || [])); pt = j.nextPageToken || "";
      } while (pt);
    }
    const hot = new Set<string>(); recent.forEach((f) => (f.parents || []).forEach((x) => hot.add(x)));
    // v10: also note which Scan folder each hot P folder sits in, so a P folder with fresh photos is found in a Scan folder
    // of ANY date (he shot into "Scan 092926 PM" on 10/29). Set photos sit in P##/S# sub-folders: the P above a hot S is hot too.
    const hotScans = new Set<string>();
    const meta = async (id: string) => { const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,parents&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${tok}` } });
      return r.ok ? await r.json() : {}; };
    for (const id of [...hot]) {
      const j: any = await meta(id);
      const nm = String(j.name || "");
      if (snum(nm) > 0) for (const pId of (j.parents || [])) { hot.add(pId); const pj: any = await meta(pId); (pj.parents || []).forEach((x: string) => hotScans.add(x)); }
      else if (pnum(nm) > 0) (j.parents || []).forEach((x: string) => hotScans.add(x));
    }
    const scans = (await list(tok, INBOX)).filter((f) => f.mimeType === FOLDER && /^Scan\s+\d{6}\s+(AM|PM)$/i.test(f.name) && hotScans.has(f.id))
      .sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    L(`recent photos ${recent.length}, hot folders ${hot.size}, scans: ${scans.map((x) => x.name).join(", ")}`);
    let pick: { scan: DFile; p: DFile; photos: { f: DFile; group: string }[]; isSet: boolean } | null = null;
    outer: for (const scan of scans) {
      const ps = (await list(tok, scan.id)).filter((f) => f.mimeType === FOLDER && pnum(f.name) > 0).sort((a, b) => pnum(a.name) - pnum(b.name));
      for (const p of ps) {
        if (done.has(p.id)) continue;
        if (!hot.has(p.id)) continue;                                  // no recent photos in it — skip without opening
        L(`check ${scan.name}/${p.name}`);
        const kids = await list(tok, p.id);
        const top = kids.filter((f) => IMG_RE.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
        const sFolders = kids.filter((f) => f.mimeType === FOLDER && snum(f.name) > 0).sort((a, b) => snum(a.name) - snum(b.name));
        const photos: { f: DFile; group: string }[] = top.map((f) => ({ f, group: sFolders.length ? "set group shot" : "book" }));
        for (const s of sFolders) {
          const sf = (await list(tok, s.id)).filter((f) => IMG_RE.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
          sf.forEach((f) => photos.push({ f, group: `set book ${snum(s.name)}` }));
        }
        if (!photos.length) continue;
        const newest = Math.max(...photos.map((x) => Date.parse(x.f.modifiedTime || x.f.createdTime)));
        if (Date.now() - newest < settleMs) continue;                  // still being shot — leave it
        pick = { scan, p, photos, isSet: sFolders.length > 0 };
        break outer;
      }
    }
    if (!pick) return json({ ok: true, idle: true, note: "no settled P folder waiting" });

    const [row] = await sql`insert into pipeline.drafts (scan, p, p_num, drive_folder_id, is_set, status, attempts)
      values (${pick.scan.name}, ${pick.p.name.toUpperCase().replace(/\s+/g, "")}, ${pnum(pick.p.name)}, ${pick.p.id}, ${pick.isSet}, 'processing', 1)
      on conflict (drive_folder_id) do update set status = 'processing', attempts = pipeline.drafts.attempts + 1, updated_at = now(), error = null
      returning id, photos`;
    draftId = Number(row.id);
    L(`picked ${pick.scan.name}/${pick.p.name} draft ${draftId}, ${pick.photos.length} photos`);
    const already: any[] = Array.isArray(row.photos) ? row.photos : [];

    // photos: reuse any already uploaded on an earlier attempt (matched by Drive file id)
    const photos: any[] = [];
    for (let i = 0; i < pick.photos.length; i++) {
      const { f, group } = pick.photos[i];
      const prev = already.find((x) => x.drive_id === f.id && x.url);
      if (prev) { photos.push({ ...prev, n: i + 1, group }); continue; }
      if (Date.now() - t0 > 110000) throw new Error("time budget reached mid-upload — will continue on the next run");
      const bytes = await download(tok, f.id);
      const url = await imgbbUpload(bytes, `${pick.scan.name.replace(/\s+/g, "_")}_${pick.p.name}_${String(i + 1).padStart(2, "0")}`);
      L(`uploaded ${i + 1}`);
      photos.push({ n: i + 1, name: f.name, group, drive_id: f.id, url, bytes: bytes.length });
      await sql`update pipeline.drafts set photos = ${sql.json(photos)}, updated_at = now() where id = ${draftId}`;
    }

    L("calling Claude");
    // Claude: first N photos (cover + the rest, groups labelled)
    const maxN = parseInt(conf.max_photos_to_claude) || 16;
    const { raw, data } = await identify(tok, photos.slice(0, maxN).map((p) => ({ drive_id: p.drive_id, group: p.group })), conf.claude_model || "claude-sonnet-4-6");
    if (!data) throw new Error("Claude answered but not as JSON — raw kept");

    const flags: string[] = [];
    if (data.do_not_list) flags.push("DO NOT LIST: " + (data.do_not_list_reason || "The Good and the Beautiful / self-printed"));
    if (data.photos_too_washed_out) flags.push("Photos look too washed out to grade confidently");
    if (photos.length > 24) flags.push(`${photos.length} photos — eBay takes 24; the first 24 will be used`);
    if (/^yes/i.test(String(data.ex_library || ""))) flags.push("Ex-library: " + data.ex_library);
    const qs: any[] = (Array.isArray(data.questions) ? data.questions : [])
      .filter((q: any) => q && q.q && Array.isArray(q.options) && q.options.length >= 2).slice(0, 6);
    qs.push({ q: "Anything the photos can't show?", options: ["None", "Smoke / musty smell", "Writing inside", "Loose pages", "Other"] });

    await sql`update pipeline.drafts set status = ${data.do_not_list ? "dont_list" : "drafted"}, ident = ${sql.json(data)}, raw_ident = ${raw},
      flags = ${sql.json(flags)}, questions = ${sql.json(qs)}, weight_lb = ${Number(data.weight_lb) || null}, error = null, updated_at = now()
      where id = ${draftId}`;
    return json({ ok: true, draft: draftId, scan: pick.scan.name, p: pick.p.name, photos: photos.length, title: data.title, grade: data.grade, secs: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 1500);
    if (draftId) await sql`update pipeline.drafts set status = 'failed', error = ${msg}, updated_at = now() where id = ${draftId}`;
    return json({ ok: false, draft: draftId, error: msg }, 500);
  } finally { await sql.end({ timeout: 5 }); }
});
