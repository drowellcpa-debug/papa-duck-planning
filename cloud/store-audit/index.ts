// Papa Duck - Edge Function "store-audit" v2 (2026-11-04; v2: AbeBooks search stops at 1,800 results, so {sort, append} re-walks it in other sort orders into the same run). Papa Duck: "do an audit of every store and make sure that if it is there it is not sold
// elsewhere and give me an audit list". Read-only snapshot of what is LIVE on each store -> audit.ebay / audit.abe / audit.etsy / audit.amazon.
// The compare + list is SQL (audit.report()). Nothing on any store is changed here.
// POST {"store":"ebay"|"abe"|"etsy"|"amazon", "restart":true?}. Each call works ~100 s and saves a cursor in audit.runs; call again until done=true.
// Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const ABE_VCI = "91371820", ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", ETSY_SHOP = "65331509", AMZ = "https://sellingpartnerapi-na.amazon.com", MKT = "ATVPDKIKX0DER";
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now(), budget = 100000;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const store = String(b.store || "");
    if (!["ebay", "abe", "etsy", "amazon"].includes(store)) return json({ error: "store = ebay | abe | etsy | amazon" }, 400);
    let [run] = await sql`select * from audit.runs where store = ${store}`;
    if (b.append && run) { await sql`update audit.runs set finished_at = null, cursor = null where store = ${store}`; run.cursor = null; run.finished_at = null; }
    if (!run || b.restart || run.finished_at) {
      const id = new Date().toISOString();
      await sql`insert into audit.runs (store, run_id, started_at, finished_at, cursor, n, note) values (${store}, ${id}, now(), null, null, 0, null)
        on conflict (store) do update set run_id = excluded.run_id, started_at = now(), finished_at = null, cursor = null, n = 0, note = null`;
      [run] = await sql`select * from audit.runs where store = ${store}`;
    }
    const runId = run.run_id;
    let cursor: string | null = run.cursor, n = Number(run.n || 0), done = false;
    const vr = await sql`select id, decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const K = JSON.parse(vr[0].decrypted_secret);

    if (store === "ebay") {
      const e = K.ebay;
      const call = async (inner: string) => (await (await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": "GetMyeBaySelling", "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${e.auth_token.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</eBayAuthToken></RequesterCredentials>${inner}</GetMyeBaySellingRequest>` })).text());
      const pick = (x: string, t: string) => (x.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || "";
      let page = Number(cursor || 1);
      while (Date.now() - t0 < budget) {
        const x = await call(`<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`);
        const al = (x.match(/<ActiveList>([\s\S]*)<\/ActiveList>/) || [])[1] || "";
        const pages = Number(pick(al, "TotalNumberOfPages")) || 1;
        const rows = [...al.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((m) => ({ item_id: pick(m[1], "ItemID"), sku: pick(m[1], "SKU"), qty: Number(pick(m[1], "Quantity") || 0),
          avail: Number(pick(m[1], "QuantityAvailable") || 0), title: pick(m[1], "Title").slice(0, 120), run_id: runId }));
        if (rows.length) await sql`insert into audit.ebay ${sql(rows)} on conflict (item_id) do update set sku = excluded.sku, qty = excluded.qty, avail = excluded.avail, title = excluded.title, run_id = excluded.run_id, seen_at = now()`;
        n += rows.length;
        if (!rows.length || page >= pages) { done = true; break; }
        page++;
      }
      cursor = String(page);
    }

    if (store === "abe") {
      // public storefront search (AbeBooks has no read API); 30 per page, newest first; "Seller Inventory # PD-xxxx" in each listing
      let off = Number(cursor || 0);
      while (Date.now() - t0 < budget) {
        const u = `https://www.abebooks.com/servlet/SearchResults?vci=${ABE_VCI}&rollup=off&sortby=${Number(b.sort) || 0}&bsi=${off}`;
        let h = "";
        for (let a = 0; a < 3; a++) { const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US" } }); h = await r.text(); if (r.ok) break; await sleep(3000); }
        const parts = h.split(/data-test-id="listing-item-/).slice(1);
        const rows = parts.map((p) => {
          const id = (p.match(/^(\d+)/) || [])[1] || "";
          const pd = ((p.match(/Seller Inventory #\s*([A-Za-z0-9-]+)/) || [])[1] || "").toUpperCase();
          const qty = Number((p.match(/Quantity:(?:<!-- -->)?\s*(?:<!-- -->)?(\d+)/) || [])[1] || 1);
          const btn = (p.match(/<button data-listingid="\d+"[^>]*>/) || [])[0] || "";
          const price = Number((btn.match(/data-csa-c-cost="([\d.]+)"/) || [])[1] || 0);
          const title = strip((btn.match(/aria-label="Add to basket:\s*([^"]*)"/) || [])[1] || "").slice(0, 120);
          return { listing_id: id, pd, qty, price, title, run_id: runId };
        }).filter((r) => r.listing_id);
        if (rows.length) await sql`insert into audit.abe ${sql(rows)} on conflict (listing_id) do update set pd = excluded.pd, qty = excluded.qty, price = excluded.price, title = excluded.title, run_id = excluded.run_id, seen_at = now()`;
        n += rows.length;
        if (rows.length < 30) { done = true; break; }
        off += 30;
        await sleep(400);
      }
      cursor = String(off);
    }

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
      let off = Number(cursor || 0);
      while (Date.now() - t0 < budget) {
        const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${ETSY_SHOP}/listings?state=active&limit=100&offset=${off}`,
          { headers: { "x-api-key": `${ETSY_CLIENT}:${e.shared_secret}`, Authorization: "Bearer " + e.access_token, Accept: "application/json" } });
        const j = await r.json();
        if (!r.ok) throw new Error(`Etsy ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
        const rows = (j.results || []).map((l: any) => ({ listing_id: String(l.listing_id), sku: String((l.skus || [])[0] || "").toUpperCase(), qty: Number(l.quantity || 0), state: l.state,
          title: String(l.title || "").slice(0, 120), run_id: runId }));
        if (rows.length) await sql`insert into audit.etsy ${sql(rows)} on conflict (listing_id) do update set sku = excluded.sku, qty = excluded.qty, state = excluded.state, title = excluded.title, run_id = excluded.run_id, seen_at = now()`;
        n += rows.length;
        if (rows.length < 100) { done = true; break; }
        off += 100;
      }
      cursor = String(off);
    }

    if (store === "amazon") {
      const A = K.amazon;
      const t = await (await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString() })).json();
      const H = { "x-amz-access-token": t.access_token, Accept: "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" };
      let token = cursor || "";
      while (Date.now() - t0 < budget) {
        const q = new URLSearchParams({ marketplaceIds: MKT, pageSize: "20", includedData: "summaries,offers,fulfillmentAvailability" });
        if (token) q.set("pageToken", token);
        let r: Response | null = null, j: any = {};
        for (let a = 0; a < 5; a++) { r = await fetch(`${AMZ}/listings/2021-08-01/items/${A.seller_id}?${q}`, { headers: H }); if (r.status !== 429) break; await sleep(2500); }
        j = await r!.json();
        if (!r!.ok) throw new Error(`Amazon ${r!.status} ${JSON.stringify(j).slice(0, 200)}`);
        const rows = (j.items || []).map((it: any) => {
          const s = (it.summaries || [])[0] || {}, fa = (it.fulfillmentAvailability || [])[0] || {}, of = (it.offers || [])[0] || {};
          return { sku: String(it.sku || "").toUpperCase(), asin: s.asin || null, status: (s.status || []).join(","), qty: fa.quantity ?? null, channel: fa.fulfillmentChannelCode || null,
            price: Number(of.price?.amount ?? of.price?.Amount ?? 0) || null, title: String(s.itemName || "").slice(0, 120), run_id: runId };
        }).filter((x: any) => x.sku);
        if (rows.length) await sql`insert into audit.amazon ${sql(rows)} on conflict (sku) do update set asin = excluded.asin, status = excluded.status, qty = excluded.qty, channel = excluded.channel, price = excluded.price, title = excluded.title, run_id = excluded.run_id, seen_at = now()`;
        n += rows.length;
        token = j.pagination?.nextToken || "";
        if (!token) { done = true; break; }
        await sleep(250);
      }
      cursor = token;
    }

    await sql`update audit.runs set cursor = ${cursor}, n = ${n}, finished_at = ${done ? new Date() : null} where store = ${store}`;
    return json({ ok: true, store, n, done });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
