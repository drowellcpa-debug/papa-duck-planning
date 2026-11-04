// Papa Duck - Edge Function "sales-history" v1 (2026-11-04). Papa Duck: "so you went through the entire sales and verified that since the beginning".
// Read-only: pulls every past SALE from Etsy (shop receipts) and Amazon (Orders API + order items) into audit.sold_ext (pd, channel, day, ref).
// AbeBooks has no order-history API - its sales come from Gmail (done separately). Nothing on any store is changed.
// POST {"store":"etsy"|"amazon", "since":"2026-04-01"}. Each call ~100 s, cursor in audit.runs ("hist_<store>"); call again until done=true.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", ETSY_SHOP = "65331509", AMZ = "https://sellingpartnerapi-na.amazon.com", MKT = "ATVPDKIKX0DER";

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now(), budget = 100000;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const store = String(b.store || ""), key = "hist_" + store, since = String(b.since || "2026-04-01");
    await sql`create table if not exists audit.sold_ext (channel text, ref text, pd text, day date, title text, qty int, primary key (channel, ref, pd))`;
    let [run] = await sql`select * from audit.runs where store = ${key}`;
    if (!run || b.restart || run.finished_at) {
      await sql`insert into audit.runs (store, run_id, started_at, cursor, n) values (${key}, ${new Date().toISOString()}, now(), null, 0)
        on conflict (store) do update set started_at = now(), finished_at = null, cursor = null, n = 0`;
      [run] = await sql`select * from audit.runs where store = ${key}`;
    }
    let cursor: string | null = run.cursor, n = Number(run.n || 0), done = false;
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const K = JSON.parse(vr[0].decrypted_secret);

    if (store === "etsy") {
      const e = K.etsy;
      if (!(e.access_token && (e.expires_at || 0) > Date.now() + 5 * 60e3)) {
        const r = await fetch("https://api.etsy.com/v3/public/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: ETSY_CLIENT, refresh_token: e.refresh_token }) });
        const j = await r.json();
        if (!j.access_token || !j.refresh_token) throw new Error(`Etsy token refresh failed (${r.status})`);
        e.access_token = j.access_token; e.refresh_token = j.refresh_token; e.expires_at = Date.now() + Number(j.expires_in || 3600) * 1000;
        const cur = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
        cur.etsy = e; await sql`select vault.update_secret(${vr[0].id}::uuid, ${JSON.stringify(cur)})`;
      }
      const H = { "x-api-key": `${ETSY_CLIENT}:${e.shared_secret}`, Authorization: "Bearer " + e.access_token, Accept: "application/json" };
      let off = Number(cursor || 0);
      const minTs = Math.floor(new Date(since).getTime() / 1000);
      while (Date.now() - t0 < budget) {
        const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP}/receipts?limit=100&offset=${off}&min_created=${minTs}`, { headers: H });
        const j = await r.json();
        if (!r.ok) throw new Error(`Etsy ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
        const rows: any[] = [];
        for (const rc of j.results || []) {
          if (rc.status && /cancel/i.test(rc.status)) continue;
          const day = new Date((rc.created_timestamp || rc.create_timestamp) * 1000).toISOString().slice(0, 10);
          for (const t of rc.transactions || []) {
            const pd = String(t.sku || "").toUpperCase();
            rows.push({ channel: "Etsy", ref: String(rc.receipt_id) + ":" + String(t.listing_id), pd: pd || "LISTING:" + t.listing_id, day, title: String(t.title || "").slice(0, 120), qty: Number(t.quantity || 1) });
          }
        }
        if (rows.length) await sql`insert into audit.sold_ext ${sql(rows)} on conflict (channel, ref, pd) do update set day = excluded.day, title = excluded.title, qty = excluded.qty`;
        n += rows.length;
        if ((j.results || []).length < 100) { done = true; break; }
        off += 100;
      }
      cursor = String(off);
    }

    if (store === "amazon") {
      const A = K.amazon;
      const t = await (await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString() })).json();
      const H = { "x-amz-access-token": t.access_token, Accept: "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" };
      const get = async (u: string) => { for (let a = 0; a < 6; a++) { const r = await fetch(u, { headers: H }); if (r.status === 429) { await sleep(3000); continue; } return [r, await r.json()] as const; } throw new Error("Amazon kept saying slow down"); };
      let token = cursor || "";
      while (Date.now() - t0 < budget) {
        const q = token ? new URLSearchParams({ MarketplaceIds: MKT, NextToken: token }) : new URLSearchParams({ MarketplaceIds: MKT, CreatedAfter: since + "T00:00:00Z" });
        const [r, j] = await get(`${AMZ}/orders/v0/orders?${q}`);
        if (!r.ok) throw new Error(`Amazon orders ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
        for (const o of j.payload?.Orders || []) {
          if (/Canceled/i.test(o.OrderStatus || "")) continue;
          const day = String(o.PurchaseDate || "").slice(0, 10);
          const [ri, ji] = await get(`${AMZ}/orders/v0/orders/${o.AmazonOrderId}/orderItems`);
          if (!ri.ok) continue;
          const rows = (ji.payload?.OrderItems || []).map((it: any) => ({ channel: "Amazon", ref: o.AmazonOrderId, pd: String(it.SellerSKU || "").toUpperCase(), day, title: String(it.Title || "").slice(0, 120), qty: Number(it.QuantityOrdered || 1) }));
          if (rows.length) await sql`insert into audit.sold_ext ${sql(rows)} on conflict (channel, ref, pd) do update set day = excluded.day, title = excluded.title, qty = excluded.qty`;
          n += rows.length;
          await sleep(2100);
        }
        token = j.payload?.NextToken || "";
        if (!token) { done = true; break; }
      }
      cursor = token;
    }

    await sql`update audit.runs set cursor = ${cursor}, n = ${n}, finished_at = ${done ? new Date() : null} where store = ${key}`;
    return json({ ok: true, store, n, done });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
