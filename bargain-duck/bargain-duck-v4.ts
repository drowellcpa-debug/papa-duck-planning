// 🦆 Bargain Duck - Edge Function "bargain-duck" v4 (2026-11-03; v4 = Hold Shelf: bought/holding books, auto-release to the blast off in listing season Jun 1-Aug 31 & Dec 1-Jan 20). Papa Duck: "you know what it is doing would it be possible to build our own
// from scratch" (his home-PC textbook price check that emailed "BUY NOW - N titles in buy zone"). Its own schema bd.* - it never touches
// Book Inventory, Drafts, the blast-off or any store listing.
// Daily (pg_cron pd-bargain-duck): Keepa (1 token per book, 100 per call, 1 year of used-price history) for every book on bd.watch:
//   SELL TARGET = the median used price during last year's buying season where Keepa shows it really sold (see v2 below).
//                 His own sell_override wins.
//   BUY TARGET  = the most he can pay and still clear min_profit ($50, Papa Duck 2026-11-03) AND min_roi (25%) after Amazon's cut
//                 (15% + $1.80): net = sell x 0.85 - 1.80; buy = min(net / 1.25, net - 50). His buy_override wins. (bd.settings)
//   USED NOW    = Keepa's lowest used price today.  Profit if bought now = net - used.
//   buy: used <= buy target   close: within 20% above   watching: the rest   can't make $50 / no season sales: never will on today's data.
// -> bd.check (one row per book), bd.history (daily), and ONE Launch Pad alert a day listing books that newly hit the buy zone.
// POST {} = check all. POST {"asins":["..."]} = check these. POST {"add":"isbn or asin"} = add a book (title from Keepa) and check it.
// Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
const KEY = "KEEPA_KEY_REDACTED";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kmToMs = (m: number) => (m + 21564000) * 60000;
const c2d = (v: any) => (typeof v === "number" && v > 0 ? Math.round(v) / 100 : null);
const r2 = (x: number) => Math.round(x * 100) / 100;
const down99 = (x: number) => (x >= 1 ? Math.floor(x) - 0.01 + (x - Math.floor(x) >= 0.99 ? 1 : 0) : r2(x));

// time-weighted percentile of a Keepa [time, price, time, price...] series over the last `days`
function pctl(csv: number[] | null, p: number, days = 365): number | null {
  if (!csv || csv.length < 2) return null;
  const now = Date.now(), from = now - days * 864e5, buckets: [number, number][] = [];
  for (let i = 0; i < csv.length; i += 2) {
    const t0 = kmToMs(csv[i]), t1 = i + 2 < csv.length ? kmToMs(csv[i + 2]) : now, v = csv[i + 1];
    const a = Math.max(t0, from), b = Math.min(t1, now);
    if (b > a && v > 0) buckets.push([v, b - a]);
  }
  const total = buckets.reduce((s, x) => s + x[1], 0);
  if (!total) return null;
  buckets.sort((x, y) => x[0] - y[0]);
  let acc = 0;
  for (const [v, w] of buckets) { acc += w; if (acc >= p * total) return v / 100; }
  return buckets[buckets.length - 1][0] / 100;
}

