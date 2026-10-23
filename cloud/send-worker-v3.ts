// Papa Duck - Edge Function "send-worker" v3 (2026-10-22: photo fetch retries when the photo server says "too busy" (429) -
//   Papa Duck: "anything to fix on the photo server" / "can you fix the photo thing now". v2 2026-10-16: + eBay and Amazon).
// Papa Duck: "ok fix etsy as well" / "abe books will be from the cloud as well?" / "yes build please".
// Sends a queued night's Etsy books and AbeBooks file FROM THE CLOUD - photos go straight from Supabase to Etsy/AbeBooks,
// nothing passes through the home PC. Queue: pipeline.send_jobs / pipeline.send_items (one row per PD, per-photo state
// in items.photos: gray -> yellow -> green, red = failed). The web Dispatch page reads those rows for its progress bars.
//   POST ?action=work&channel=etsy            Etsy: up to 3 books at a time, token refreshed on expiry or 401, tags set at
//                                             creation, SKU, live, read back, Airtable ListingID written.
//   POST ?action=work&channel=abe&part=0..2   AbeBooks: part 0 sends the data file first; then every part takes whole
//                                             books, one FTPS session each, <=70 photos per session (Rule BH ceiling).
//   POST ?action=work&channel=ebay            eBay: AddFixedPriceItem from the rows JSON (policies by ID, UUID = no double
//                                             listing), GetItem read-back, Airtable ItemID/Listed/date (+ new prices), mark_built.
//                                             Test jobs use VerifyAddFixedPriceItem - nothing lists.
//   POST ?action=work&channel=amazon          Amazon: LISTING_OFFER_ONLY per book; run_mode 'preview' = VALIDATION_PREVIEW.
// Each run works ~110 s, then hands off to a fresh run of itself (the chain), so a big night never hits a time limit.
// Auth: x-backup-secret = backup.config cron_secret (same as the other pipeline functions).
import postgres from "npm:postgres@3.4.4";
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;
import { FTPS } from "./ftps.ts";
import { XMLParser } from "npm:fast-xml-parser@4";
const xmlp = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });
const arr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v)).trim();
const xesc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SB = Deno.env.get("SUPABASE_URL")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ETSY_CLIENT = "n9os0m3u7hm64f7cdqzb2fgu", SHOP = "65331509", READY = 1502395825992, RETURN_POLICY = 1503578809801;
const BASE = "appdMXzb9U4sdXpAr", T_INV = "tblKxgB4q7v9SPqze", F_TRACK = "fldxiwKYi6z1t0iDx";
const F_ITEMID = "fldKGZyyXy0Gjox5b", F_STATUS = "fldK5pTHj5iCEmf0w", F_LISTED = "fldkjGa3cDhKgaN3N", F_LIST = "fldqfykAq3wumx32C", F_AUTO = "fldSpnDZLINeJyA0c", F_MIN = "fldvRL78ZiKrr3Vrh";
const F_ETSY_ID = "fld3GGIsBv0tXqjFL", F_ETSY_DATE = "fldTwkJvnhIsmWJbE", F_ETSY_PROF = "fldDiRDilHHcBiKSV";
const BUDGET = 110_000, ABE_SESSION_MAX = 70, ETSY_CONC = 3;

// v3: fetch a stored photo, waiting and retrying when Supabase answers 429 (too busy), 5xx or a dropped connection.
async function getPhoto(u: string, ms = 60000): Promise<{ ok: boolean; status: number; bytes: Uint8Array; ctype: string }> {
  let last = { ok: false, status: 0, bytes: new Uint8Array(), ctype: "" };
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(ms) });
      const bytes = new Uint8Array(await r.arrayBuffer());
      last = { ok: r.ok, status: r.status, bytes, ctype: r.headers.get("content-type") || "" };
      if (r.ok || (r.status !== 429 && r.status < 500)) return last;
    } catch (_) { last = { ok: false, status: 0, bytes: new Uint8Array(), ctype: "" }; }
    await sleep(2000 * (a + 1) + Math.floor(Math.random() * 1000));   // 2 s, 4 s, 6 s ... with a little jitter
  }
  return last;
}

