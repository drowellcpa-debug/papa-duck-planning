// v8 (2026-11-22): + pipeline.qty_lookup / qty_add / qty_adds_recent for the ➕ Add copies card ("grab an old Pd# and add additional quanity").
// v7 (2026-11-19): + pipeline.hold_board / hold_mark / hold_check for the 🦆 Holding for the season card.
// v6 (2026-11-18): + pipeline.sold_today for the "Sold today" grid (replaces Check a find on the Launch Pad).
// v5 (2026-11-18): + combine_list / combine_send / combine_dismiss for the combined invoice card.
// v4 (2026-11-18): + pipeline.health_board / health_kick for the System Health card.
// v3 (2026-11-18): Launch Pad refresh query is cut off at 24 s on the database side (it kept running after the page gave up and piled up).
// v2 (2026-11-16, "ok ready for the next move"): also serves the Launch Pad web page (launchpad.html) - same rule: only function calls from an
//   allowlist with plain literal arguments (numbers, true/false/null, quoted text, ::jsonb, number arrays), plus the page's exact refresh query
//   and its two todo updates. Never free-form SQL.
// Papa Duck — Edge Function "drafts-api" v1 (2026-11-15). Drafts WITHOUT the claude.ai connector (Launch Pad todo 88).
// Papa Duck: "can we move this to the new way quickly?" after the connector dropped and Drafts lost its pictures.
// The Drafts page (Netlify drafts.html) calls this directly over HTTPS, the same way the Book Station calls station-api.
// Auth: header x-station-pass = pipeline.config.station_passcode or a sorter PIN (pipeline.config sorter_pins).
// SAFETY: it never runs free-form SQL. Each request must match one of the exact query shapes the Drafts page uses
//   (digits / true / false / null only in the arguments); ui_save's JSON is passed as a bound parameter.
//   POST {q: "<one of the shapes>"} -> {ok, rows}     POST {photo: "<blob key>"} -> {ok, mime, b64}
import postgres from "npm:postgres@3.4.4";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, x-station-pass" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const MAIN = "select pipeline.ui_list() as data, pipeline.fba_list() as fba, (select coalesce(jsonb_agg(a), '[]'::jsonb) from jsonb_array_elements(pipeline.alerts_open()) a where a->>'source' = 'Goodwill check') as gw, (select value from pipeline.config where key = 'gw_recheck_last') as gwlast";
const NOARG = /^select pipeline\.(ui_list|fba_list|bin_board|ui_reprice_missing|ui_blastoff|quick_price_verify|launch_create|fba_from_blastoff|fba_new_box)\(\) as (data|fba|b|r)$/;
const ONEID = /^select pipeline\.(fba_send|fba_reprint|fba_retry|fba_undo|amazon_recheck)\((\d{1,12}|null)\) as r$/;
const GW = /^select pipeline\.goodwill_pull\((\d{1,12}), (true|false)\) as r$/;
const BLOCKS = /^select pricing->>'b1' as b1, pricing->>'b2' as b2, photos from pipeline\.drafts where id = (\d{1,12})$/;
const SAVE = /^select pipeline\.ui_save\((\d{1,12}), \$(pd[a-z0-9]{1,12})\$([\s\S]*)\$\2\$::jsonb\) as r$/;

// ---- Launch Pad (v2) ----
const LP_FN = new Set(["audit.report_full","bd.add_book","bd.board","bd.bought","bd.drop_book","bd.recheck_amz","bd.snooze","bd.unsnooze",
  "pipeline.alert_done","pipeline.check_find","pipeline.dispatch_start","pipeline.fba_ship_choose","pipeline.fba_ship_label","pipeline.fba_ship_retry",
  "pipeline.fba_ship_start","pipeline.goodwill_pull","pipeline.launch_answer","pipeline.launch_autofix","pipeline.launch_check_start","pipeline.launch_create",
  "pipeline.launch_gaps","pipeline.launch_go","pipeline.launch_history","pipeline.launch_reconsider_answer","pipeline.launch_state","pipeline.launch_verify",
  "pipeline.mark_cancelled","pipeline.mark_shipped","pipeline.offer_answer","pipeline.todo_find","pipeline.todo_recount","pipeline.todos_open",
  "pipeline.unrestrict_applied","pipeline.unrestrict_recheck","pipeline.vinted_box","pipeline.vinted_lot_make","pipeline.vinted_lot_ready",
  "pipeline.vinted_lot_remove","pipeline.vinted_lot_save","pipeline.vinted_lot_write","pipeline.week_check","pipeline.week_keep","pipeline.week_print",
  "pipeline.week_print_draft","pipeline.bin_board","pipeline.health_board","pipeline.health_kick",
  "pipeline.combine_list","pipeline.combine_send","pipeline.combine_dismiss","pipeline.sold_today",
  "pipeline.hold_board","pipeline.hold_mark","pipeline.hold_check",
  "pipeline.qty_lookup","pipeline.qty_add","pipeline.qty_adds_recent"]);
