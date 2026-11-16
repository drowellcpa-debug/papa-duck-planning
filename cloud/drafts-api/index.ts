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
    else return json({ ok: false, error: "not an allowed Drafts request" }, 400);
    return json({ ok: true, rows: [...rows] });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