// v2 (2026-11-03) Papa Duck: "the idea is that I buy when they are low and then will sell in the homeschool selling months ... as long as the
// keepa info says they sell during the homeschool buying period for higher". SELL TARGET = the time-weighted MEDIAN used price during the
// most recent buying season(s) - Back to school Jul 1 - Sep 15, and the college January rush Dec 26 - Jan 31 - but only a season where
// Keepa's sales rank shows real sales (3+ rank drops in that window). The best proven season wins.
function seasons(now = new Date()) {
  const y = now.getUTCFullYear(), out: { name: string; from: number; to: number }[] = [];
  const bts = (yy: number) => ({ name: `Back to school ${yy}`, from: Date.UTC(yy, 6, 1), to: Date.UTC(yy, 8, 15) });
  const jan = (yy: number) => ({ name: `January ${yy}`, from: Date.UTC(yy - 1, 11, 26), to: Date.UTC(yy, 0, 31) });
  for (const s of [bts(y), bts(y - 1)]) if (s.to < now.getTime()) { out.push(s); break; }
  for (const s of [jan(y), jan(y - 1)]) if (s.to < now.getTime()) { out.push(s); break; }
  return out;
}
function windowMedian(csv: number[] | null, from: number, to: number): number | null {
  if (!csv || csv.length < 2) return null;
  const parts: [number, number][] = [];
  for (let i = 0; i < csv.length; i += 2) {
    const t0 = kmToMs(csv[i]), t1 = i + 2 < csv.length ? kmToMs(csv[i + 2]) : Date.now(), v = csv[i + 1];
    const a = Math.max(t0, from), b = Math.min(t1, to);
    if (b > a && v > 0) parts.push([v, b - a]);
  }
  const total = parts.reduce((s, x) => s + x[1], 0);
  if (total < 0.4 * (to - from)) return null;   // need prices for most of the season
  parts.sort((x, y) => x[0] - y[0]);
  let acc = 0;
  for (const [v, w] of parts) { acc += w; if (acc >= total / 2) return v / 100; }
  return null;
}
function rankDrops(csv: number[] | null, from: number, to: number): number {
  if (!csv) return 0;
  let n = 0, prev = -1;
  for (let i = 0; i < csv.length; i += 2) {
    const t = kmToMs(csv[i]), v = csv[i + 1];
    if (t >= from && t <= to && prev > 0 && v > 0 && v < prev) n++;
    if (v > 0) prev = v;
  }
  return n;
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const S = Object.fromEntries((await sql`select k, v from bd.settings`).map((r: any) => [r.k, Number(r.v)]));
    const keepa = async (asins: string[]) => {
      for (let a = 0; a < 4; a++) {
        const r = await fetch(`https://api.keepa.com/product?key=${KEY}&domain=1&stats=365&days=400&asin=${asins.join(",")}`);
        const j = await r.json().catch(() => ({}));
        if (r.status === 429 || (j.tokensLeft != null && j.tokensLeft < 0)) { await sleep(Math.min(60000, Number(j.refillIn) || 15000)); continue; }
        if (!r.ok) throw new Error(`Keepa ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
        return j;
      }
      throw new Error("Keepa is out of tokens right now - will try again next run");
    };
    // add a book by ISBN-10/13 or ASIN
    if (b.add) {
      const raw = String(b.add).trim().toUpperCase();
      let code = raw.replace(/[^0-9X]/g, "");
      if (/^B0[0-9A-Z]{8}$/.test(raw)) code = raw;
      else if (/^97[89]\d{10}$/.test(code)) { const s = code.slice(3, 12); let t = 0; for (let i = 0; i < 9; i++) t += (10 - i) * Number(s[i]); const c = (11 - (t % 11)) % 11; code = s + (c === 10 ? "X" : String(c)); }
      else if (!/^[0-9]{9}[0-9X]$/.test(code)) return json({ ok: false, error: "type an ISBN-10, ISBN-13 or ASIN" }, 400);
      const j = await keepa([code]); const p = (j.products || [])[0];
      if (!p || !p.title) return json({ ok: false, error: "Keepa doesn't know that book" }, 404);
      await sql`insert into bd.watch (asin, title, status) values (${code}, ${String(p.title).slice(0, 160)}, 'watching') on conflict (asin) do update set status = case when bd.watch.status = 'dropped' then 'watching' else bd.watch.status end`;
      b.asins = [code];
    }
    // v4: link Hold Shelf drafts to the books he bought (ISBN match)
    await sql`update bd.watch w set status = 'holding', pd = d.pd, draft_id = d.id
      from (select distinct on (bd.isbn10(ident->>'isbn')) id, pd, bd.isbn10(ident->>'isbn') i from pipeline.drafts
             where location = 'Hold Shelf' and status = 'sent' and built_at is null and pd is not null order by bd.isbn10(ident->>'isbn'), id desc) d
      where d.i = w.asin and w.status in ('watching','bought')`;
    const list = b.asins?.length ? await sql`select * from bd.watch where asin = any(${b.asins})` : await sql`select * from bd.watch where status in ('watching','bought','holding')`;
    const md = Number(new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }).slice(5).replace("-", ""));
    // list ahead of the buying seasons (FBA needs ~2 weeks to check in): Jun 1 - Aug 31 and Dec 1 - Jan 20
    const listSeason = (md >= 601 && md <= 831) || md >= 1201 || md <= 120;
    const listed: string[] = [], toList: string[] = [];
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const newBuys: string[] = [];
    let checked = 0, tokensLeft = null;
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const j = await keepa(chunk.map((w: any) => w.asin));
      tokensLeft = j.tokensLeft;
      const byAsin = new Map((j.products || []).map((p: any) => [p.asin, p]));
      for (const w of chunk as any[]) {
        const p: any = byAsin.get(w.asin); if (!p) continue;
        const st = p.stats || {}, cur = st.current || [], csvUsed = (p.csv || [])[2] || null;
        const used = c2d(cur[2]), nw = c2d(cur[1]), amz = c2d(cur[0]);
        // the best buying season where it really sold
        let seasonal: number | null = null, season = "", seasonSales = 0;
        for (const sz of seasons()) {
          const med = windowMedian(csvUsed, sz.from, sz.to), drops = rankDrops((p.csv || [])[3] || null, sz.from, sz.to);
          if (med && drops >= (S.min_season_sales ?? 3) && (!seasonal || med > seasonal)) { seasonal = med; season = sz.name; seasonSales = drops; }
        }
        const sell = w.sell_override != null ? Number(w.sell_override) : seasonal;
        const minP = w.min_profit != null ? Number(w.min_profit) : (S.min_profit ?? 15);
        let buy: number | null = null, net = 0;
        if (sell) {
          net = sell * (1 - (S.fee_pct ?? 0.15)) - (S.fee_flat ?? 1.8);
          const t = Math.min(net / (1 + (S.min_roi ?? 0.5)), net - minP);
          buy = t > 0 ? down99(t) : null;
        }
        if (w.buy_override != null) buy = Number(w.buy_override);
        const sales90 = Number(st.salesRankDrops90) || 0;
        const profit = used != null && sell ? r2(net - used) : null;
        const roi = profit != null && used ? r2(profit / used) : null;
        let bucket = "watching";
        if (w.status === "bought" || w.status === "holding") {
          const target = sell ? Math.max(sell, used ?? 0) : (used ?? 0);
          const time = listSeason || (sell != null && used != null && used >= sell);
          bucket = time ? "list now" : "holding";
          if (time && w.status === "holding" && w.draft_id && target > 0) {
            const price = Math.max(9.99, Math.floor(target) - 0.01);
            await sql`update pipeline.drafts set price_override = ${price}, answers = jsonb_set(coalesce(answers,'{}'), '{bd}', ${sql.json({ release: "yes", at: today, price })}) where id = ${w.draft_id}`;
            await sql`update bd.watch set status = 'listed', listed_at = now(), list_price = ${price} where asin = ${w.asin}`;
            listed.push(`${w.pd} ${w.title.slice(0, 50)} at $${price.toFixed(2)}`);
          } else if (time && w.status === "bought") toList.push(`${w.title.slice(0, 50)} - scan it in and pick Hold Shelf, I'll release it`);
        } else if (!sell) bucket = "no season sales";
        else if (used == null || !buy) bucket = used == null ? "no offers" : "can't make $" + minP;
        else if (used <= buy) bucket = "buy";
        else if (used <= buy * (1 + (S.close_pct ?? 0.2))) bucket = "close";
        const [prev] = await sql`select bucket, bucket_since from bd.check where asin = ${w.asin}`;
        const since = prev && prev.bucket === bucket ? prev.bucket_since : today;
        if (bucket === "buy" && (!prev || prev.bucket !== "buy") && w.amz_ok !== false) newBuys.push(`${w.title.slice(0, 60)} - used $${used!.toFixed(2)}, buy at $${buy!.toFixed(2)} or less, about $${profit!.toFixed(0)} profit`);
        const img = String(p.imagesCSV || "").split(",")[0];
        await sql`insert into bd.check (asin, title_keepa, used, new, amazon, used_avg90, used_avg365, used_low365, used_high365, sell_target, buy_target, profit, roi, bucket,
            rank, sales90, image, bucket_since, checked_at, season, season_sales)
          values (${w.asin}, ${String(p.title || "").slice(0, 200)}, ${used}, ${nw}, ${amz}, ${c2d((st.avg90 || [])[2])}, ${c2d((st.avg365 || [])[2])},
            ${c2d(((st.min || [])[2] || [])[1])}, ${c2d(((st.max || [])[2] || [])[1])}, ${sell ? r2(sell) : null}, ${buy}, ${profit}, ${roi}, ${bucket},
            ${Number(cur[3]) > 0 ? Number(cur[3]) : null}, ${sales90}, ${img ? "https://images-na.ssl-images-amazon.com/images/I/" + img : null}, ${since}, now(), ${season || null}, ${seasonSales})
          on conflict (asin) do update set title_keepa = excluded.title_keepa, used = excluded.used, new = excluded.new, amazon = excluded.amazon, used_avg90 = excluded.used_avg90,
            used_avg365 = excluded.used_avg365, used_low365 = excluded.used_low365, used_high365 = excluded.used_high365, sell_target = excluded.sell_target,
            buy_target = excluded.buy_target, profit = excluded.profit, roi = excluded.roi, bucket = excluded.bucket, rank = excluded.rank, sales90 = excluded.sales90,
            image = excluded.image, bucket_since = excluded.bucket_since, checked_at = now(), season = excluded.season, season_sales = excluded.season_sales`;
        await sql`insert into bd.history values (${w.asin}, ${today}, ${used}, ${bucket}) on conflict (asin, day) do update set used = excluded.used, bucket = excluded.bucket`;
        checked++;
      }
    }
    if (newBuys.length && !b.add) {
      await sql`select pipeline.alert_add('Bargain Duck', ${"🦆 " + newBuys.length + " book" + (newBuys.length === 1 ? "" : "s") + " in the buy zone"},
        ${newBuys.join(" · ") + ". See the Bargain Duck card."}, null, null, 'issue', ${"bd:" + today})`;
    }
    if (listed.length) await sql`select pipeline.alert_add('Bargain Duck', ${"🚀 " + listed.length + " Hold Shelf book" + (listed.length === 1 ? "" : "s") + " going out tonight"},
        ${listed.join(" · ") + ". They join the next blast off - pull them from the Hold Shelf."}, null, null, 'issue', ${"bdl:" + today})`;
    if (toList.length) await sql`select pipeline.alert_add('Bargain Duck', ${"📦 Time to sell " + toList.length + " book" + (toList.length === 1 ? "" : "s") + " you bought"},
        ${toList.join(" · ")}, null, null, 'question', ${"bdt:" + today})`;
    return json({ ok: true, checked, newBuys, listed, toList, tokensLeft });
  } catch (e) { return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500); }
  finally { await sql.end({ timeout: 3 }); }
});
