// Papa Duck - Edge Function "fba-track" v1 (2026-11-02). Papa Duck: "I want to be able to know the status of my fba boxes sent in and when
// books are ready to sale ... on launch pad". Every 2 hours (pg_cron pd-fba-track) for every box he shipped (pipeline.fba_ship with a
// shipment) that is not finished:
//   1. the shipment's status at Amazon (Fulfillment Inbound v2024-03-20 GET inboundPlans/{plan}/shipments/{shipment})
//   2. units received per book (Inbound v0 GET shipments/{FBA...}/items: QuantityShipped / QuantityReceived)
//   3. what is SELLABLE now (FBA Inventory v1 summaries by SKU = PD: fulfillable / inbound / reserved / unfulfillable)
// -> pipeline.fba_track (box, status, books, ready, ...) for the Launch Pad, plus alerts: box delivered (fyi), all books ready (fyi),
//    books missing or damaged after Amazon closes the box (issue). POST {} = all open boxes; POST {"box": 1} = one box.
// Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOST = "https://sellingpartnerapi-na.amazon.com", MKT = "ATVPDKIKX0DER", V = "/inbound/fba/2024-03-20";
const J = (b: string) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
// Amazon's shipment states -> his words, in order
const STAGES = ["Shipped", "On the way", "Delivered", "Checked in", "Receiving", "Ready"];
function stageOf(st: string): number {
  const s = String(st || "").toUpperCase();
  if (/CLOSED/.test(s)) return 5;
  if (/RECEIVING/.test(s)) return 4;
  if (/CHECKED_IN/.test(s)) return 3;
  if (/DELIVERED/.test(s)) return 2;
  if (/IN_TRANSIT/.test(s)) return 1;
  return 0;
}
Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    await sql`create table if not exists pipeline.fba_track (box int primary key, shipment text, status text, stage int, books jsonb, shipped int, received int,
      ready int, inbound int, problem int, closed_at timestamptz, delivered_at timestamptz, checked_at timestamptz, note text)`;
    const A = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).amazon;
    const t = J(await (await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString() })).text());
    if (!t.access_token) throw new Error("Amazon login failed");
    const diag: string[] = [];
    const t0 = Date.now();
    const api = async (path: string, params: Record<string, string> = {}) => {
      for (let a = 0; a < 3; a++) {
        try {
          const r = await fetch(HOST + path + (Object.keys(params).length ? "?" + new URLSearchParams(params) : ""), { headers: { "x-amz-access-token": t.access_token, Accept: "application/json", "User-Agent": "PapaDuckFBA/1 (Language=TypeScript)" }, signal: AbortSignal.timeout(20000) });
          const body = await r.text();
          diag.push(`${path.split("?")[0].slice(0, 60)} ${r.status} ${Date.now() - t0}ms${r.status >= 400 ? " " + body.slice(0, 160) : ""}`);
          if (r.status === 429 || r.status >= 500) { await sleep(2000 * (a + 1)); continue; }
          return { status: r.status, j: J(body) };
        } catch (e) { diag.push(`${path.slice(0, 60)} timeout/err ${Date.now() - t0}ms`); }
      }
      return { status: 429, j: {} };
    };
    const boxes = await sql`select s.box, s.plan_id, s.shipment_id, s.confirmation_id, s.items, s.label_at, s.chosen, s.options, t.closed_at, t.status old_status, t.ready old_ready
      from pipeline.fba_ship s left join pipeline.fba_track t on t.box = s.box
      where s.shipment_id is not null and s.state = 'done' and (${b.box ? Number(b.box) : null}::int is null or s.box = ${b.box ? Number(b.box) : null}::int)
        and (t.closed_at is null or t.closed_at > now() - interval '3 days' or ${!!b.box})`;
    const out: any[] = [];
    for (const s of boxes as any[]) {
      // 1) status
      const sh = (await api(`${V}/inboundPlans/${s.plan_id}/shipments/${s.shipment_id}`)).j || {};
      const status = String(sh.status || s.old_status || "SHIPPED");
      const stage = stageOf(status);
      // 2) units received per book (v0 knows the FBA... confirmation id)
      const rec: Record<string, { shipped: number; received: number }> = {};
      if (s.confirmation_id) {
        // Amazon keeps handing back a NextToken even on the last page - stop when a page adds nothing new (max 5 pages)
        let next = "", pages = 0;
        do {
          const r = await api(`/fba/inbound/v0/shipments/${s.confirmation_id}/items`, { MarketplaceId: MKT, ...(next ? { NextToken: next } : {}) });
          const before = Object.keys(rec).length;
          for (const it of (r.j.payload?.ItemData || [])) rec[String(it.SellerSKU)] = { shipped: Number(it.QuantityShipped) || 0, received: Number(it.QuantityReceived) || 0 };
          const nt = r.j.payload?.NextToken || "";
          next = nt && nt !== next && Object.keys(rec).length > before ? nt : "";
        } while (next && ++pages < 5);
      }
      // 3) sellable now
      const pds: string[] = (s.items || []).map(String);
      const inv: Record<string, any> = {};
      for (let i = 0; i < pds.length; i += 50) {
        const r = await api("/fba/inventory/v1/summaries", { details: "true", granularityType: "Marketplace", granularityId: MKT, marketplaceIds: MKT, sellerSkus: pds.slice(i, i + 50).join(",") });
        for (const x of (r.j.payload?.inventorySummaries || [])) inv[String(x.sellerSku)] = x;
      }
      const titles = Object.fromEntries((await sql`select pd, title from pipeline.fba_items where pd = any(${pds})`).map((r: any) => [r.pd, r.title]));
      const sold = new Set((await sql`select info->>'pd' pd from pipeline.sales_done where key like 'amazon:%' and info->>'pd' = any(${pds})`).map((r: any) => r.pd));
      const books = pds.map((pd) => {
        const d = inv[pd]?.inventoryDetails || {}, rc = rec[pd] || { shipped: 1, received: 0 };
        const ready = Number(d.fulfillableQuantity) || 0, reserved = Number(d.reservedQuantity?.totalReservedQuantity) || 0;
        const unf = Number(d.unfulfillableQuantity?.totalUnfulfillableQuantity) || 0;
        const inbound = (Number(d.inboundWorkingQuantity) || 0) + (Number(d.inboundShippedQuantity) || 0) + (Number(d.inboundReceivingQuantity) || 0);
        let st = "on the way";
        if (sold.has(pd)) st = "sold";
        else if (ready > 0) st = "ready";
        else if (unf > 0) st = "damaged";
        else if (reserved > 0) st = "being processed";
        else if (rc.received > 0) st = "received";
        else if (stage >= 3) st = "waiting to be received";
        if (stage === 5 && rc.received < rc.shipped && !sold.has(pd) && ready === 0) st = "missing";
        return { pd, title: titles[pd] || "", st, shipped: rc.shipped, received: rc.received, ready, reserved, unf, inbound };
      });
      const n = (k: string) => books.filter((x) => x.st === k).length;
      const readyN = n("ready") + n("sold"), problemN = n("missing") + n("damaged");
      const opt = (s.options || []).find((o: any) => o.placement === s.chosen) || {};
      await sql`insert into pipeline.fba_track (box, shipment, status, stage, books, shipped, received, ready, inbound, problem, closed_at, delivered_at, checked_at, note)
        values (${s.box}, ${s.confirmation_id}, ${status}, ${stage}, ${sql.json(books)}, ${books.length}, ${books.filter((x) => x.received > 0).length}, ${readyN},
          ${books.filter((x) => x.inbound > 0).length}, ${problemN}, ${stage === 5 ? sql`now()` : null}, ${stage >= 2 ? sql`now()` : null}, now(), ${[opt.city, opt.st].filter(Boolean).join(", ")})
        on conflict (box) do update set status = excluded.status, stage = excluded.stage, books = excluded.books, shipped = excluded.shipped, received = excluded.received,
          ready = excluded.ready, inbound = excluded.inbound, problem = excluded.problem, checked_at = now(), note = coalesce(nullif(excluded.note, ''), pipeline.fba_track.note),
          closed_at = coalesce(pipeline.fba_track.closed_at, excluded.closed_at), delivered_at = coalesce(pipeline.fba_track.delivered_at, excluded.delivered_at)`;
      // alerts
      if (stage >= 2) await sql`select pipeline.alert_add('Amazon', ${"FBA Box #" + s.box + " delivered to Amazon"}, ${"Amazon has your box (" + s.confirmation_id + "). Next they check it in and shelve the books - usually 3 to 10 days."}, null, null, 'fyi', ${"fbatrack:" + s.box + ":delivered"})`;
      if (readyN && readyN === books.length) await sql`select pipeline.alert_add('Amazon', ${"FBA Box #" + s.box + ": all " + books.length + " books ready to sell"}, 'Every book from this box is live on Amazon (Prime). Nothing to do.', null, null, 'fyi', ${"fbatrack:" + s.box + ":ready"})`;
      if (stage === 5 && problemN) await sql`select pipeline.alert_add('Amazon', ${"FBA Box #" + s.box + ": " + problemN + " book" + (problemN === 1 ? "" : "s") + " missing or damaged"}, ${"Amazon closed the box but " + books.filter((x) => x.st === "missing" || x.st === "damaged").map((x) => x.pd + " (" + x.st + ")").join(", ") + ". Tell Claude - Amazon owes you a reimbursement if they lost it."}, null, null, 'issue', ${"fbatrack:" + s.box + ":problem"})`;
      out.push({ box: s.box, status, stage: STAGES[stage], ready: readyN, of: books.length, problem: problemN });
    }
    return json({ ok: true, boxes: out, diag: diag.slice(0, 20) });
  } catch (e) { return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500); }
  finally { await sql.end({ timeout: 3 }); }
});
