// v3 (2026-11-08): when used is still restricted, also checks NEW - a card says "approved for NEW only" (Concordia, PD-2991).
// v2 (2026-11-08): Papa Duck "if it gets denied later add it back to the ask for approval so I keep up with it" - approved books are rechecked
//   once a day too; if Amazon restricts one again it goes back on the 🔓 list, the draft goes back to restricted, and a ⚠️ note says so.
// Papa Duck - Edge Function "amz-unrestrict" v1 (2026-11-08). Papa Duck: "add another one in the inbox called ask for unrestricted where you list
// the restricted publisher and take me to the link to get it unrestricted and then auto check for me and clear and fix the draft so it knows it is
// unrestricted". Every 3 hours (cron pd-amz-unrestrict) and right after he taps a card: asks Amazon again (listings restrictions API) for every book
// in pipeline.unrestrict that is still restricted. When Amazon says OK:
//   - pipeline.unrestrict.ok = true (approved_at), audit.amz_recheck.ok = true
//   - the draft's Amazon answer becomes status "ok" (so the Drafts page and the blast off know it can go on Amazon)
//   - the publisher's 🔓 card on the Launch Pad is filed away (pipeline.unrestrict_cards) and a ✅ note says which books opened up.
// It never lists anything on Amazon by itself - adding an approved book to Amazon still waits for Papa Duck's yes.
// POST {} (cron) or {"pd":"PD-3030"} for one book. Auth: x-backup-secret = backup.config cron_secret.
import postgres from "npm:postgres@3.4.4";
const MKT = "ATVPDKIKX0DER", HOST = "https://sellingpartnerapi-na.amazon.com";
const wait = (ms: number) => new Promise((z) => setTimeout(z, ms));
const reply = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const t0 = Date.now();
  try {
    const [cs] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== String(cs?.value || "")) return reply({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const todo = b.pd
      ? await sql`select * from pipeline.unrestrict where pd = ${String(b.pd).toUpperCase()}`
      : await sql`select * from pipeline.unrestrict where asin is not null and (not ok or checked_at is null or checked_at < now() - interval '1 day')
          order by ok, checked_at nulls first limit 60`;
    if (!todo.length) return reply({ ok: true, idle: true });
    const a = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).amazon;
    const t = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: a.client_id, client_secret: a.client_secret }).toString() });
    const tok = (await t.json()).access_token;
    if (!tok) return reply({ error: "Amazon login failed" }, 500);
    const H = { "x-amz-access-token": tok, Accept: "application/json", "User-Agent": "PapaDuckCloud/1 (Language=TypeScript)" };
    const opened: string[] = [], still: string[] = [], errs: string[] = [], lost: string[] = [];
    for (const u of todo as any[]) {
      if (Date.now() - t0 > 120000) break;                  // the next run picks up the rest
      try {
        let x: Response | null = null;
        for (let k = 0; k < 4; k++) {
          x = await fetch(`${HOST}/listings/2021-08-01/restrictions?asin=${u.asin}&sellerId=${a.seller_id}&marketplaceIds=${MKT}&conditionType=${u.cond || "used_good"}`, { headers: H });
          if (x.status !== 429) break;
          await wait(2500);
        }
        const xj = await x!.json().catch(() => ({}));
        if (x!.status >= 300) throw new Error(`restrictions answered ${x!.status}`);
        const reasons: any[] = [];
        for (const q of xj.restrictions || []) for (const y of q.reasons || []) {
          const link = ((y.links || []).find((l: any) => l.resource) || {}).resource || "";
          reasons.push({ code: y.reasonCode || "", message: String(y.message || "").slice(0, 300), link });
        }
        if (!reasons.length && u.ok) { await sql`update pipeline.unrestrict set checked_at = now() where pd = ${u.pd}`; still.push(u.pd); }
        else if (!reasons.length) {
          await sql`update pipeline.unrestrict set ok = true, approved_at = now(), checked_at = now() where pd = ${u.pd}`;
          await sql`update audit.amz_recheck set ok = true, reasons = '[]'::jsonb, checked_at = now() where pd = ${u.pd}`;
          await sql`update pipeline.drafts set amazon = coalesce(amazon, '{}'::jsonb) || jsonb_build_object('status', 'ok', 'reasons', '[]'::jsonb,
              'checked', to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI'), 'unrestricted_at', now()), amazon_at = now()
            where pd = ${u.pd} and amazon->>'status' = 'restricted'`;
          opened.push(u.pd + " " + String(u.title || "").slice(0, 40));
        } else {
          await sql`update pipeline.unrestrict set ok = false, approved_at = null, checked_at = now(), link = coalesce(${reasons.find((r) => r.link)?.link || null}, link) where pd = ${u.pd}`;
          // v3: still no for his (used) condition - is it at least open for NEW? (brand approvals often come through for new only)
          if ((u.cond || "used_good") !== "new_new") {
            await wait(1100);
            const n = await fetch(`${HOST}/listings/2021-08-01/restrictions?asin=${u.asin}&sellerId=${a.seller_id}&marketplaceIds=${MKT}&conditionType=new_new`, { headers: H });
            const nj = await n.json().catch(() => ({}));
            if (n.status < 300) await sql`update pipeline.unrestrict set new_ok = ${!(nj.restrictions || []).some((q: any) => (q.reasons || []).length)} where pd = ${u.pd}`;
          }
          if (u.ok) {            // it was approved before - Amazon took it back
            await sql`update audit.amz_recheck set ok = false, reasons = ${sql.json(reasons)}, checked_at = now() where pd = ${u.pd}`;
            await sql`update pipeline.drafts set amazon = coalesce(amazon, '{}'::jsonb) || jsonb_build_object('status', 'restricted', 'reasons', ${sql.json(reasons)}::jsonb,
                'checked', to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')), amazon_at = now() where pd = ${u.pd} and amazon->>'status' = 'ok'`;
            lost.push(u.pd + " " + String(u.title || "").slice(0, 40));
          }
          still.push(u.pd);
        }
      } catch (e) { errs.push(u.pd + ": " + String((e as Error).message || e).slice(0, 80)); await sql`update pipeline.unrestrict set checked_at = now() where pd = ${u.pd}`; }
      await wait(1100);
    }
    await sql`select pipeline.unrestrict_cards()`;
    if (opened.length) await sql`select pipeline.alert_add('Unrestrict', ${"✅ Amazon approved " + opened.length + " book" + (opened.length === 1 ? "" : "s")},
      ${"These are no longer restricted and the drafts know it. Adding them to Amazon still waits for your yes.\n\n" + opened.join("\n")}, null, null, 'handled',
      ${"unrestrict-ok:" + new Date().toISOString().slice(0, 13)})`;
    if (lost.length) await sql`select pipeline.alert_add('Unrestrict', ${"⚠️ Amazon restricted " + lost.length + " book" + (lost.length === 1 ? "" : "s") + " again"},
      ${"These were approved before. They are back on your 🔓 Ask for unrestricted list.\n\n" + lost.join("\n")}, null, null, 'fyi',
      ${"unrestrict-lost:" + new Date().toISOString().slice(0, 13)})`;
    return reply({ ok: true, checked: opened.length + still.length + errs.length, opened, still: still.length, lost, errs });
  } catch (e) {
    return reply({ error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
