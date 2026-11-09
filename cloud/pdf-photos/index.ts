// Papa Duck - Edge Function "pdf-photos" v1 (2026-11-08). Papa Duck: "accidentally a pdf can that image get processed?"
// His phone saved P99 (Scan 110826 AM) as one PDF instead of photos, so the drafts worker (photos only) skipped it.
// This opens every PDF in a Drive P folder, pulls out the JPEG photos inside it (scanner PDFs keep each page as a plain JPEG),
// and saves them into the same P folder as 01-<pdf name>.jpg, 02-... The drafts worker then picks the folder up like any other.
// The PDF itself is left alone. POST {"folder":"<Drive P folder id>"}. Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const b64url = (b: ArrayBuffer | string) => {
  const s = typeof b === "string" ? btoa(b) : btoa(String.fromCharCode(...new Uint8Array(b)));
  return s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
};
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
// every JPEG (FF D8 FF ... FF D9) sitting in a PDF stream, in page order
function jpegs(pdf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const txt = new TextDecoder("latin1").decode(pdf);
  let at = 0;
  while (true) {
    const s = txt.indexOf("stream", at); if (s < 0) break;
    let b = s + 6; if (txt[b] === "\r") b++; if (txt[b] === "\n") b++;
    const e = txt.indexOf("endstream", b); if (e < 0) break;
    if (pdf[b] === 0xff && pdf[b + 1] === 0xd8 && pdf[b + 2] === 0xff) {
      let end = e; while (end > b && !(pdf[end - 2] === 0xff && pdf[end - 1] === 0xd9)) end--;
      if (end > b + 1000) out.push(pdf.slice(b, end));
    }
    at = e + 9;
  }
  return out;
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== String(cs?.value || "")) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    if (!b.folder) return json({ error: "folder needed" }, 400);
    const tok = await driveToken();
    const H = { Authorization: `Bearer ${tok}` };
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q", `'${b.folder}' in parents and trashed = false`);
    u.searchParams.set("fields", "files(id,name,mimeType)");
    const kids = ((await (await fetch(u, { headers: H })).json()).files || []) as any[];
    const have = new Set(kids.map((f) => f.name));
    const made: string[] = [];
    let n = kids.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name)).length;
    for (const f of kids.filter((k) => k.mimeType === "application/pdf" || /\.pdf$/i.test(k.name))) {
      const pdf = new Uint8Array(await (await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: H })).arrayBuffer());
      const pics = jpegs(pdf);
      const stem = f.name.replace(/\.pdf$/i, "");
      for (const pic of pics) {
        n++;
        const name = `${String(n).padStart(2, "0")}-${stem}.jpg`;
        if (have.has(name)) continue;
        const bd = "pdfphotos" + crypto.randomUUID().replace(/-/g, "");
        const meta = JSON.stringify({ name, parents: [b.folder], mimeType: "image/jpeg" });
        const head = new TextEncoder().encode(`--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${bd}\r\nContent-Type: image/jpeg\r\n\r\n`);
        const tail = new TextEncoder().encode(`\r\n--${bd}--`);
        const body = new Uint8Array(head.length + pic.length + tail.length);
        body.set(head, 0); body.set(pic, head.length); body.set(tail, head.length + pic.length);
        const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
          { method: "POST", headers: { ...H, "Content-Type": `multipart/related; boundary=${bd}` }, body });
        const j = await r.json();
        if (!r.ok) throw new Error("upload failed: " + JSON.stringify(j).slice(0, 200));
        made.push(`${name} (${Math.round(pic.length / 1024)} KB)`);
      }
    }
    return json({ ok: true, made });
  } catch (e) {
    return json({ error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
