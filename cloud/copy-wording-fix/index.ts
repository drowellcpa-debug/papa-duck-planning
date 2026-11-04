// Papa Duck - Edge Function "copy-wording-fix" v2 (2026-11-04; v2: keeps print-run / "need multiple copies" wording; {"desc"} restores a full description). Papa Duck: copy counts like "Two identical copies available" "should never be on the wording of any description".
// For one eBay listing: GetItem (full description + condition description), removes ONLY the sentences that state a copy count / copies available,
// ReviseItem with the cleaned text, then reads it back. POST {"item_id":"...","dry":true}. Every before/after is kept in pipeline.abe_probe ("cwfix:").
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const NUM = "\\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple";
export const isCount = (s: string) => /\b(cop(y|ies)|units?)\b/i.test(s) && !/no longer available|new copies|spare copy|lot of identical copies|need(ing|s)? (multiple|matching) copies|printing|print run|numbered|limited to|edition of|copies (sold|in print|included)|\binclud(e|es|ed|ing)\b|\bset\b|bundle/i.test(s) &&
  (new RegExp(`\\b(${NUM})\\b[^.;]*\\b(copies|units)\\b`, "i").test(s) || /\b(copies|units) (are )?(available|on hand)\b/i.test(s) || /\bquantity\b/i.test(s));
export const cleanText = (t: string) => {
  const parts = t.split(/(?<=[.!?])(\s+)/);
  let out = "";
  for (let i = 0; i < parts.length; i += 2) { const sen = parts[i], sp = parts[i + 1] || ""; if (sen && isCount(sen)) continue; out += sen + sp; }
  return out;
};
export const cleanHtml = (h: string) => {
  let x = h.replace(/>([^<]+)</g, (_m, t) => ">" + (/^\W*quantity:?\s*$/i.test(t) ? "" : cleanText(t)) + "<");
  if (!/[<>]/.test(h)) x = cleanText(h);
  for (let k = 0; k < 4; k++) x = x.replace(/<(b|strong|span|em|i)(\s[^>]*)?>\s*<\/\1>/gi, "").replace(/<(li|p)(\s[^>]*)?>[\s. ]*<\/\1>/gi, "");
  return x;
};

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const id = String(b.item_id || "").replace(/\D/g, "");
    if (!id) return json({ ok: false, error: "need item_id" }, 400);
    const e = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).ebay;
    const trade = async (name: string, inner: string) => (await (await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
      body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${e.auth_token.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` })).text());
    const un = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    const get = async () => {
      const g = await trade("GetItem", `<ItemID>${id}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>false</IncludeItemSpecifics>`);
      const pick = (t: string) => un((g.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || "");
      return { status: pick("ListingStatus"), sku: pick("SKU"), desc: pick("Description"), cond: pick("ConditionDescription") };
    };
    const before = await get();
    if (before.status !== "Active") return json({ ok: false, error: `listing is ${before.status || "missing"}` });
    const desc = b.desc ? String(b.desc) : cleanHtml(before.desc), cond = cleanText(before.cond).trim();
    const removed = [...new Set([...before.desc.replace(/<[^>]+>/g, " ").split(/(?<=[.!?])\s+/), ...before.cond.split(/(?<=[.!?])\s+/)].filter(isCount).map((s) => s.trim()))];
    const T = "@" + Date.now();
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"cwfix-before:" + id + T}, ${JSON.stringify(before)}, now())`;
    if (desc === before.desc && cond === before.cond.trim()) return json({ ok: true, item_id: id, sku: before.sku, nothing: true });
    if (b.dry) return json({ ok: true, dry: true, item_id: id, sku: before.sku, removed, desc_len: [before.desc.length, desc.length], cond_after: cond });
    const r = await trade("ReviseItem", `<Item><ItemID>${id}</ItemID><Description><![CDATA[${desc.replace(/]]>/g, "]]]]><![CDATA[>")}]]></Description>${cond !== before.cond.trim() ? `<ConditionDescription>${cond.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</ConditionDescription>` : ""}</Item>`);
    const ack = (r.match(/<Ack>([^<]*)/) || [])[1] || "";
    if (!/Success|Warning/.test(ack)) return json({ ok: false, item_id: id, error: ((r.match(/<LongMessage>([^<]*)/) || [])[1] || r.slice(0, 200)) });
    const after = await get();
    await sql`insert into pipeline.abe_probe (k, html, at) values (${"cwfix-after:" + id + T}, ${JSON.stringify(after)}, now())`;
    const left = [...after.desc.replace(/<[^>]+>/g, " ").split(/(?<=[.!?])\s+/), ...after.cond.split(/(?<=[.!?])\s+/)].filter(isCount);
    return json({ ok: left.length === 0, item_id: id, sku: before.sku, removed, still_there: left });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400) }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
