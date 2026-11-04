// Papa Duck - Edge Function "copy-wording" v3 (2026-11-04; v2 sentence split - light on CPU, {"page":N} scans one page; v3 also "units"). Papa Duck: copy counts like "Two identical copies available" "should never be on the wording of any description".
// Read-only scan: pages through every ACTIVE eBay listing (GetSellerList, full descriptions) and records any sentence that states a copy count / availability
// into audit.copy_wording (store, item_id, pd, sentence). POST {"restart":true} then repeat until done=true (~100 s per call, cursor in audit.runs "copywording").
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const WORDS = /\b(available|identical|in stock|on hand|same condition|quantity|we have|i have)\b/i;
const text = (h: string) => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]+>/g, ". ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now();
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    await sql`create table if not exists audit.copy_wording (store text, item_id text, pd text, qty int, sentence text, seen_at timestamptz default now(), primary key (store, item_id, sentence))`;
    let [run] = await sql`select * from audit.runs where store = 'copywording'`;
    if (!run || b.restart || run.finished_at) {
      await sql`insert into audit.runs (store, run_id, started_at, cursor, n) values ('copywording', ${new Date().toISOString()}, now(), '1', 0)
        on conflict (store) do update set started_at = now(), finished_at = null, cursor = '1', n = 0`;
      [run] = await sql`select * from audit.runs where store = 'copywording'`;
    }
    const e = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).ebay;
    let page = Number(b.page || run.cursor || 1), n = Number(run.n || 0), done = false, scanned = 0;
    const from = new Date().toISOString(), to = new Date(Date.now() + 119 * 864e5).toISOString();
    while (Date.now() - t0 < 100000) {
      const x = await (await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": "GetSellerList", "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?><GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${e.auth_token.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</eBayAuthToken></RequesterCredentials>
<EndTimeFrom>${from}</EndTimeFrom><EndTimeTo>${to}</EndTimeTo><DetailLevel>ReturnAll</DetailLevel><Pagination><EntriesPerPage>50</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
<OutputSelector>ItemArray.Item.ItemID</OutputSelector><OutputSelector>ItemArray.Item.SKU</OutputSelector><OutputSelector>ItemArray.Item.Description</OutputSelector><OutputSelector>ItemArray.Item.ConditionDescription</OutputSelector>
<OutputSelector>ItemArray.Item.Quantity</OutputSelector><OutputSelector>ItemArray.Item.SellingStatus.QuantitySold</OutputSelector><OutputSelector>ItemArray.Item.SellingStatus.ListingStatus</OutputSelector>
<OutputSelector>PaginationResult</OutputSelector><OutputSelector>Ack</OutputSelector><OutputSelector>Errors</OutputSelector></GetSellerListRequest>` })).text();
      if (!/<Ack>(Success|Warning)<\/Ack>/.test(x)) throw new Error("eBay: " + ((x.match(/<LongMessage>([^<]*)/) || [])[1] || x.slice(0, 200)));
      const rows: any[] = [];
      for (const it of x.split("<Item>").slice(1)) {
        const g = (t: string) => (it.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
        if (g("ListingStatus") && g("ListingStatus") !== "Active") continue;
        scanned++;
        const body = text(g("Description")) + " . " + text(g("ConditionDescription"));
        const hits = new Set<string>();
        for (const sen of body.split(/(?<=[.!?])\s+/)) if (/\b(cop(y|ies)|units?)\b/i.test(sen) && WORDS.test(sen)) hits.add(sen.replace(/^[\s.]+/, "").trim().slice(0, 400));
        for (const s of hits) rows.push({ store: "eBay", item_id: g("ItemID"), pd: g("SKU").toUpperCase() || null, qty: Number(g("Quantity")) - Number(g("QuantitySold") || 0), sentence: s });
      }
      if (rows.length) await sql`insert into audit.copy_wording ${sql(rows)} on conflict (store, item_id, sentence) do update set seen_at = now(), qty = excluded.qty`;
      n += rows.length;
      const pages = Number((x.match(/<TotalNumberOfPages>(\d+)/) || [])[1] || 1);
      if (b.page) { await sql`update audit.runs set n = n + ${rows.length} where store = 'copywording'`; return json({ ok: true, page, pages, scanned, hits: rows.length }); }
      if (page >= pages) { done = true; break; }
      page++;
    }
    await sql`update audit.runs set cursor = ${String(page)}, n = ${n}, finished_at = ${done ? new Date() : null} where store = 'copywording'`;
    return json({ ok: true, page, scanned, hits: n, done });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
