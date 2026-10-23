// Papa Duck - Edge Function "amazon-image" (2026-10-23). Suggests our cover photo as the main picture on an Amazon page that has none.
// Papa Duck: "#3410 #3408 no image" ... "Sure". Sends a Listings PATCH (main_product_image_locator) for our SKU; Amazon decides
// whether to accept it for the catalog page. Returns Amazon's answer and the listing issues.
// POST {"items":[{"sku":"PD-3410","image":"https://...jpg"}]}  header x-backup-secret = cron_secret.
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
    const H = { "x-amz-access-token": tok, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" };
    const out: unknown[] = [];
    for (const it of body.items || []) {
      if (!/^PD-\d{4}$/.test(it.sku) || !/^https:\/\//.test(it.image)) { out.push({ sku: it.sku, error: "bad input" }); continue; }
      const u = `${HOST}/listings/2021-08-01/items/${a.seller_id}/${encodeURIComponent(it.sku)}?marketplaceIds=${MKT}&issueLocale=en_US`;
      const p = await fetch(u, { method: "PATCH", headers: H, body: JSON.stringify({ productType: "ABIS_BOOK", patches: [
        { op: "replace", path: "/attributes/main_product_image_locator", value: [{ media_location: it.image, marketplace_id: MKT }] }] }) });
      const pj = await p.json().catch(() => ({}));
      out.push({ sku: it.sku, http: p.status, status: pj.status, issues: (pj.issues || []).map((i: any) => `${i.severity}: ${i.message}`).slice(0, 4) });
      await new Promise((z) => setTimeout(z, 1000));
    }
    return reply({ ok: true, out });
  } catch (e) { return reply({ error: String((e as Error).message || e).slice(0, 300) }, 500); }
  finally { await sql.end({ timeout: 2 }); }
});
