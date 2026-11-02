// Papa Duck - Edge Function "photo-add" v1 (2026-11-01). Papa Duck: "I took pictures of the lid for p84 can you add them please".
// A Drive scan draft is made once; photos dropped into its P folder AFTER that were never picked up. This adds them:
// lists the draft's Drive P folder, uploads every photo not already on the draft (matched by Drive file id) the same way the drafts
// worker does (imgbb, verified live), appends them in file-name order, and asks for a fresh write-up (item_stale / price_stale).
// POST {"draft": 841} or {"p":"P84","scan":"Scan 110126 AM"}. Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
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


Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (!cfg || req.headers.get("x-backup-secret") !== cfg.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const [d] = b.draft ? await sql`select * from pipeline.drafts where id = ${Number(b.draft)}`
      : await sql`select * from pipeline.drafts where p = ${String(b.p || "")} and (${b.scan || null}::text is null or scan = ${b.scan || null}) order by id desc limit 1`;
    if (!d) return json({ ok: false, error: "no such draft" }, 404);
    if (d.built_at) return json({ ok: false, error: "already blasted off - photos can't be added here" }, 400);
    if (!d.drive_folder_id || String(d.drive_folder_id).startsWith("station")) return json({ ok: false, error: "not a Drive scan draft" }, 400);
    const tok = await driveToken();
    const kids = await list(tok, d.drive_folder_id);
    const files = kids.filter((f) => IMG_RE.test(f.name)).sort((a, c) => a.name.localeCompare(c.name));
    const photos: any[] = Array.isArray(d.photos) ? d.photos : [];
    const have = new Set(photos.map((p: any) => p.drive_id));
    const fresh = files.filter((f) => !have.has(f.id));
    const added: string[] = [];
    for (const f of fresh) {
      const bytes = await download(tok, f.id);
      const url = await imgbbUpload(bytes, `${String(d.scan).replace(/\s+/g, "_")}_${d.p}_add_${photos.length + 1}`);
      photos.push({ n: photos.length + 1, name: f.name, group: "book", drive_id: f.id, url, bytes: bytes.length, added: new Date().toISOString() });
      added.push(f.name);
      await sql`update pipeline.drafts set photos = ${sql.json(photos)} where id = ${d.id}`;
    }
    if (added.length) {
      const isItem = (d.ident || {}).kind === "item";
      const note = `Papa Duck added ${added.length} more photo${added.length === 1 ? "" : "s"} (${added.join(", ")}) - look at them and include what they show.`;
      await sql`update pipeline.drafts set answers = coalesce(answers, '{}'::jsonb) || jsonb_build_object('tell', trim(coalesce(answers->>'tell', '') || ' ' || ${note})),
        item_stale = case when ${isItem} then true else item_stale end, price_stale = case when ${isItem} then price_stale else true end,
        price_attempts = 0, updated_at = now() - interval '1 minute' where id = ${d.id}`;
    }
    return json({ ok: true, draft: d.id, p: d.p, in_folder: files.length, added, total: photos.length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