function today() { return new Date(Date.now() - 7 * 3600e3).toISOString().slice(0, 10); }   // Pacific date

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 4, prepare: false });
  const t0 = Date.now(); const url = new URL(req.url);
  const action = url.searchParams.get("action") || "work", channel = url.searchParams.get("channel") || "", part = Number(url.searchParams.get("part") || 0);
  let lockHeld = false; const log: string[] = [];
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    const secret = cfg?.value;
    if (req.headers.get("x-backup-secret") !== secret) return json({ error: "not allowed" }, 403);
    const kick = (ch: string, p = 0) => fetch(`${SB}/functions/v1/send-worker?action=work&channel=${ch}&part=${p}`,
      { method: "POST", headers: { "x-backup-secret": secret, "Content-Type": "application/json" }, body: "{}" }).catch(() => {});

    if (action === "kick") {          // start workers for whatever is queued (called by the page via SQL, and by cron)
      const q: any[] = await sql`select distinct j.channel from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id
                                 where i.state in ('queued','working') or (j.channel='abe' and j.status='running' and j.data_state in ('waiting','sending'))`;
      const ps: Promise<unknown>[] = [];
      for (const r of q) { if (r.channel === "abe") { for (let p = 0; p < 3; p++) ps.push(kick("abe", p)); } else ps.push(kick(r.channel)); }
      EdgeRuntime.waitUntil(Promise.all(ps));
      return json({ ok: true, kicked: q.map((r) => r.channel) });
    }

    const keys = async () => JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
    let K = await keys();

    // ---------- finish a job once nothing is left to do ----------
    const finishJobs = async () => {
      const js: any[] = await sql`select j.id, j.channel, j.data_state, j.run_mode from pipeline.send_jobs j where j.status = 'running'
        and not exists (select 1 from pipeline.send_items i where i.job_id = j.id and i.state in ('queued','working'))`;
      for (const j of js) {
        const it: any[] = await sql`select pd, state, note from pipeline.send_items where job_id = ${j.id} order by seq`;
        const sent = it.filter((x) => x.state === "done"), waiting = it.filter((x) => x.state === "waiting");
        const bad = it.filter((x) => !["done", "waiting"].includes(x.state));
        const dataBad = j.channel === "abe" && j.data_state !== "sent";
        if (j.run_mode === "preview") {        // Amazon Preview: nothing listed; items go back to waiting
          const okAll = !bad.length;
          await sql`update pipeline.send_items set state = 'waiting', updated_at = now() where job_id = ${j.id} and state = 'done'`;
          await sql`update pipeline.send_jobs set status = 'ready', run_mode = 'live', summary = ${okAll ? "PREVIEW CLEAN - Amazon accepted every book. Nothing is listed yet." : "PREVIEW - problems on: " + bad.map((x) => x.pd + " (" + (x.note || "") + ")").join(", ")}, updated_at = now() where id = ${j.id}`;
          continue;
        }
        const st = bad.length || dataBad ? "not_closed" : (waiting.length ? "ready" : "closed");
        const summary = (st === "closed" ? "CLOSED - " : st === "ready" ? "PART SENT - " : "NOT CLOSED - ") + `${sent.length} sent` + (waiting.length ? `, ${waiting.length} not sent yet` : "") +
          (bad.length ? `; check: ${bad.map((x) => x.pd + (x.note ? " (" + x.note + ")" : "")).join(", ")}` : "") + (dataBad ? "; data file NOT sent" : "");
        await sql`update pipeline.send_jobs set status = ${st}, summary = ${summary}, finished_at = now(), updated_at = now() where id = ${j.id} and status = 'running'`;
      }
    };

    // =====================================================================================  ETSY
    if (channel === "etsy") {
      const [lk] = await sql`select pg_try_advisory_lock(7342001) as ok`;          // shared with sales-cloud + etsy-tags (rotating token)
      if (!lk.ok) { await sleep(8000); EdgeRuntime.waitUntil(kick("etsy")); return json({ ok: true, waiting: "Etsy token lock busy - retrying" }); }
      lockHeld = true;
      let tok = "";
      const refresh = async (force = false) => {
        K = await keys(); const e = K.etsy;
        if (!force && e.access_token && Number(e.expires_at || 0) > Date.now() + 10 * 60e3) { tok = e.access_token; return; }
        const r = await fetch("https://api.etsy.com/v3/public/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: ETSY_CLIENT, refresh_token: e.refresh_token }), signal: AbortSignal.timeout(30000) });
        const j = await r.json();
        if (!j.access_token || !j.refresh_token) throw new Error("Etsy token refresh failed " + r.status + " " + JSON.stringify(j).slice(0, 160));
        K.etsy = { ...K.etsy, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + Number(j.expires_in || 3600) * 1000 };
        const [s] = await sql`select id from vault.secrets where name = 'papaduck_keys'`;
        await sql`select vault.update_secret(${s.id}::uuid, ${JSON.stringify(K)})`;   // saved the moment it rotates
        tok = j.access_token;
      };
      await refresh();
      let refreshing: Promise<void> | null = null;
      const etsy = async (method: string, path: string, opt: { form?: Record<string, unknown>; js?: unknown; body?: BodyInit; ctype?: string } = {}): Promise<any> => {
        for (let a = 0; a < 5; a++) {
          const h: Record<string, string> = { "x-api-key": `${ETSY_CLIENT}:${K.etsy.shared_secret}`, Authorization: "Bearer " + tok, Accept: "application/json" };
          let body: BodyInit | undefined;
          if (opt.form) { h["Content-Type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(Object.entries(opt.form).map(([k, v]) => [k, String(v)])).toString(); }
          else if (opt.js !== undefined) { h["Content-Type"] = "application/json"; body = JSON.stringify(opt.js); }
          else if (opt.body) { body = opt.body; }
          const r = await fetch("https://openapi.etsy.com/v3/application" + path, { method, headers: h, body, signal: AbortSignal.timeout(90000) });
          const t = await r.text();
          if (r.status === 401 && a < 2) { refreshing ??= refresh(true).finally(() => { refreshing = null; }); await refreshing; continue; }   // token expired mid-run
          if ((r.status === 429 || r.status >= 500) && a < 4) { await sleep(2500 * (a + 1)); continue; }
          if (r.status >= 300) throw new Error(`Etsy ${method} ${path.split("?")[0]} -> ${r.status} ${t.slice(0, 220)}`);
          return t.trim() ? JSON.parse(t) : {};
        }
      };
      // shop sections: title -> id (created if missing)
      const secKey = (t: string) => String(t || "").replace(/&#39;|’/g, "'").replace(/&amp;/g, "&").toLowerCase().replace(/[^a-z0-9&' ]/g, " ").split(/\s+/).filter(Boolean).join(" ");
      const secs: Record<string, number> = {};
      try { for (const s of (await etsy("GET", `/shops/${SHOP}/sections`)).results || []) secs[secKey(s.title)] = Number(s.shop_section_id); } catch (_) { /* listed without section */ }
      const secId = async (name: string) => {
        const k = secKey(name); if (!k) return 0; if (secs[k]) return secs[k];
        try { const d = await etsy("POST", `/shops/${SHOP}/sections`, { form: { title: String(name).slice(0, 24) } }); secs[k] = Number(d.shop_section_id); return secs[k]; } catch { return 0; }
      };
      const atFind = async (pd: string) => {
        const r = await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}?` + new URLSearchParams([["filterByFormula", `{Tracking Number}='${pd}'`], ["returnFieldsByFieldId", "true"], ["fields[]", F_TRACK]]),
          { headers: { Authorization: "Bearer " + K.airtable.token }, signal: AbortSignal.timeout(30000) });
        return ((await r.json()).records || [])[0]?.id as string | undefined;
      };

      const doBook = async (it: any, test: boolean) => {
        const b = it.payload; const pd = it.pd; const imgs: string[] = (b.image_urls || []).slice(0, 20);
        const photos: string[] = (it.photos?.length === imgs.length ? it.photos : imgs.map(() => "gray"));
        const names = imgs.map((_, i) => `${pd}_${i + 1}.jpg`);
        const save = (extra: { note?: string } = {}) => extra.note !== undefined
          ? sql`update pipeline.send_items set photos = ${sql.json(photos)}, names = ${sql.json(names)}, note = ${extra.note}, updated_at = now() where id = ${it.id}`
          : sql`update pipeline.send_items set photos = ${sql.json(photos)}, names = ${sql.json(names)}, updated_at = now() where id = ${it.id}`;
        let lid: string = it.listing_id || "";
        // tags: queued by Claude at blast off (Rule CA) - set right at creation
        const [tg] = await sql`select tags from pipeline.etsy_tags where pd = ${pd}`;
        const tags: string[] = Array.isArray(tg?.tags) ? tg.tags : [];
        if (!lid) {
          await save({ note: "creating the listing" });
          const sid = b.section ? await secId(b.section) : 0;
          const form: Record<string, unknown> = { quantity: Number(b.quantity), title: b.title, description: b.description, price: Number(b.price).toFixed(2),
            who_made: "someone_else", when_made: b.when_made, taxonomy_id: Number(b.taxonomy_id), shipping_profile_id: Number(b.shipping_profile_id),
            readiness_state_id: READY, return_policy_id: RETURN_POLICY, type: "physical", is_supply: "false" };
          if (sid) form.shop_section_id = sid;
          if (tags.length) form.tags = tags.join(",");
          const d = await etsy("POST", `/shops/${SHOP}/listings`, { form });
          lid = String(d.listing_id || ""); if (!lid) throw new Error("Etsy returned no listing_id");
          await sql`update pipeline.send_items set listing_id = ${lid}, updated_at = now() where id = ${it.id}`;
        } else {
          // resuming: photos already on the draft count as sent (never upload twice)
          const have = ((await etsy("GET", `/listings/${lid}/images`)).results || []).length;
          for (let i = 0; i < photos.length; i++) photos[i] = i < have ? "green" : "gray";
        }
        for (let i = 0; i < imgs.length; i++) {
          if (photos[i] === "green") continue;
          if (Date.now() - t0 > BUDGET) { await save({ note: `photo ${i + 1} of ${imgs.length} next` }); return "paused"; }
          photos[i] = "yellow"; await save({ note: `photo ${i + 1} of ${imgs.length}` });
          const pr = await getPhoto(imgs[i]);
          const bytes = pr.bytes;
          if (!pr.ok || bytes.length < 4000) { photos[i] = "red"; await save(); throw new Error(`photo ${i + 1} not reachable (${pr.status})`); }
          const fd = new FormData(); fd.append("rank", String(i + 1)); fd.append("image", new Blob([bytes], { type: "image/jpeg" }), `${pd}_${i + 1}.jpg`);
          await etsy("POST", `/shops/${SHOP}/listings/${lid}/images`, { body: fd });
          photos[i] = "green"; await save();
        }
        if (test) {                      // TEST: everything but going live, then the draft is deleted
          const back = await etsy("GET", `/listings/${lid}?includes=Images`);
          await etsy("DELETE", `/listings/${lid}`);
          return `TEST OK - draft ${lid} built with ${(back.images || []).length}/${imgs.length} photos, ${(back.tags || []).length} tags, section ${back.shop_section_id || "-"}; draft deleted, nothing went live`;
        }
        await save({ note: "going live" });
        // SKU (inventory read-modify-write; readiness_state_id required on every offering)
        let skuOk = true;
        try {
          const inv = await etsy("GET", `/listings/${lid}/inventory`);
          const products = (inv.products || []).map((p: any) => ({ sku: pd, property_values: [], offerings: (p.offerings || []).map((o: any) => ({
            price: Math.round(Number(o.price?.amount || 0) / Number(o.price?.divisor || 100) * 100) / 100, quantity: Number(o.quantity || 1),
            is_enabled: o.is_enabled !== false, readiness_state_id: Number(o.readiness_state_id || READY) })) }));
          await etsy("PUT", `/listings/${lid}/inventory`, { js: { products } });
        } catch (_) { skuOk = false; }
        await etsy("PATCH", `/shops/${SHOP}/listings/${lid}`, { form: { state: "active" } });
        const back = await etsy("GET", `/listings/${lid}?includes=Images`);
        const nImg = (back.images || []).length, live = back.state === "active" && nImg === imgs.length;
        const gotTags = new Set((back.tags || []).map((t: string) => t.toLowerCase()));
        const tagsOk = tags.length > 0 && tags.every((t) => gotTags.has(t.toLowerCase()));
        if (tagsOk) await sql`update pipeline.etsy_tags set status = 'done', listing_id = ${lid}, note = 'set at creation', updated_at = now() where pd = ${pd}`;
        let at = "Airtable updated";
        try {
          const rec = await atFind(pd);
          if (!rec) at = "no Airtable record";
          else {
            const r = await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}`, { method: "PATCH", headers: { Authorization: "Bearer " + K.airtable.token, "Content-Type": "application/json" },
              body: JSON.stringify({ typecast: true, records: [{ id: rec, fields: { [F_ETSY_ID]: lid, [F_ETSY_DATE]: today(), [F_ETSY_PROF]: String(b.shipping_profile_id) } }] }), signal: AbortSignal.timeout(30000) });
            if (!r.ok) at = "Airtable write failed " + r.status;
          }
        } catch (e) { at = "Airtable write failed " + String(e).slice(0, 80); }
        if (!live) throw new Error(`CHECK - state ${back.state}, photos ${nImg}/${imgs.length} (Etsy ${lid})`);
        return `LIVE Etsy ${lid} photos ${nImg}/${imgs.length} ${skuOk ? "SKU set" : "no SKU"} ${tagsOk ? "13 tags" : "tags queued"} ${at}`;
      };

      // pool: claim up to ETSY_CONC books at a time, in order
      let active = 0; const running: Promise<void>[] = [];
      const claim = async () => (await sql`update pipeline.send_items i set state = 'working', claimed_at = now(), updated_at = now()
          from pipeline.send_jobs j where j.id = i.job_id and i.id = (select i2.id from pipeline.send_items i2 join pipeline.send_jobs j2 on j2.id = i2.job_id
            where j2.channel = 'etsy' and (i2.state = 'queued' or (i2.state = 'working' and i2.claimed_at < now() - interval '4 minutes'))
            order by i2.job_id, i2.seq limit 1 for update of i2 skip locked)
          returning i.*, j.test`)[0];
      const worker = async () => {
        while (Date.now() - t0 < BUDGET) {
          const it = await claim(); if (!it) return;
          try {
            const res = await doBook(it, it.test);
            if (res === "paused") { await sql`update pipeline.send_items set state = 'queued', updated_at = now() where id = ${it.id}`; return; }
            await sql`update pipeline.send_items set state = 'done', note = ${res}, updated_at = now() where id = ${it.id}`; log.push(it.pd + " " + res);
          } catch (e) {
            const m = String((e as Error).message || e).slice(0, 300);
            await sql`update pipeline.send_items set state = 'failed', note = ${m}, updated_at = now() where id = ${it.id}`; log.push(it.pd + " FAILED " + m);
          }
        }
      };
      for (let w = 0; w < ETSY_CONC; w++) { running.push(worker()); await sleep(400); active++; }
      await Promise.all(running);
      await finishJobs();
      const [more] = await sql`select count(*)::int n from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id where j.channel = 'etsy' and i.state in ('queued','working')`;
      if (more.n) EdgeRuntime.waitUntil(kick("etsy"));               // the chain: a fresh run picks up the rest
      return json({ ok: true, channel, ms: Date.now() - t0, log, more: more.n });
    }

    // =====================================================================================  ABEBOOKS
    if (channel === "abe") {
      const user = String(K.abe.username).trim().toUpperCase(), pass = String(K.abe.password).trim();
      // 1) the data file - part 0 only, and only once
      const [dj] = await sql`update pipeline.send_jobs set data_state = 'sending', started_at = coalesce(started_at, now()), updated_at = now()
                              where id = (select id from pipeline.send_jobs where channel = 'abe' and status = 'running' and (data_state = 'waiting'
                                or (data_state = 'sending' and updated_at < now() - interval '3 minutes')) order by id limit 1 for update skip locked)
                              returning id, data_file, data_name`;
      if (dj && part === 0) {
        const f = new FTPS("ftp.abebooks.com");
        try {
          await f.connect(user, pass); await f.stor(dj.data_name, new TextEncoder().encode(dj.data_file)); await f.quit();
          await sql`update pipeline.send_jobs set data_state = 'sent', updated_at = now() where id = ${dj.id}`; log.push("data file sent " + dj.data_name);
        } catch (e) {
          await f.quit();
          await sql`update pipeline.send_jobs set data_state = 'failed', summary = ${"data file failed: " + String((e as Error).message).slice(0, 200)}, updated_at = now() where id = ${dj.id}`;
          await sql`update pipeline.send_items set state = 'waiting', note = 'data file failed - photos not sent' where job_id = ${dj.id} and state = 'queued'`;
          await finishJobs(); return json({ ok: false, error: "data file failed", log: f.log });
        }
      } else if (dj) { await sql`update pipeline.send_jobs set data_state = 'waiting' where id = ${dj.id} and data_state = 'sending'`; }
      // photos wait for the data file (parts 1 and 2 nap, then come back)
      if (part !== 0) {
        const [w] = await sql`select count(*)::int n from pipeline.send_jobs where channel = 'abe' and status = 'running' and data_state in ('waiting','sending')`;
        if (w.n) { await sleep(6000); EdgeRuntime.waitUntil(kick("abe", part)); return json({ ok: true, part, waiting: "data file first" }); }
      }
      const claim = async () => (await sql`update pipeline.send_items i set state = 'working', claimed_at = now(), updated_at = now()
          where i.id = (select i2.id from pipeline.send_items i2 join pipeline.send_jobs j2 on j2.id = i2.job_id
            where j2.channel = 'abe' and j2.data_state = 'sent' and (i2.state = 'queued' or (i2.state = 'working' and i2.claimed_at < now() - interval '4 minutes'))
            order by i2.job_id, i2.seq limit 1 for update of i2 skip locked) returning i.*`)[0];
      let f: FTPS | null = null, inSession = 0;
      const fetchPhoto = async (u: string) => {
        // AbeBooks shows photos small: ask Supabase for a 1600 px copy (far fewer bytes); fall back to the original
        const m = u.match(/\/storage\/v1\/object\/public\/(.+)$/);
        if (m) {
          const r = await getPhoto(`${SB}/storage/v1/render/image/public/${m[1]}?width=1600&quality=80&resize=contain`, 30000);
          if (r.ok && r.bytes.length > 4000 && r.ctype.includes("image")) return r.bytes;   // else: the original
        }
        const r = await getPhoto(u); const b = r.bytes;
        if (!r.ok || b.length < 4000) throw new Error(`photo not reachable (${r.status}, ${b.length} bytes)`);
        return b;
      };
      try {
        while (Date.now() - t0 < BUDGET) {
          const it = await claim(); if (!it) break;
          const urls: string[] = (it.payload.urls || []).slice(0, 20);
          const photos: string[] = it.photos?.length === urls.length ? it.photos : urls.map(() => "gray");
          const names = urls.map((_, i) => `${it.pd}_${i + 1}.jpg`);
          const save = (note?: string) => sql`update pipeline.send_items set photos = ${sql.json(photos)}, names = ${sql.json(names)}, note = ${note ?? null}, updated_at = now() where id = ${it.id}`;
          let paused = false, err = "";
          for (let i = 0; i < urls.length; i++) {
            if (photos[i] === "green") continue;
            if (Date.now() - t0 > BUDGET) { paused = true; break; }
            if (!f || inSession >= ABE_SESSION_MAX) { if (f) await f.quit(); f = new FTPS("ftp.abebooks.com"); await f.connect(user, pass); inSession = 0; }
            photos[i] = "yellow"; await save(`photo ${i + 1} of ${urls.length}`);
            try {
              const bytes = await fetchPhoto(urls[i]);
              try { await f.stor(names[i], bytes); }
              catch (_) { try { await f.quit(); } catch {} f = new FTPS("ftp.abebooks.com"); await f.connect(user, pass); inSession = 0; await f.stor(names[i], bytes); }   // one reconnect
              inSession++; photos[i] = "green"; await save(`photo ${i + 1} of ${urls.length}`);
            } catch (e) { photos[i] = "red"; err = String((e as Error).message || e).slice(0, 200); await save(err); }
          }
          if (paused) { await sql`update pipeline.send_items set state = 'queued', updated_at = now() where id = ${it.id}`; break; }
          const g = photos.filter((x) => x === "green").length;
          await sql`update pipeline.send_items set state = ${g === urls.length ? "done" : "short"}, note = ${g === urls.length ? `photos ${g}/${urls.length} sent` : `photos ${g}/${urls.length} - ${err}`}, updated_at = now() where id = ${it.id}`;
          log.push(`${it.pd} ${g}/${urls.length}`);
        }
      } finally { if (f) await f.quit(); }
      await finishJobs();
      const [more] = await sql`select count(*)::int n from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id where j.channel = 'abe' and i.state in ('queued')`;
      if (more.n) EdgeRuntime.waitUntil(kick("abe", part));
      return json({ ok: true, channel, part, ms: Date.now() - t0, log, more: more.n });
    }

    // =====================================================================================  EBAY
    if (channel === "ebay") {
      const e = K.ebay;
      const trading = async (call: string, inner: string) => {
        const body = `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xesc(e.auth_token)}</eBayAuthToken></RequesterCredentials><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>${inner}</${call}Request>`;
        for (let a = 0; a < 3; a++) {
          const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", body, signal: AbortSignal.timeout(90000), headers: { "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "0",
            "X-EBAY-API-COMPATIBILITY-LEVEL": "1193", "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" } });
          const t = await r.text();
          if (r.status >= 500 && a < 2) { await sleep(3000 * (a + 1)); continue; }
          return xmlp.parse(t)[call + "Response"] || {};
        }
        return {};
      };
      const errs = (x: any) => arr(x.Errors).filter((er: any) => txt(er.SeverityCode) === "Error").map((er: any) => `${txt(er.ErrorCode)} ${txt(er.LongMessage) || txt(er.ShortMessage)}`).join("; ");
      // business policies by ID (Rule BK.4): cached in backup.config
      let pol: any = null;
      const [pc] = await sql`select value from backup.config where key = 'ebay_policy_ids'`;
      if (pc?.value) pol = JSON.parse(pc.value);
      if (!pol || url.searchParams.get("refresh_policies")) {
        const x = await trading("GetUserPreferences", "<ShowSellerProfilePreferences>true</ShowSellerProfilePreferences>");
        const profs = arr(x.SellerProfilePreferences?.SupportedSellerProfiles?.SupportedSellerProfile);
        const find = (type: string, name: string) => txt(profs.find((p: any) => txt(p.ProfileType) === type && txt(p.ProfileName) === name)?.ProfileID);
        pol = { ship: find("SHIPPING", "Media Mail Calculated"), ret: find("RETURN_POLICY", "30 Day Buyer Pays"), pay: find("PAYMENT", "eBay Payments"),
          all: profs.map((p: any) => `${txt(p.ProfileType)}:${txt(p.ProfileName)}:${txt(p.ProfileID)}`) };
        if (!pol.ship || !pol.ret || !pol.pay) return json({ ok: false, error: "eBay business policies not found by name", pol }, 500);
        await sql`insert into backup.config (key, value) values ('ebay_policy_ids', ${JSON.stringify(pol)}) on conflict (key) do update set value = excluded.value`;
      }
      if (action === "policies") return json({ ok: true, pol });
      const itemXml = (p: any, test: boolean) => {
        const H: string[] = p.header119, R: string[] = p.row; const col = (h: string) => String(R[H.indexOf(h)] ?? "").trim();
        const specs = H.map((h, i) => [h, String(R[i] ?? "").trim()]).filter(([h, v]) => /^\*?C:/.test(h) && v)
          .map(([h, v]) => `<NameValueList><Name>${xesc(h.replace(/^\*?C:/, ""))}</Name><Value>${xesc(v)}</Value></NameValueList>`).join("");
        const pics = (p.pics || []).slice(0, 24).map((u: string) => `<PictureURL>${xesc(u)}</PictureURL>`).join("");
        const desc = String(p.b2).replace(/]]>/g, "]]&gt;");
        const store = col("StoreCategory") || String(p.store || "");
        return `<Item><Title>${xesc(p.title)}</Title><Description><![CDATA[${desc}]]></Description>` +
          `<PrimaryCategory><CategoryID>${xesc(col("*Category") || p.cat)}</CategoryID></PrimaryCategory>` + (store ? `<Storefront><StoreCategoryID>${xesc(store)}</StoreCategoryID></Storefront>` : "") +
          `<StartPrice currencyID="USD">${Number(p.lst).toFixed(2)}</StartPrice><Quantity>${Number(p.qty || 1)}</Quantity><SKU>${xesc(p.pd)}</SKU>` +
          `<ConditionID>${Number(p.cid)}</ConditionID><ConditionDescription>${xesc(String(p.b1).slice(0, 1000))}</ConditionDescription>` +
          `<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails><ListingDetails><BestOfferAutoAcceptPrice currencyID="USD">${Number(p.auto).toFixed(2)}</BestOfferAutoAcceptPrice><MinimumBestOfferPrice currencyID="USD">${Number(p.mn).toFixed(2)}</MinimumBestOfferPrice></ListingDetails>` +
          `<Country>US</Country><Currency>USD</Currency><Location>Gresham, Oregon</Location><PostalCode>97080</PostalCode><ListingDuration>GTC</ListingDuration><ListingType>FixedPriceItem</ListingType>` +
          `<PictureDetails>${pics}</PictureDetails><ItemSpecifics>${specs}</ItemSpecifics>` +
          `<SellerProfiles><SellerShippingProfile><ShippingProfileID>${pol.ship}</ShippingProfileID></SellerShippingProfile><SellerReturnProfile><ReturnProfileID>${pol.ret}</ReturnProfileID></SellerReturnProfile><SellerPaymentProfile><PaymentProfileID>${pol.pay}</PaymentProfileID></SellerPaymentProfile></SellerProfiles>` +
          `<ShippingPackageDetails><MeasurementUnit>English</MeasurementUnit><WeightMajor unit="lbs">${Math.max(1, Math.ceil(Number(p.wmaj || p.wt || 1)))}</WeightMajor><WeightMinor unit="oz">0</WeightMinor></ShippingPackageDetails>` +
          (test ? "" : `<UUID>${p.uuid}</UUID>`) + `</Item>`;
      };
      const atRec = async (pd: string) => {
        const r = await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}?` + new URLSearchParams([["filterByFormula", `{Tracking Number}='${pd}'`], ["returnFieldsByFieldId", "true"], ["fields[]", F_TRACK]]),
          { headers: { Authorization: "Bearer " + K.airtable.token }, signal: AbortSignal.timeout(30000) });
        return ((await r.json()).records || [])[0]?.id as string | undefined;
      };
      const claim = async () => (await sql`update pipeline.send_items i set state = 'working', claimed_at = now(), updated_at = now()
          from pipeline.send_jobs j where j.id = i.job_id and i.id = (select i2.id from pipeline.send_items i2 join pipeline.send_jobs j2 on j2.id = i2.job_id
            where j2.channel = 'ebay' and (i2.state = 'queued' or (i2.state = 'working' and i2.claimed_at < now() - interval '4 minutes'))
            order by i2.job_id, i2.seq limit 1 for update of i2 skip locked) returning i.*, j.test, j.id as jid`)[0];
      const worker = async () => {
        while (Date.now() - t0 < BUDGET) {
          const it = await claim(); if (!it) return;
          const p = it.payload; const n = Math.min(24, (p.pics || []).length);
          const names = Array.from({ length: n }, (_, k) => `${it.pd}_${k + 1}.jpg`);
          const paint = (c: string, note: string) => sql`update pipeline.send_items set photos = ${sql.json(names.map(() => c))}, names = ${sql.json(names)}, note = ${note}, updated_at = now() where id = ${it.id}`;
          try {
            if (it.listing_id) { await sql`update pipeline.send_items set state = 'done', updated_at = now() where id = ${it.id}`; continue; }   // never list twice
            await paint("yellow", it.test ? "checking with eBay (nothing will list)" : "listing on eBay");
            const uuid = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`papaduck-${it.jid}-${it.pd}`)))).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
            const x = await trading(it.test ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem", itemXml({ ...p, uuid }, it.test));
            const ack = txt(x.Ack); let itemId = txt(x.ItemID);
            const warn = arr(x.Errors).filter((er: any) => txt(er.SeverityCode) === "Warning").map((er: any) => txt(er.ShortMessage)).join("; ").slice(0, 200);
            if (!itemId) {            // duplicate UUID = it was already listed by an earlier try: eBay hands back that ItemID
              const dup = arr(x.Errors).find((er: any) => txt(er.ErrorCode) === "488");
              if (dup) itemId = txt(arr(dup.ErrorParameters).find((ep: any) => /^\d{9,15}$/.test(txt(ep.Value)))?.Value);
            }
            if (ack !== "Success" && ack !== "Warning" && !itemId) { await paint("red", errs(x) || "eBay said " + ack); throw new Error(errs(x) || "eBay said " + (ack || "nothing")); }
            if (it.test) {
              await paint("green", `TEST OK - eBay accepted the listing (nothing listed). Fees ${txt(arr(x.Fees?.Fee).find((f: any) => txt(f.Name) === "ListingFee")?.Fee?.["#text"] ?? "")}${warn ? " - note: " + warn : ""}`);
              await sql`update pipeline.send_items set state = 'done', updated_at = now() where id = ${it.id}`; continue;
            }
            await sql`update pipeline.send_items set listing_id = ${itemId}, updated_at = now() where id = ${it.id}`;
            const g = await trading("GetItem", `<ItemID>${itemId}</ItemID><DetailLevel>ReturnSummary</DetailLevel>`);
            const live = txt(g.Item?.SellingStatus?.ListingStatus), np = arr(g.Item?.PictureDetails?.PictureURL).length;
            let at = "Airtable updated";
            try {
              const rec = await atRec(it.pd);
              if (!rec) at = "no Airtable record";
              else {
                const fields: Record<string, unknown> = { [F_ITEMID]: itemId, [F_STATUS]: "Listed", [F_LISTED]: today() };
                if (p.price_changed) Object.assign(fields, { [F_LIST]: Number(p.lst), [F_AUTO]: Number(p.auto), [F_MIN]: Number(p.mn) });
                const r = await fetch(`https://api.airtable.com/v0/${BASE}/${T_INV}`, { method: "PATCH", headers: { Authorization: "Bearer " + K.airtable.token, "Content-Type": "application/json" },
                  body: JSON.stringify({ typecast: true, records: [{ id: rec, fields }] }), signal: AbortSignal.timeout(30000) });
                if (!r.ok) at = "Airtable write failed " + r.status;
              }
            } catch (er) { at = "Airtable write failed " + String(er).slice(0, 80); }
            await sql`select pipeline.mark_built(array[${it.pd}]::text[])`.catch(() => {});
            const ok = live === "Active";
            await paint(ok ? "green" : "red", `${ok ? "LIVE" : "CHECK"} eBay ${itemId} (${live || "?"}) photos ${np || n}/${n} $${Number(p.lst).toFixed(2)} ${at}${warn ? " - note: " + warn : ""}`);
            await sql`update pipeline.send_items set state = ${ok ? "done" : "failed"}, updated_at = now() where id = ${it.id}`;
            log.push(`${it.pd} ${itemId} ${live}`);
          } catch (er) {
            const m = String((er as Error).message || er).slice(0, 300);
            await sql`update pipeline.send_items set state = 'failed', note = ${m}, updated_at = now() where id = ${it.id}`; log.push(it.pd + " FAILED " + m);
          }
        }
      };
      await Promise.all([worker(), (async () => { await sleep(500); await worker(); })()]);
      await finishJobs();
      const [more] = await sql`select count(*)::int n from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id where j.channel = 'ebay' and i.state in ('queued')`;
      if (more.n) EdgeRuntime.waitUntil(kick("ebay"));
      return json({ ok: true, channel, ms: Date.now() - t0, log, more: more.n });
    }

    // =====================================================================================  AMAZON
    if (channel === "amazon") {
      const A = K.amazon; const MKT = "ATVPDKIKX0DER", HOST = "https://sellingpartnerapi-na.amazon.com";
      const lr = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: A.refresh_token, client_id: A.client_id, client_secret: A.client_secret }).toString(), signal: AbortSignal.timeout(30000) });
      const tok = (await lr.json()).access_token; if (!tok) return json({ ok: false, error: "Amazon login failed " + lr.status }, 500);
      const amz = async (method: string, path: string, params: Record<string, string>, body?: unknown) => {
        for (let a = 0; a < 5; a++) {
          const r = await fetch(HOST + path + "?" + new URLSearchParams(params), { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
            headers: { "x-amz-access-token": tok, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "PapaDuckCloud/2 (Language=TypeScript)" } });
          const t = await r.text();
          if ((r.status === 429 || r.status >= 500) && a < 4) { await sleep(2500 * (a + 1)); continue; }
          let j: any = {}; try { j = JSON.parse(t || "{}"); } catch { /* raw */ }
          return { status: r.status, j, raw: t };
        }
        return { status: 0, j: {}, raw: "" };
      };
      const claim = async () => (await sql`update pipeline.send_items i set state = 'working', claimed_at = now(), updated_at = now()
          from pipeline.send_jobs j where j.id = i.job_id and i.id = (select i2.id from pipeline.send_items i2 join pipeline.send_jobs j2 on j2.id = i2.job_id
            where j2.channel = 'amazon' and (i2.state = 'queued' or (i2.state = 'working' and i2.claimed_at < now() - interval '4 minutes'))
            order by i2.job_id, i2.seq limit 1 for update of i2 skip locked) returning i.*, j.run_mode`)[0];
      while (Date.now() - t0 < BUDGET) {
        const it = await claim(); if (!it) break;
        const b = it.payload, preview = it.run_mode === "preview";
        const paint = (c: string, note: string) => sql`update pipeline.send_items set photos = ${sql.json([c])}, names = ${sql.json(["ASIN " + b.asin])}, note = ${note}, updated_at = now() where id = ${it.id}`;
        try {
          await paint("yellow", preview ? "Amazon is checking it" : "listing on Amazon");
          let pt = String(b.product_type || "");
          if (!pt) { const c = await amz("GET", `/catalog/2022-04-01/items/${b.asin}`, { marketplaceIds: MKT, includedData: "productTypes" }); pt = c.j.productTypes?.[0]?.productType || "PRODUCT"; }
          const body = { productType: pt, requirements: "LISTING_OFFER_ONLY", attributes: {
            merchant_suggested_asin: [{ value: b.asin, marketplace_id: MKT }], condition_type: [{ value: b.cond, marketplace_id: MKT }],
            condition_note: [{ value: b.note, language_tag: "en_US", marketplace_id: MKT }],
            purchasable_offer: [{ audience: "ALL", currency: "USD", marketplace_id: MKT, our_price: [{ schedule: [{ value_with_tax: Math.round(Number(b.price) * 100) / 100 }] }] }],
            fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: Number(b.quantity || 1) }] } };
          const params: Record<string, string> = { marketplaceIds: MKT, issueLocale: "en_US" }; if (preview) params.mode = "VALIDATION_PREVIEW";
          const r = await amz("PUT", `/listings/2021-08-01/items/${A.seller_id}/${encodeURIComponent(it.pd)}`, params, body);
          const st = r.j.status || ("HTTP " + r.status);
          const bad = [...(r.j.issues || []).filter((i: any) => i.severity === "ERROR"), ...(r.j.errors || [])].map((i: any) => String(i.message || "").slice(0, 160)).join("; ");
          const ok = ["ACCEPTED", "VALID"].includes(r.j.status) && !bad;
          await paint(ok ? "green" : "red", ok ? (preview ? `OK - Amazon accepted it ($${Number(b.price).toFixed(2)} ${b.cond})` : `SENT - live within ~15 min ($${Number(b.price).toFixed(2)} ${b.cond})`) : `${st} ${bad}`.trim());
          await sql`update pipeline.send_items set state = ${ok ? "done" : "failed"}, note = ${ok ? (preview ? "OK - Amazon accepted it" : "SENT - live within ~15 min") : (st + " " + bad).trim().slice(0, 300)}, updated_at = now() where id = ${it.id}`;
        } catch (er) {
          await sql`update pipeline.send_items set state = 'failed', note = ${String((er as Error).message || er).slice(0, 300)}, updated_at = now() where id = ${it.id}`;
        }
        await sleep(300);
      }
      await finishJobs();
      const [more] = await sql`select count(*)::int n from pipeline.send_items i join pipeline.send_jobs j on j.id = i.job_id where j.channel = 'amazon' and i.state in ('queued')`;
      if (more.n) EdgeRuntime.waitUntil(kick("amazon"));
      return json({ ok: true, channel, ms: Date.now() - t0, more: more.n });
    }
    return json({ error: "unknown channel" }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 400), log }, 500);
  } finally {
    if (lockHeld) await sql`select pg_advisory_unlock(7342001)`.catch(() => {});
    await sql.end({ timeout: 3 });
  }
});
