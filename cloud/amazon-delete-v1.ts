// Papa Duck - Edge Function "amazon-delete" (2026-10-22). Takes a merchant listing (our SKU = PD number) off Amazon.
// First use: PD-3377 and PD-3383 (two KJV Bibles) were matched to the wrong ASIN (an ESV Church Bible) and Amazon flagged a pricing error.
// POST {"skus":["PD-3377"], "why":"..."}  header x-backup-secret = cron_secret. Deletes the offer, then reads it back (404 = gone).
import postgres from "npm:postgres@3.4.4";
const MKT = "ATVPDKIKX0DER", HOST = "https://sellingpartnerapi-na.amazon.com";
const reply = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== String(cs?.value || "")) return reply({ error: "not allowed" }, 403);
    const body = await req.json().catch(() => ({}));
    const skus: string[] = (body.skus || []).filter((s: string) => /^PD-\d{4}[A-Z]?$/.test(s));
    if (!skus.length) return reply({ error: "no skus" }, 400);
    const r = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const a = JSON.parse(r[0].decrypted_secret).amazon;
    const t = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: a.client_id, client_secret: a.client_secret }).toString() });
    const tok = (await t.json()).access_token;
    if (!tok) return reply({ error: "Amazon login failed" }, 500);
    const H = { "x-amz-access-token": tok, Accept: "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" };
    const out: unknown[] = [];
    for (const sku of skus) {
      const u = `${HOST}/listings/2021-08-01/items/${a.seller_id}/${encodeURIComponent(sku)}?marketplaceIds=${MKT}`;
      const d = await fetch(u, { method: "DELETE", headers: H });
      const dj = await d.json().catch(() => ({}));
      await new Promise((z) => setTimeout(z, 1500));
      const g = await fetch(u + "&includedData=summaries,issues", { headers: H });
      const gj = await g.json().catch(() => ({}));
      out.push({ sku, delete_status: d.status, delete: dj.status || dj, readback: g.status, summaries: gj.summaries || null, issues: (gj.issues || []).map((i: any) => i.message).slice(0, 3) });
      await new Promise((z) => setTimeout(z, 800));
    }
    return reply({ ok: true, out });
  } catch (e) { return reply({ error: String((e as Error).message || e).slice(0, 300) }, 500); }
  finally { await sql.end({ timeout: 2 }); }
});
