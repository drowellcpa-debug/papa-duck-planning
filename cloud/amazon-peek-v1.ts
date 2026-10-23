// Papa Duck - Edge Function "amazon-peek" (2026-10-23). Read-only look at Amazon: catalog page images for an ASIN and our own
// listing status by SKU. Papa Duck: "amazon is not showing some of the pictures" (#3410, #3408).
// POST {"items":[{"sku":"PD-3410","asin":"B004PI9IME"}]}  header x-backup-secret = cron_secret.
import postgres from "npm:postgres@3.4.4";
const MKT = "ATVPDKIKX0DER", HOST = "https://sellingpartnerapi-na.amazon.com";
const reply = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== String(cs?.value || "")) return reply({ error: "not allowed" }, 403);
    const body = await req.json().catch(() => ({}));
    const r = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const a = JSON.parse(r[0].decrypted_secret).amazon;
    const t = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: a.client_id, client_secret: a.client_secret }).toString() });
    const tok = (await t.json()).access_token;
    const H = { "x-amz-access-token": tok, Accept: "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" };
    const out: unknown[] = [];
    for (const it of body.items || []) {
      const c = await fetch(`${HOST}/catalog/2022-04-01/items/${it.asin}?marketplaceIds=${MKT}&includedData=images,summaries`, { headers: H });
      const cj = await c.json().catch(() => ({}));
      const imgs = ((cj.images || [])[0]?.images || []).map((i: any) => i.variant + " " + i.link).slice(0, 6);
      await new Promise((z) => setTimeout(z, 700));
      const l = await fetch(`${HOST}/listings/2021-08-01/items/${a.seller_id}/${encodeURIComponent(it.sku)}?marketplaceIds=${MKT}&includedData=summaries,issues`, { headers: H });
      const lj = await l.json().catch(() => ({}));
      out.push({ sku: it.sku, asin: it.asin, catalog_status: c.status, title: (cj.summaries || [])[0]?.itemName, catalog_images: imgs,
        listing_status: (lj.summaries || [])[0]?.status, listing_image: (lj.summaries || [])[0]?.mainImage?.link || null, issues: (lj.issues || []).map((i: any) => i.message).slice(0, 3) });
      await new Promise((z) => setTimeout(z, 700));
    }
    return reply({ ok: true, out });
  } catch (e) { return reply({ error: String((e as Error).message || e).slice(0, 300) }, 500); }
  finally { await sql.end({ timeout: 2 }); }
});
