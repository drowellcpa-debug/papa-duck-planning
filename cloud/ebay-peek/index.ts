// Papa Duck - Edge Function "ebay-peek" v1 (2026-11-26). READ-ONLY eBay Trading API look-ups for Claude to answer "what is eBay actually showing?"
// Papa Duck: "seems like somewhere I should be able to see this? dig deeper" / "you have api" (Bing & Grondahl plates PD-0216: offer accepted,
//   listing out of stock, nothing in Orders). Only GET-type calls are allowed - it can never change a listing, offer or order.
// POST {call, inner} with header x-backup-secret. Returns the raw XML (trimmed).
import postgres from "npm:postgres@3.4.4";
const READ = new Set(["GetBestOffers", "GetItem", "GetOrders", "GetItemTransactions", "GetSellerTransactions", "GetMyeBaySelling", "GetMemberMessages"]);
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const xesc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const call = String(b.call || "");
    if (!READ.has(call)) return json({ error: "read-only calls only" }, 400);
    const inner = String(b.inner || "");
    if (/<\s*(Add|Revise|End|Relist|Complete|Respond|Set|Delete|Leave)/i.test(inner)) return json({ error: "read-only" }, 400);
    const e = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).ebay;
    const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
      body: `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xesc(e.auth_token)}</eBayAuthToken></RequesterCredentials>${inner}</${call}Request>` });
    const x = await r.text();
    return json({ ok: true, status: r.status, xml: x.replace(/<Description>[\s\S]*?<\/Description>/g, "<Description/>").slice(0, Number(b.max) || 12000) });
  } catch (err) { return json({ ok: false, error: String((err as Error)?.message || err).slice(0, 300) }, 500); }
  finally { await sql.end({ timeout: 2 }); }
});
