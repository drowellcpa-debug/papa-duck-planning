// Papa Duck - Edge Function "copy-wording-etsy" v1 (2026-11-04). Papa Duck: copy counts like "Two identical copies available" "should never be on the wording of any description".
// Reads every ACTIVE Etsy listing (shop listings API, description included), finds sentences that state a copy count, and with {"fix":true}
// PATCHes the description with ONLY those sentences removed, then reads it back. Without fix it only reports. Before text kept in pipeline.abe_probe ("cwetsy:").
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", ETSY_SHOP = "65331509";
const NUM = "\\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple";
export const isCount = (s: string) => /\b(cop(y|ies)|units?)\b/i.test(s) && !/no longer available|new copies|spare copy|lot of identical copies|need(ing|s)? (multiple|matching) copies|printing|print run|numbered|limited to|edition of|copies (sold|in print|included)|\binclud(e|es|ed|ing)\b|\bset\b|bundle/i.test(s) &&
  (new RegExp(`\\b(${NUM})\\b[^.;]*\\b(copies|units)\\b`, "i").test(s) || /\b(copies|units) (are )?(available|on hand)\b/i.test(s) || /\bquantity\b/i.test(s));
// Etsy descriptions are plain text with line breaks: clean line by line, sentence by sentence, keep the line breaks
export const clean = (t: string) => t.split("\n").map((line) => {
  const p = line.split(/(?<=[.!?])(\s+)/); let o = "";
  for (let i = 0; i < p.length; i += 2) if (!(p[i] && isCount(p[i]))) o += p[i] + (p[i + 1] || "");
  return /^\W*quantity:?\s*$/i.test(o) ? "" : o.replace(/\s+$/, "");
}).join("\n").replace(/\n{3,}/g, "\n\n");

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const ek = JSON.parse(vr[0].decrypted_secret).etsy;
    if (!(ek.access_token && (ek.expires_at || 0) > Date.now() + 5 * 60e3)) {
      const r = await fetch("https://api.etsy.com/v3/public/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", client_id: ETSY_CLIENT, refresh_token: ek.refresh_token }) });
      const j = await r.json();
      if (!j.access_token || !j.refresh_token) throw new Error(`Etsy token refresh failed (${r.status})`);
      ek.access_token = j.access_token; ek.refresh_token = j.refresh_token; ek.expires_at = Date.now() + Number(j.expires_in || 3600) * 1000;
      const cur = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
      cur.etsy = ek; await sql`select vault.update_secret(${vr[0].id}::uuid, ${JSON.stringify(cur)})`;
    }
    const H = { "x-api-key": `${ETSY_CLIENT}:${ek.shared_secret}`, Authorization: "Bearer " + ek.access_token, Accept: "application/json" };
    const hits: any[] = [];
    for (let off = 0; off < 5000; off += 100) {
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP}/listings?state=active&limit=100&offset=${off}`, { headers: H });
      const j = await r.json();
      if (!r.ok) throw new Error(`Etsy ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
      for (const l of j.results || []) {
        const d = String(l.description || ""), c = clean(d);
        if (c.trim() !== d.trim()) hits.push({ id: l.listing_id, sku: (l.skus || [])[0] || "", qty: l.quantity, before: d, after: c });
      }
      if ((j.results || []).length < 100) break;
    }
    const out: any[] = [];
    for (const h of hits) {
      const row: any = { id: h.id, sku: h.sku, qty: h.qty, cut: h.before.length - h.after.length,
        removed: h.before.split(/\n|(?<=[.!?])\s+/).filter((s: string) => s.trim() && isCount(s)).map((s: string) => s.trim().slice(0, 140)) };
      if (b.fix) {
        await sql`insert into pipeline.abe_probe (k, html, at) values (${"cwetsy-before:" + h.id + "@" + Date.now()}, ${h.before}, now())`;
        const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP}/listings/${h.id}`, { method: "PATCH",
          headers: { ...H, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ description: h.after }).toString() });
        const j = await r.json().catch(() => ({}));
        row.ok = r.ok && clean(String(j.description || "")).trim() === String(j.description || "").trim();
        if (!r.ok) row.error = `${r.status} ${JSON.stringify(j).slice(0, 160)}`;
      }
      out.push(row);
    }
    return json({ ok: true, fix: !!b.fix, found: hits.length, listings: out });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
