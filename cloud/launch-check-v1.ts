// Papa Duck - Edge Function "launch-check" v1 (2026-10-24). Papa Duck: "with api can not you verify that, dig deeper".
// After a Launch Pad night is sent, this checks the LIVE stores (not just "we sent it"):
//   AbeBooks - public search inside his storefront (vci 91371820) by title; the listing block that carries his PD number
//              says data-csa-c-element-type="bookseller-image" (his photos are attached) or "stock-image" (no photos yet).
//              AbeBooks has no read API (the Inventory Update API is add/delete only), so the public page is the source.
//   Amazon   - Listings API GET by SKU = PD: summaries.status (BUYABLE / DISCOVERABLE) and any ERROR issues.
// Results -> pipeline.launch_live_check (night_id, channel, pd, state, detail). States: ok | waiting | problem | not_found.
// POST {night_id, channels?: ["abe","amazon"]}. Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const VCI = "91371820", MKT = "ATVPDKIKX0DER", AMZ_HOST = "https://sellingpartnerapi-na.amazon.com";

function words(t: string, n: number) {
  return String(t || "").replace(/["'“”‘’:;,.!?()\[\]]/g, " ").split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}
async function abeOne(pd: string, title: string): Promise<[string, string]> {
  for (const n of [6, 3]) {
    const q = words(title, n); if (!q) break;
    const u = `https://www.abebooks.com/servlet/SearchResults?vci=${VCI}&tn=${encodeURIComponent(q)}&rollup=off`;
    let html = "";
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(25000) });
        if (r.status === 200) { html = await r.text(); break; }
        await sleep(1500 * (a + 1));
      } catch { await sleep(1500 * (a + 1)); }
    }
    if (!html) return ["problem", "AbeBooks search did not answer"];
    const blocks = html.split('data-test-id="listing-item-').slice(1);
    const re = new RegExp(pd.replace("-", "\\-") + "(?![0-9])");
    const b = blocks.find((x) => re.test(x));
    if (b) {
      const kind = /data-csa-c-element-type="([a-z-]+)"/.exec(b)?.[1] || "";
      const id = /^([0-9]+)/.exec(b)?.[1] || "";
      if (kind === "bookseller-image") return ["ok", `photos showing (listing ${id})`];
      if (kind === "stock-image") return ["waiting", `no photos yet (listing ${id})`];
      return ["problem", `listing ${id} found, picture type "${kind}"`];
    }
  }
  return ["not_found", "not found in the AbeBooks store search yet"];
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const body = await req.json().catch(() => ({}));
    const nid = Number(body.night_id);
    const want: string[] = body.channels || ["abe", "amazon"];
    const [n] = await sql`select * from pipeline.launch_nights where id = ${nid}`;
    if (!n?.jobs) return json({ ok: false, error: "night has no jobs" }, 400);
    const out: Record<string, number> = {};
    const save = async (ch: string, pd: string, st: string, d: string) => {
      out[ch + ":" + st] = (out[ch + ":" + st] || 0) + 1;
      await sql`insert into pipeline.launch_live_check (night_id, channel, pd, state, detail, checked_at) values (${nid}, ${ch}, ${pd}, ${st}, ${d}, now())
        on conflict (night_id, channel, pd) do update set state = excluded.state, detail = excluded.detail, checked_at = now()`;
    };

    if (want.includes("abe")) {
      const abeIds = (n.jobs.abe || []).map(Number);
      const rows = await sql`select i.pd, split_part(l, chr(9), 2) as title from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id
        cross join lateral unnest(string_to_array(j.data_file, chr(10))) l
        where i.job_id = any(${abeIds}) and i.state = 'done' and split_part(l, chr(9), 1) = i.pd`;
      // skip books already confirmed ok (photos never disappear once attached)
      const done = new Set((await sql`select pd from pipeline.launch_live_check where night_id = ${nid} and channel = 'abe' and state = 'ok'`).map((r: any) => r.pd));
      const todo = rows.filter((r: any) => !done.has(r.pd));
      for (let k = 0; k < todo.length; k += 5) {
        await Promise.all(todo.slice(k, k + 5).map(async (r: any) => { const [st, d] = await abeOne(r.pd, r.title); await save("abe", r.pd, st, d); }));
        await sleep(400);
      }
      out.abe_checked = todo.length; out.abe_already_ok = done.size;
    }

    if (want.includes("amazon") && n.jobs.amazon) {
      const vr = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
      const A = JSON.parse(vr[0].decrypted_secret).amazon;
      const lr = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString() });
      const tok = (await lr.json()).access_token;
      const items = await sql`select pd from pipeline.send_items where job_id = ${Number(n.jobs.amazon)} and state = 'done'`;
      for (const it of items) {
        let st = "problem", d = "";
        try {
          for (let a = 0; a < 4; a++) {
            const r = await fetch(`${AMZ_HOST}/listings/2021-08-01/items/${A.seller_id}/${encodeURIComponent(it.pd)}?` + new URLSearchParams({ marketplaceIds: MKT, includedData: "summaries,issues,offers" }),
              { headers: { "x-amz-access-token": tok, Accept: "application/json", "User-Agent": "PapaDuckCloud/4 (Language=TypeScript)" } });
            if (r.status === 429 || r.status >= 500) { await sleep(2500 * (a + 1)); continue; }
            const j = await r.json().catch(() => ({}));
            if (r.status === 404) { st = "waiting"; d = "Amazon has not created the listing yet"; break; }
            const s = j.summaries?.[0] || {}, status: string[] = s.status || [];
            const errs = (j.issues || []).filter((x: any) => x.severity === "ERROR").map((x: any) => x.message).join("; ");
            const price = j.offers?.[0]?.price?.amount;
            if (errs) { st = "problem"; d = errs.slice(0, 300); }
            else if (status.includes("BUYABLE")) { st = "ok"; d = `live, buyable${price ? " at $" + Number(price).toFixed(2) : ""} (ASIN ${s.asin || "?"})`; }
            else { st = "waiting"; d = `Amazon status: ${status.join(", ") || "processing"}`; }
            break;
          }
        } catch (e) { d = String((e as Error).message).slice(0, 200); }
        await save("amazon", it.pd, st, d);
        await sleep(300);
      }
    }
    return json({ ok: true, counts: out });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
