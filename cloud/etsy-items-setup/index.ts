// Papa Duck — "etsy-items-setup" (2026-10-28). Read-only helper for Etsy on non-book items:
//   {action:"taxonomy"}  Etsy's seller taxonomy (API key only) -> pipeline.etsy_taxonomy (id, name, path, level)
//   {action:"profiles"}  the shop's shipping profiles (OAuth; token refresh saved the moment it rotates, lock 7342001 like send-worker)
// Auth: x-backup-secret = backup.config.cron_secret.
import postgres from "npm:postgres@3.4.4";
const ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", SHOP = "65331509";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  let locked = false;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (!cfg || req.headers.get("x-backup-secret") !== cfg.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    let K = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
    const key = `${ETSY_CLIENT}:${K.etsy.shared_secret}`;
    if (b.action === "taxonomy") {
      const r = await fetch("https://openapi.etsy.com/v3/application/seller-taxonomy/nodes", { headers: { "x-api-key": key } });
      const j = await r.json();
      if (!r.ok) return json({ ok: false, status: r.status, j }, 500);
      const rows: any[] = [];
      const walk = (n: any, path: string[]) => { const p = [...path, n.name]; rows.push({ id: n.id, name: n.name, path: p.join(" > "), level: n.level ?? p.length - 1, leaf: !(n.children || []).length }); for (const c of n.children || []) walk(c, p); };
      for (const n of j.results || []) walk(n, []);
      await sql`create table if not exists pipeline.etsy_taxonomy (id bigint primary key, name text, path text, level int, leaf boolean)`;
      await sql`delete from pipeline.etsy_taxonomy`;
      for (let i = 0; i < rows.length; i += 500) await sql`insert into pipeline.etsy_taxonomy ${sql(rows.slice(i, i + 500), "id", "name", "path", "level", "leaf")}`;
      return json({ ok: true, nodes: rows.length });
    }
    if (b.action === "profiles") {
      const [lk] = await sql`select pg_try_advisory_lock(7342001) as ok`;
      if (!lk.ok) return json({ ok: false, error: "Etsy token lock busy - try again in a minute" }, 409);
      locked = true;
      let tok = K.etsy.access_token;
      if (!tok || Number(K.etsy.expires_at || 0) < Date.now() + 10 * 60e3) {
        const r = await fetch("https://api.etsy.com/v3/public/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: ETSY_CLIENT, refresh_token: K.etsy.refresh_token }) });
        const j = await r.json();
        if (!j.access_token || !j.refresh_token) return json({ ok: false, error: "Etsy token refresh failed " + r.status }, 500);
        K.etsy = { ...K.etsy, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + Number(j.expires_in || 3600) * 1000 };
        const [s] = await sql`select id from vault.secrets where name = 'papaduck_keys'`;
        await sql`select vault.update_secret(${s.id}::uuid, ${JSON.stringify(K)})`;
        tok = j.access_token;
      }
      const H = { "x-api-key": key, Authorization: "Bearer " + tok };
      const r = await fetch(`https://openapi.etsy.com/v3/application/shops/${SHOP}/shipping-profiles`, { headers: H });
      const j = await r.json();
      if (b.create) {
        // Papa Duck 2026-10-28 OK'd: Ground Advantage profiles for non-book items, buyer pays, by packed weight
        const want = [["Ground Advantage 1 lb", 7.99, 1], ["Ground Advantage 2 lb", 9.99, 2], ["Ground Advantage 3 lb", 12.99, 3], ["Ground Advantage 5 lb", 17.99, 5], ["Ground Advantage Over 5 lb", 24.99, 99]] as const;
        const have = new Map((j.results || []).map((p: any) => [String(p.title), Number(p.shipping_profile_id)]));
        const out: any[] = [];
        for (const [title, cost, lb] of want) {
          if (have.has(title)) { out.push({ title, id: have.get(title), lb, existed: true }); continue; }
          const form = new URLSearchParams({ title, origin_country_iso: "US", origin_postal_code: "97080", destination_country_iso: "US",
            primary_cost: cost.toFixed(2), secondary_cost: "3.00", min_delivery_days: "2", max_delivery_days: "5",
            min_processing_time: "1", max_processing_time: "3", processing_time_unit: "business_days" });
          const c = await fetch(`https://openapi.etsy.com/v3/application/shops/${SHOP}/shipping-profiles`, { method: "POST", headers: { ...H, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
          const cj = await c.json();
          out.push({ title, lb, status: c.status, id: cj.shipping_profile_id || null, err: c.ok ? undefined : JSON.stringify(cj).slice(0, 300) });
        }
        const ok = out.filter((x) => x.id);
        if (ok.length === want.length) await sql`insert into backup.config (key, value) values ('etsy_item_ship_profiles', ${JSON.stringify(ok.map((x) => ({ lb: x.lb, id: String(x.id), title: x.title })))})
          on conflict (key) do update set value = excluded.value`;
        return json({ ok: ok.length === want.length, created: out });
      }
      return json({ ok: r.ok, profiles: (j.results || []).map((p: any) => ({ id: p.shipping_profile_id, title: p.title, type: p.shipping_profile_type, origin: p.origin_postal_code,
        min_days: p.min_processing_days, max_days: p.max_processing_days,
        dest: (p.shipping_profile_destinations || []).map((d: any) => ({ to: d.destination_country_iso || d.destination_region, mail_class: d.mail_class, primary: d.primary_cost?.amount, carrier: d.shipping_carrier_id })),
        upgrades: (p.shipping_profile_upgrades || []).map((u: any) => u.upgrade_name) })) });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 400) }, 500);
  } finally {
    if (locked) await sql`select pg_advisory_unlock(7342001)`.catch(() => {});
    await sql.end({ timeout: 3 });
  }
});
