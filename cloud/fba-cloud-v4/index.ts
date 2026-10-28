// Papa Duck — Edge Function "fba-cloud" (2026-10-07; v4 2026-10-28 weekly board books with no draft). Amazon FBA Stage 1: list the book FBA-only, get its FNSKU, queue the sticker.
// Routes (POST, JSON):
//   ?action=work         cron (pd-fba-tick, only when something waits) + the Drafts page FBA click. x-backup-secret = cron_secret
//   ?action=preview      {draft_id} Amazon checks the FBA offer without listing anything (mode=VALIDATION_PREVIEW). x-backup-secret
//   ?action=print-next   the PC helper asks for stickers to print (x-pd-token, same token as sales-cloud). Body {printer}
//   ?action=printed      {id, ok, error, printer} the helper reports back (x-pd-token)
//   ?action=holding      Dispatch "Ready to print" list (x-pd-token)
import postgres from "npm:postgres@3.4.4";
import { Amazon, AT, Ctx, Keys } from "./fba_core.ts";
import { work, putOffer, Item, Store, COND_LABEL } from "./fba.ts";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const action = new URL(req.url).searchParams.get("action") || "work";
  const cfg = async (k: string) => String((await sql`select value from backup.config where key = ${k}`)[0]?.value ?? "");
  const setCfg = (k: string, v: string) => sql`insert into backup.config (key, value) values (${k}, ${v}) on conflict (key) do update set value = excluded.value`;
  const keys = async (): Promise<Keys> => { const r = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`; return r[0] ? JSON.parse(r[0].decrypted_secret) : {}; };
  const cronOk = async () => req.headers.get("x-backup-secret") === await cfg("cron_secret");
  const pcOk = async () => { const h = await cfg("pc_token_hash"); return !!h && h === await sha(req.headers.get("x-pd-token") || ""); };
  const ctx: Ctx = { fetch: (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(60000) }) as any, now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const store: Store = {
    draft: async (id) => id ? (await sql`select id, pd, ident, answers, pricing, weight_lb, photos from pipeline.drafts where id = ${id}`)[0] as any || null : null,
    update: async (id, patch, log) => {
      const p: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
      await sql`update pipeline.fba_items set ${sql(p)} where id = ${id}`;
      if (log) await sql`update pipeline.fba_items set log = (select coalesce(jsonb_agg(x order by o), '[]'::jsonb) from (
          select x, o from jsonb_array_elements(log || ${sql.json([{ at: new Date().toISOString(), what: log }] as any)}::jsonb) with ordinality t(x, o)
          order by o desc limit 30) s) where id = ${id}`;   // keep the last 30 lines
    },
    draftBack: async (draftId) => { if (draftId) await sql`update pipeline.drafts set status = 'drafted', channel = 'both', sent_at = null, updated_at = now() where id = ${draftId} and status = 'fba'`; },
  };
  try {
    if (action === "work") {
      if (!(await cronOk())) return json({ error: "not allowed" }, 403);
      const [lk] = await sql`select pg_try_advisory_lock(7342002) as ok`;
      if (!lk.ok) return json({ ok: true, skipped: "already running" });
      try {
        const items = await sql`select * from pipeline.fba_items
          where (status in ('queued','listing','waiting_fnsku','removing') and next_try <= now()) or (status = 'ready' and airtable_dirty)
          order by created_at limit 12` as unknown as Item[];
        if (!items.length) return json({ ok: true, idle: true });
        const k = await keys();
        if (!k.amazon) return json({ ok: false, error: "Amazon keys are not in the cloud" }, 500);
        const amz = new Amazon(ctx, k.amazon);
        const at = k.airtable?.token ? new AT(ctx, k.airtable.token) : null;
        const out = await work(ctx, store, items, amz, k.amazon.seller_id, at);
        return json({ ok: true, done: out });
      } finally { await sql`select pg_advisory_unlock(7342002)`; }
    }
    if (action === "preview") {
      if (!(await cronOk())) return json({ error: "not allowed" }, 403);
      const b = await req.json();
      const [d] = await sql`select id, pd, ident, pricing, amazon, price_override from pipeline.drafts where id = ${Number(b.draft_id)}`;
      if (!d) return json({ error: "no such draft" }, 404);
      const k = await keys();
      const amz = new Amazon(ctx, k.amazon!);
      const g: Record<string, string> = { "Like New": "used_like_new", "Very Good": "used_very_good", Good: "used_good", Acceptable: "used_acceptable" };
      const it = { id: 0, draft_id: d.id, pd: b.pd || d.pd || "PD-TEST", box: 1, asin: d.amazon?.asin, cond: g[d.ident?.grade] || "used_good",
        price: Number(d.price_override || d.pricing?.list || 9.99), product_type: d.amazon?.product_type || null } as unknown as Item;
      const r = await putOffer(amz, k.amazon!.seller_id, it, String(d.pricing?.b1 || "Good used copy."), true);
      return json({ ok: r.ok, status: r.status, why: r.why, warnings: r.warnings, pt: r.pt, sent: { pd: it.pd, asin: it.asin, cond: it.cond, price: it.price } });
    }
    if (action === "print-next") {
      if (!(await pcOk())) return json({ error: "not allowed" }, 403);
      const b = await req.json().catch(() => ({}));
      await setCfg("fba_printer_seen", JSON.stringify({ at: new Date().toISOString(), printer: String(b.printer || ""), version: String(b.version || "") }));
      const jobs = await sql`select id, pd, fnsku, title, cond, box from pipeline.fba_items
        where status = 'ready' and fnsku is not null and print_requested_at is not null and (printed_at is null or printed_at < print_requested_at)
          and print_requested_at > now() - interval '2 days' order by print_requested_at, pd limit 5`;
      const [busy] = await sql`select exists (select 1 from pipeline.fba_items where status in ('queued','listing','waiting_fnsku')
        and updated_at > now() - interval '30 minutes') or exists (select 1 from pipeline.fba_items where status = 'ready' and print_requested_at > now() - interval '10 minutes') as b`;
      return json({ jobs: jobs.map((j: any) => ({ id: Number(j.id), pd: j.pd, fnsku: j.fnsku, title: j.title || "", cond: COND_LABEL[j.cond] || "Used", box: j.box })), busy: !!busy.b });
    }
    if (action === "holding") {
      // Dispatch "Ready to print": every FBA book with its sticker number that has never been printed, plus the ones still on their way
      if (!(await pcOk())) return json({ error: "not allowed" }, 403);
      const ready = await sql`select i.id, i.pd, i.fnsku, i.title, i.cond, i.box, i.price, i.asin, i.cover,
          (select coalesce(jsonb_agg(ph->>'url'), '[]'::jsonb) from pipeline.drafts d, jsonb_array_elements(d.photos) ph
            where d.id = i.draft_id and not coalesce((ph->>'removed')::boolean, false) and coalesce(ph->>'url', '') like 'https://%') as photos
        from pipeline.fba_items i where i.status = 'ready' and i.fnsku is not null and i.printed_at is null and not i.prep order by i.created_at`;
      const working = await sql`select id, pd, title, status, error from pipeline.fba_items where status in ('queued','listing','waiting_fnsku','error') and not prep order by created_at`;
      return json({ ready: ready.map((j: any) => ({ ...j, id: Number(j.id), price: Number(j.price), cond_label: COND_LABEL[j.cond] || "Used" })),
        working: working.map((j: any) => ({ ...j, id: Number(j.id) })) });
    }
    if (action === "printed") {
      if (!(await pcOk())) return json({ error: "not allowed" }, 403);
      const b = await req.json();
      if (b.ok) await sql`update pipeline.fba_items set printed_at = now(), prints = prints + 1, print_error = null, updated_at = now() where id = ${Number(b.id)}`;
      // a failed print stays on the Ready to print list (printed_at untouched); a failed reprint stops retrying
      else await sql`update pipeline.fba_items set print_error = ${String(b.error || "print failed").slice(0, 300)}, print_requested_at = null, updated_at = now() where id = ${Number(b.id)}`;
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.log("fba-cloud error", e);
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