const LIT = "(?:-?\\d+(?:\\.\\d+)?|null|true|false|'(?:[^']|'')*'(?:::jsonb)?|array\\[(?:\\d+(?:,\\d+)*)?\\]::bigint\\[\\])";
const LP_CALL = new RegExp("^select ((?:pipeline|bd|audit)\\.[a-z_]+)\\((" + LIT + "(?:, ?" + LIT + ")*)?\\)(?: as [a-z]+)?$", "s");
const norm = (x: string) => x.replace(/\s+/g, " ").trim();
const LP_MAIN = norm(`with nn as (select max(id) id from pipeline.launch_nights where status not like 'dry%')
      select pipeline.launch_state() as s, pipeline.dispatch_status(40) as j,
        (select result from pipeline.launch_verify v, nn where v.night_id = nn.id) as v,
        (select pipeline.launch_gaps(nn.id) from nn) as g,
        (select jsonb_agg(jsonb_build_object('ch', c.channel, 'pd', c.pd, 'st', c.state, 'd', c.detail, 'at', c.checked_at) order by c.pd) from pipeline.launch_live_check c, nn where c.night_id = nn.id) as lc,
        pipeline.week_board() as w, pipeline.to_ship() as ts, pipeline.alerts_open() as al, pipeline.sales_board() as sb, pipeline.fba_track_board() as ft, pipeline.fba_ship_state() as fs`);
const LP_TODO = /^update pipeline\.todos set answer = (\d{1,6}), answered_at = now\(\), done_at = case when \1 = 0 then now\(\) else null end where id = (\d{1,9}) and kind = 'claude'; select pipeline\.todos_open\(\) as t$/;
const LP_CHECK = /^update pipeline\.todos set answer = 1, answered_at = now\(\), done_at = now\(\), applied = 'done' where id = (\d{1,9}) and kind = 'check'; select pipeline\.todos_open\(\) as t$/;
const LP_RECON = /^update pipeline\.launch_reconsider set answer = null, answered_at = null where id = (\d{1,9}) and night_id = (\d{1,9}) returning id$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const pass = String(req.headers.get("x-station-pass") || "");
    const [cfg] = await sql`select value from pipeline.config where key = 'station_passcode'`;
    const [pc] = await sql`select value from pipeline.config where key = 'sorter_pins'`;
    let pins: Record<string, string> = {}; try { pins = JSON.parse(String(pc?.value || "{}")); } catch (_) { pins = {}; }
    if (!cfg || !pass || (pass !== cfg.value && !pins[pass])) return json({ ok: false, error: "bad_passcode" }, 403);
    let b: any; try { b = await req.json(); } catch (_) { return json({ ok: false, error: "bad request" }, 400); }

    if (b.photo) {
      const key = String(b.photo).replace(/[^A-Za-z0-9_.-]/g, "");
      const [row] = await sql`select mime, b64 from pipeline.photo_blobs where key = ${key}`;
      if (!row) return json({ ok: false, error: "no image data" }, 404);
      return json({ ok: true, mime: row.mime || "image/jpeg", b64: row.b64 });
    }

    const q = String(b.q || "").trim();
    let rows: any;
    let m: RegExpMatchArray | null;
    if (q === MAIN || NOARG.test(q)) rows = await sql.unsafe(q);
    else if ((m = q.match(ONEID))) rows = await sql.unsafe(`select pipeline.${m[1]}(${m[2] === "null" ? "null" : Number(m[2])}) as r`);
    else if ((m = q.match(GW))) rows = await sql`select pipeline.goodwill_pull(${Number(m[1])}::bigint, ${m[2] === "true"}::boolean) as r`;
    else if ((m = q.match(BLOCKS))) rows = await sql`select pricing->>'b1' as b1, pricing->>'b2' as b2, photos from pipeline.drafts where id = ${Number(m[1])}`;
    else if ((m = q.match(SAVE))) {
      let patch: any; try { patch = JSON.parse(m[3]); } catch (_) { return json({ ok: false, error: "bad save data" }, 400); }
      rows = await sql`select pipeline.ui_save(${Number(m[1])}::bigint, ${sql.json(patch)}::jsonb) as r`;
    }
    // v3 (2026-11-18): the page gives up after 25 s - stop the database work too, so slow loads can never pile up (froze the database 11/18 5:41 AM)
    else if (norm(q) === LP_MAIN) { await sql`set statement_timeout = '24s'`; rows = await sql.unsafe(LP_MAIN); }
    else if ((m = q.match(LP_CALL)) && LP_FN.has(m[1])) rows = await sql.unsafe(q);
    else if ((m = q.match(LP_TODO))) {
      await sql`update pipeline.todos set answer = ${Number(m[1])}, answered_at = now(), done_at = case when ${Number(m[1])} = 0 then now() else null end where id = ${Number(m[2])} and kind = 'claude'`;
      rows = await sql`select pipeline.todos_open() as t`;
    }
    else if ((m = q.match(LP_CHECK))) {
      await sql`update pipeline.todos set answer = 1, answered_at = now(), done_at = now(), applied = 'done' where id = ${Number(m[1])} and kind = 'check'`;
      rows = await sql`select pipeline.todos_open() as t`;
    }
    else if ((m = q.match(LP_RECON))) rows = await sql`update pipeline.launch_reconsider set answer = null, answered_at = null where id = ${Number(m[1])} and night_id = ${Number(m[2])} returning id`;
    else return json({ ok: false, error: "not an allowed request" }, 400);
    return json({ ok: true, rows: [...rows] });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
