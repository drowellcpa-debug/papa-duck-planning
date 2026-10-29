// Papa Duck — "fba-inbound" (2026-10-28). Stage 2: tell Amazon a packed FBA box is coming (Fulfillment Inbound v2024-03-20).
// Papa Duck: "you have api, this should be done in our app" — no more Seller Central clicking for a box.
// Actions (POST JSON, x-backup-secret = cron_secret):
//   {action:"probe"}                       read-only check
//   {action:"call", method, path, params?, body?}   one SP-API call; if Amazon answers with an operationId we wait for it (up to ~100 s)
// Every call is logged to pipeline.fba_inbound_log so each box keeps a full record.
import postgres from "npm:postgres@3.4.4";
import { Amazon, Ctx } from "./fba_core.ts";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const OK_PATH = /^\/(inbound\/fba\/2024-03-20|fba\/inbound\/v0)\//;
Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const k = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
    const ctx: Ctx = { fetch: (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(60000) }) as any, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    const amz = new Amazon(ctx, k.amazon);
    await sql`create table if not exists pipeline.fba_inbound_log (id bigserial primary key, at timestamptz default now(), box int, method text, path text, body jsonb, status int, answer jsonb, op jsonb)`;
    if (b.action === "probe") {
      const plans = await amz.api("GET", "/inbound/fba/2024-03-20/inboundPlans", { pageSize: "5", status: "ACTIVE" });
      return json({ plans: { status: plans.status, body: plans.raw.slice(0, 1500) } });
    }
    if (b.action === "call") {
      const method = String(b.method || "GET").toUpperCase(), path = String(b.path || "");
      if (!OK_PATH.test(path)) return json({ error: "only FBA inbound paths" }, 400);
      const r = await amz.api(method, path, b.params || {}, b.body);
      let op: any = null;
      const opId = r.j?.operationId;
      if (opId) {
        for (let i = 0; i < 25; i++) {
          await ctx.sleep(i < 5 ? 2000 : 4000);
          const o = await amz.api("GET", `/inbound/fba/2024-03-20/operations/${opId}`, {});
          op = o.j;
          if (op?.operationStatus && op.operationStatus !== "IN_PROGRESS") break;
        }
      }
      await sql`insert into pipeline.fba_inbound_log (box, method, path, body, status, answer, op)
        values (${b.box ?? null}, ${method}, ${path}, ${b.body ? sql.json(b.body) : null}, ${r.status}, ${sql.json(r.j)}, ${op ? sql.json(op) : null})`;
      return json({ status: r.status, answer: r.j, op });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
