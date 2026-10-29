// Papa Duck — "fba-inbound" (2026-10-28 v3). FBA Stage 2: tell Amazon a packed FBA box is coming (Fulfillment Inbound v2024-03-20).
// Papa Duck: "you have api, this should be done in our app" / "add this to my launch pad as a process when I print all the sku
// and say ready to jump on another lilly pad".
// Launch Pad: 🐸 Ready to jump  ->  pipeline.fba_ship_start(box, lb, l, w, h)  ->  this worker walks the steps below (cron pd-fba-ship
// every minute + a kick right away), stops at 'choose' with every warehouse's total (placement fee + UPS), HE taps one
// (pipeline.fba_ship_choose) and only then Amazon is told to confirm and charge. Then the 4x6 label link comes back.
// States (pipeline.fba_ship.state): start -> plan -> packing -> placement -> choose (waits for him) -> confirm -> label -> done | error
// Actions (POST JSON, x-backup-secret = cron_secret):
//   {action:"work"}                         advance waiting boxes (as many steps as fit in ~110 s)
//   {action:"call", method, path, params?, body?}   one raw SP-API inbound call (for Claude), operation awaited
//   {action:"probe"}                        read-only check
import postgres from "npm:postgres@3.4.4";
import { Amazon, Ctx } from "./fba_core.ts";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const OK_PATH = /^\/(inbound\/fba\/2024-03-20|fba\/inbound\/v0)\//;
const MKT = "ATVPDKIKX0DER", V = "/inbound/fba/2024-03-20";
const BUDGET = 110000;

