// Papa Duck — Edge Function "amazon-recheck" (2026-10-22). Asks Amazon "can I sell this book in this condition?" from the
// CLOUD, so the answer no longer waits for Dispatch on his PC. Papa Duck: "if I get amazon approval I can ask you to re look
// and add to amazon in one click inside the draft" + "many of them were approved".
// Picks open drafts with no Amazon answer (new books, or ones the Recheck button cleared), up to 8 per run, and writes
//   drafts.amazon = {status: ok | restricted | not_on_amazon | error, grade, cond, asin, reasons, checked, partial:true, source:"cloud"}
// partial:true tells Dispatch (pd_amazon_pending) to come back later and add the sales/fit details it always adds.
// Auth: x-backup-secret = cron_secret. Runs from pipeline.amazon_recheck() and from cron pd-amazon-recheck.
import postgres from "npm:postgres@3.4.4";
const MKT = "ATVPDKIKX0DER", HOST = "https://sellingpartnerapi-na.amazon.com";
const COND: Record<string, string> = { "Brand New": "new_new", "New": "new_new", "Like New": "used_like_new", "Very Good": "used_very_good",
  "Good": "used_good", "Acceptable": "used_acceptable" };
const wait = (ms: number) => new Promise((z) => setTimeout(z, ms));
const reply = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });

function isbnsIn(raw: string): string[] {
  const out: string[] = [];
  for (const m of String(raw || "").match(/[0-9][0-9\- ]{8,16}[0-9Xx]/g) || []) {
    const c = m.replace(/[^0-9Xx]/g, "").toUpperCase();
    if (c.length === 13 && /^\d{13}$/.test(c)) {
      const s = c.slice(0, 12).split("").reduce((t, x, i) => t + Number(x) * (i % 2 ? 3 : 1), 0);
      if ((10 - (s % 10)) % 10 === Number(c[12])) out.push(c);
    } else if (c.length === 10 && /^\d{9}[\dX]$/.test(c)) {
      const s = c.split("").reduce((t, x, i) => t + (10 - i) * (x === "X" ? 10 : Number(x)), 0);
      if (s % 11 === 0) out.push(c);
    }
  }
  return [...new Set(out)];
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now();
  try {
    const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== String(cs?.value || "")) return reply({ error: "not allowed" }, 403);
    const todo = await sql`select d.id, d.pd, d.ident->>'isbn' isbn, d.ident->>'title' title, d.ident->>'author' author, d.ident->>'grade' grade,
        (select l.before->>'asin' from pipeline.amazon_recheck_log l where l.pd = d.pd and l.before->>'asin' is not null order by l.id desc limit 1) known_asin
      from pipeline.drafts d
      where d.amazon is null and d.built_at is null and d.archived_at is null and d.status in ('drafted','sent')
        and coalesce(d.ident->>'title','') <> '' and d.pd is not null
      order by d.id desc limit 8`;
    if (!todo.length) return reply({ ok: true, idle: true });
    const r = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`;
    const a = r[0] ? JSON.parse(r[0].decrypted_secret).amazon : null;
    if (!a) return reply({ error: "no Amazon keys in the cloud" }, 500);
    const t = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: a.client_id, client_secret: a.client_secret }).toString() });
    const tok = (await t.json()).access_token;
    if (!tok) return reply({ error: "Amazon login failed" }, 500);
    const H = { "x-amz-access-token": tok, Accept: "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" };
    const done: unknown[] = [];
    for (const d of todo as any[]) {
      if (Date.now() - t0 > 120000) break;                       // the next run picks up the rest
      const grade = String(d.grade || "Good"), cond = COND[grade] || "used_good";
      const res: Record<string, unknown> = { grade, cond, checked: new Date().toISOString().slice(0, 16).replace("T", " "), partial: true, source: "cloud" };
      try {
        let asin = String(d.known_asin || "");
        if (!asin) {
          for (const code of isbnsIn(d.isbn)) {
            const typ = code.length === 13 ? "EAN" : "ISBN";
            const s = await fetch(`${HOST}/catalog/2022-04-01/items?marketplaceIds=${MKT}&identifiersType=${typ}&identifiers=${code}&includedData=summaries`, { headers: H });
            const sj = await s.json().catch(() => ({}));
            if ((sj.items || [])[0]) { asin = sj.items[0].asin; res.amazon_title = String(((sj.items[0].summaries || [])[0] || {}).itemName || "").slice(0, 140); break; }
            await wait(600);
          }
        }
        if (!asin) { res.status = "not_on_amazon"; res.note = "No Amazon page found by ISBN (the title search runs from Dispatch)"; }
        else {
          res.asin = asin;
          await wait(1100);
          const x = await fetch(`${HOST}/listings/2021-08-01/restrictions?asin=${asin}&sellerId=${a.seller_id}&marketplaceIds=${MKT}&conditionType=${cond}`, { headers: H });
          const xj = await x.json().catch(() => ({}));
          if (x.status >= 300) throw new Error(`restrictions answered ${x.status}`);
          const reasons: unknown[] = [];
          for (const q of xj.restrictions || []) for (const y of q.reasons || []) {
            const link = ((y.links || []).find((l: any) => l.resource) || {}).resource || "";
            reasons.push({ code: y.reasonCode || "", message: String(y.message || "").slice(0, 300), link });
          }
          res.status = reasons.length ? "restricted" : "ok";
          if (reasons.length) res.reasons = reasons;
        }
      } catch (e) { res.status = "error"; res.note = String((e as Error).message || e).slice(0, 200); }
      await sql`update pipeline.drafts set amazon = ${sql.json(res)}, amazon_at = now() where id = ${d.id} and amazon is null`;
      done.push({ pd: d.pd, status: res.status });
      await wait(700);
    }
    // more waiting? kick the next run now instead of waiting for the cron
    const [more] = await sql`select count(*)::int n from pipeline.drafts where amazon is null and built_at is null and archived_at is null
      and status in ('drafted','sent') and coalesce(ident->>'title','') <> '' and pd is not null`;
    if (more.n > 0 && done.length) await sql`select net.http_post(url:='https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/amazon-recheck',
      headers:=jsonb_build_object('Content-Type','application/json','x-backup-secret',${String(cs.value)}::text), body:='{}'::jsonb, timeout_milliseconds:=150000)`;
    return reply({ ok: true, done, more: more.n });
  } catch (e) {
    return reply({ error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