Deno.serve(async (req) => {
  const T0 = Date.now();
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const k = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret);
    const ctx: Ctx = { fetch: (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(60000) }) as any, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    const amz = new Amazon(ctx, k.amazon);
    const log = (box: number | null, method: string, path: string, body: unknown, status: number, answer: unknown, op: unknown) =>
      sql`insert into pipeline.fba_inbound_log (box, method, path, body, status, answer, op)
        values (${box}, ${method}, ${path}, ${body ? sql.json(body as any) : null}, ${status}, ${sql.json((answer ?? {}) as any)}, ${op ? sql.json(op as any) : null})`;
    // one SP-API call; waits for Amazon's operation to finish when it hands one back
    const call = async (box: number | null, method: string, path: string, params: Record<string, string> = {}, body?: unknown) => {
      const r = await amz.api(method, path, params, body);
      let op: any = null;
      if (r.j?.operationId) {
        for (let i = 0; i < 30; i++) {
          await ctx.sleep(i < 5 ? 2000 : 4000);
          op = (await amz.api("GET", `${V}/operations/${r.j.operationId}`, {})).j;
          if (op?.operationStatus && op.operationStatus !== "IN_PROGRESS") break;
        }
      }
      await log(box, method, path, body, r.status, r.j, op);
      return { status: r.status, j: r.j, op };
    };
    const errOf = (r: { status: number; j: any; op: any }) => {
      if (r.status >= 300) return (r.j?.errors || []).map((e: any) => e.message).join("; ").slice(0, 500) || `HTTP ${r.status}`;
      if (r.op && r.op.operationStatus !== "SUCCESS") return (r.op.operationProblems || []).filter((p: any) => p.severity !== "WARNING").map((p: any) => p.message).join("; ").slice(0, 500) || "Amazon: " + r.op.operationStatus;
      return "";
    };

    if (b.action === "probe") {
      const plans = await amz.api("GET", `${V}/inboundPlans`, { pageSize: "5", status: "ACTIVE" });
      return json({ plans: { status: plans.status, body: plans.raw.slice(0, 1500) } });
    }
    if (b.action === "call") {
      const path = String(b.path || "");
      if (!OK_PATH.test(path)) return json({ error: "only FBA inbound paths" }, 400);
      const r = await call(b.box ?? null, String(b.method || "GET").toUpperCase(), path, b.params || {}, b.body);
      return json({ status: r.status, answer: r.j, op: r.op });
    }
    if (b.action !== "work") return json({ error: "unknown action" }, 400);

    const [lk] = await sql`select pg_try_advisory_lock(7342003) as ok`;
    if (!lk.ok) return json({ ok: true, skipped: "already running" });
    const done: string[] = [];
    try {
      for (;;) {
        if (Date.now() - T0 > BUDGET) break;
        const [s] = await sql`select * from pipeline.fba_ship where state in ('start','plan','packing','placement','confirm','label') order by updated_at limit 1`;
        if (!s) break;
        const box = Number(s.box);
        const save = (patch: Record<string, unknown>) => sql`update pipeline.fba_ship set ${sql({ ...patch, updated_at: new Date().toISOString() } as any)} where box = ${box}`;
        const fail = async (why: string) => { await save({ state: "error", error: why.slice(0, 600), step_from: s.state }); done.push(`Box ${box} ERROR ${why}`); };
        const items = () => (s.items as string[]).map((pd) => ({ msku: pd, quantity: 1, labelOwner: "SELLER", prepOwner: "SELLER" }));
        try {
          if (s.state === "start") {
            // every printed sticker in the box (books Amazon refused stay out and are listed for him)
            const rows = await sql`select pd from pipeline.fba_items where box = ${box} and status = 'ready' and fnsku is not null and printed_at is not null order by pd`;
            const pds = rows.map((r: any) => r.pd).filter((pd: string) => !(s.refused || []).some((x: any) => x.pd === pd));
            if (!pds.length) { await fail("No printed books in this box."); continue; }
            const r = await call(box, "POST", `${V}/items/prepDetails`, {}, { marketplaceId: MKT, mskuPrepDetails: pds.map((pd: string) => ({ msku: pd, prepCategory: "NONE", prepTypes: ["ITEM_NO_PREP"] })) });
            const e = errOf(r); if (e) { await fail("Prep details: " + e); continue; }
            await save({ state: "plan", items: sql.json(pds) as any }); s.items = pds; s.state = "plan"; done.push(`Box ${box}: ${pds.length} books set to no prep`);
          } else if (s.state === "plan") {
            const from = JSON.parse((await sql`select value from backup.config where key = 'fba_ship_from'`)[0]?.value || "null");
            if (!from) { await fail("No ship-from address saved (backup.config fba_ship_from)."); continue; }
            const r = await call(box, "POST", `${V}/inboundPlans`, {}, { destinationMarketplaces: [MKT], name: `Papa Duck FBA Box ${box}`, sourceAddress: from, items: items() });
            const e = errOf(r);
            if (e) {
              // Amazon names the books it won't take ("There's an input error with the resource 'PD-3108'") - drop them and try again
              const bad = new Map<string, string>();
              for (const p of [...(r.op?.operationProblems || []), ...(r.j?.errors || [])]) {
                const m = String((p.details || "") + " " + (p.message || "")).match(/PD-\d{4}[A-Z]?/);
                if (m && p.severity !== "WARNING") bad.set(m[0], String(p.message || "").replace(/^ERROR:\s*/, "").slice(0, 200));
              }
              if (bad.size && bad.size < (s.items as string[]).length && Number(s.tries || 0) < 4) {
                const refused = [...(s.refused || []), ...[...bad].map(([pd, why]) => ({ pd, why }))];
                const left = (s.items as string[]).filter((pd) => !bad.has(pd));
                await save({ items: sql.json(left) as any, refused: sql.json(refused) as any, tries: Number(s.tries || 0) + 1 });
                done.push(`Box ${box}: Amazon refused ${[...bad.keys()].join(", ")} - retrying without them`); continue;
              }
              await fail("Create shipment: " + e); continue;
            }
            await save({ state: "packing", plan_id: r.j.inboundPlanId }); done.push(`Box ${box}: plan ${r.j.inboundPlanId}`);
          } else if (s.state === "packing") {
            const P = `${V}/inboundPlans/${s.plan_id}`;
            let r = await call(box, "POST", `${P}/packingOptions`);
            let e = errOf(r); if (e) { await fail("Packing options: " + e); continue; }
            r = await call(box, "GET", `${P}/packingOptions`);
            const opts = (r.j?.packingOptions || []).filter((o: any) => o.status === "OFFERED");
            const one = opts.find((o: any) => (o.packingGroups || []).length === 1) || null;
            if (!one) { await fail(`Amazon wants these books split into ${(opts[0]?.packingGroups || []).length || "several"} groups. Tell Claude.`); continue; }
            if ((one.fees || []).length) done.push(`Box ${box}: packing option has fees ${JSON.stringify(one.fees)}`);
            r = await call(box, "POST", `${P}/packingOptions/${one.packingOptionId}/confirmation`);
            e = errOf(r); if (e) { await fail("Confirm packing: " + e); continue; }
            const d = s.dims || {};
            r = await call(box, "POST", `${P}/packingInformation`, {}, { packageGroupings: [{ packingGroupId: one.packingGroups[0], boxes: [{
              contentInformationSource: "BOX_CONTENT_PROVIDED", quantity: 1,
              dimensions: { length: Number(d.l), width: Number(d.w), height: Number(d.h), unitOfMeasurement: "IN" },
              weight: { value: Math.ceil(Number(s.lb)), unit: "LB" }, items: items() }] }] });
            e = errOf(r); if (e) { await fail("Box weight/size: " + e); continue; }
            await save({ state: "placement", packing_group: one.packingGroups[0] }); done.push(`Box ${box}: packed`);
          } else if (s.state === "placement") {
            const P = `${V}/inboundPlans/${s.plan_id}`;
            let r = await call(box, "POST", `${P}/placementOptions`, {}, {});
            const e = errOf(r); if (e) { await fail("Warehouse options: " + e); continue; }
            r = await call(box, "GET", `${P}/placementOptions`);
            const places = (r.j?.placementOptions || []).filter((o: any) => o.status === "OFFERED" && (o.shipmentIds || []).length === 1);
            if (!places.length) { await fail("Amazon offered no single-warehouse option for this box. Tell Claude."); continue; }
            const start = new Date(Date.now() + 12 * 3600e3).toISOString().replace(/\.\d+Z$/, "Z");
            const options: any[] = [];
            for (const pl of places) {
              const sh = pl.shipmentIds[0];
              const g = await call(box, "POST", `${P}/transportationOptions`, {}, { placementOptionId: pl.placementOptionId,
                shipmentTransportationConfigurations: [{ shipmentId: sh, readyToShipWindow: { start } }] });
              if (errOf(g)) continue;
              let tok: string | undefined, ups: any = null;
              for (let n = 0; n < 15 && !ups; n++) {
                const l = await amz.api("GET", `${P}/transportationOptions`, { placementOptionId: pl.placementOptionId, pageSize: "20", ...(tok ? { paginationToken: tok } : {}) });
                ups = (l.j?.transportationOptions || []).find((o: any) => o.shippingSolution === "AMAZON_PARTNERED_CARRIER" && o.shippingMode === "GROUND_SMALL_PARCEL" && o.quote?.cost?.amount != null) || null;
                tok = l.j?.pagination?.nextToken; if (!tok) break;
              }
              if (!ups) continue;
              const dest = (await amz.api("GET", `${P}/shipments/${sh}`, {})).j?.destination || {};
              const fee = (pl.fees || []).reduce((a: number, f: any) => a + Number(f.value?.amount || 0), 0) - (pl.discounts || []).reduce((a: number, f: any) => a + Number(f.value?.amount || 0), 0);
              options.push({ placement: pl.placementOptionId, shipment: sh, transport: ups.transportationOptionId, fee: Math.round(fee * 100) / 100,
                ups: Number(ups.quote.cost.amount), total: Math.round((fee + Number(ups.quote.cost.amount)) * 100) / 100,
                city: dest.address?.city || "", st: dest.address?.stateOrProvinceCode || "", warehouse: dest.warehouseId || "", expires: pl.expiration || null });
            }
            if (!options.length) { await fail("No Amazon-partnered UPS price came back. Tell Claude."); continue; }
            options.sort((a, b) => a.total - b.total);
            await save({ state: "choose", options: sql.json(options) as any }); done.push(`Box ${box}: ${options.length} warehouse choices`);
          } else if (s.state === "confirm") {
            const P = `${V}/inboundPlans/${s.plan_id}`;
            const o = (s.options || []).find((x: any) => x.placement === s.chosen);
            if (!o) { await fail("Chosen warehouse not found."); continue; }
            if (!s.placement_done) {
              const r = await call(box, "POST", `${P}/placementOptions/${o.placement}/confirmation`);
              const e = errOf(r); if (e) { await fail("Confirm warehouse: " + e); continue; }
              await save({ placement_done: true }); s.placement_done = true;
            }
            const r = await call(box, "POST", `${P}/transportationOptions/confirmation`, {}, { transportationSelections: [{ shipmentId: o.shipment, transportationOptionId: o.transport }] });
            const e = errOf(r); if (e) { await fail("Confirm UPS: " + e); continue; }
            const sh = (await amz.api("GET", `${P}/shipments/${o.shipment}`, {})).j || {};
            const trk = (sh.trackingDetails?.spdTrackingDetail?.spdTrackingItems || []).map((t: any) => ({ box: t.boxId, tracking: t.trackingId }));
            await save({ state: "label", shipment_id: o.shipment, confirmation_id: sh.shipmentConfirmationId || null, tracking: sql.json(trk) as any });
            done.push(`Box ${box}: confirmed ${sh.shipmentConfirmationId}`);
          } else if (s.state === "label") {
            let conf = s.confirmation_id, trk = s.tracking || [];
            if (!conf || !trk.length) {
              const sh = (await amz.api("GET", `${V}/inboundPlans/${s.plan_id}/shipments/${s.shipment_id}`, {})).j || {};
              conf = sh.shipmentConfirmationId; trk = (sh.trackingDetails?.spdTrackingDetail?.spdTrackingItems || []).map((t: any) => ({ box: t.boxId, tracking: t.trackingId }));
              if (!conf) { await save({ next_note: "waiting for Amazon's shipment number" }); break; }
            }
            const ids = trk.map((t: any) => t.box).filter(Boolean).join(",") || `${conf}U000001`;
            const r = await call(box, "GET", `/fba/inbound/v0/shipments/${conf}/labels`, { PageType: "PackageLabel_Thermal", LabelType: "UNIQUE", PackageLabelsToPrint: ids });
            const url = r.j?.payload?.DownloadURL;
            if (!url) { await fail("Label: " + errOf(r)); continue; }
            await save({ state: "done", confirmation_id: conf, tracking: sql.json(trk) as any, label_url: url, label_at: new Date().toISOString(), error: null });
            await sql`update pipeline.fba_boxes set shipped_at = coalesce(shipped_at, now()), closed_at = coalesce(closed_at, now()) where n = ${box}`;
            done.push(`Box ${box}: label ready`);
          }
        } catch (e) { await fail(String((e as Error).message || e)); }
      }
    } finally { await sql`select pg_advisory_unlock(7342003)`; }
    return json({ ok: true, done });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
