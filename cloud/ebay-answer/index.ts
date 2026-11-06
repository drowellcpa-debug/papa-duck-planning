// Papa Duck - Edge Function "ebay-answer" v2 (2026-11-06; v2: never states copies in stock; test mode). Papa Duck: "Can you look at my response and respond in similar way automatically.
//   If they ask me for an offer I only accept in ebay offer area. I offer no hassle returns." + "Yes all of it please handle for me and just put
//   in launch pad question asked and your response".
// Every 15 min (cron pd-ebay-answer): reads new eBay buyer messages (GetMemberMessages, unanswered), looks up the listing, and Claude writes a short
// warm reply in his voice. SENT automatically (AddMemberMessageRTQ) and logged on the Launch Pad (kind 'handled': question + reply).
// Held for him (Launch Pad 'question' with a ready reply, NOT sent) when the answer needs the book in hand or a decision only he can make:
//   condition/contents the listing doesn't state, photo requests, local pickup, address changes, cancellations, damage/refund/return problems,
//   publisher/legal messages. Plain "thanks"/"👍" messages get no reply. Never agrees a price, never free shipping, never moves a sale off eBay.
// POST {} (cron) or {"dry":true} to see what it would do. Auth: x-backup-secret. Log: pipeline.ebay_msgs.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const un = (s: string) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#xd;/g, "").replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"');
const xesc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const VOICE = `You answer eBay buyer messages for Papa Duck Homeschool (Dawayne, a Christian homeschool dad in Gresham, Oregon who sells used books).
His voice: warm, friendly, short, plain words, a little folksy (he writes things like "Sure glad it's going to a good home::)" and "Let me know if
damaged, I'm new at mailing records. If any damage I will refund fully plus shipping."). 1-4 short sentences. Sign off "- Dawayne" (optionally a 🦆).
HIS RULES (never break):
- OFFERS / "will you take $X" / "best price" / discounts: he only accepts offers through eBay's Make Offer button. Never agree, counter or name a price
  in the message. Kindly ask them to send it through Make Offer and he'll take a look. (If the listing has no Best Offer, say the price is firm.)
- He offers NO-HASSLE RETURNS - mention it when it helps a buyer decide (offers, condition worries, "is it the right edition" doubts).
- BUNDLES / several books / combined shipping: he's glad to combine shipping - add the books to the cart and use "Request total", or send an offer on
  each through Make Offer; he combines shipping on multiple books.
- Never offer free shipping. Never move a sale off eBay (no Vinted, PayPal, email, phone, other sites) - "I sell through eBay only". No links, emails or phone numbers.
- FACTS about the book come ONLY from the listing below. If the listing clearly answers it, answer plainly. If the listing does not say, NEVER guess.
- Never say how many copies are in stock or that more are available (his rule CR) - "Yes, it's still available!" is enough.
- Never mention AI, Claude, or that the reply is automatic.
DECIDE action:
- "send": you can fully and truthfully answer from his rules and the listing (offers, availability, bundles/combined shipping, returns policy,
  shipping method/speed in general terms, questions the listing clearly answers).
- "hold": anything that needs him or the book in hand: condition/contents/edition details the listing doesn't state, photo requests, measurements not
  in the listing, local pickup, address change, cancel requests, item not received / late, damaged / not as described / refund / return problems,
  publisher, copyright or legal messages, anything odd. Still write the reply you would suggest (he will check it), and say in "why" what he must do.
- "skip": the buyer only says thanks / ok / 👍 / confirms - no reply needed.
Respond with ONLY JSON: {"action":"send|hold|skip","reply":"","why":"short reason"}`;

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  const out: any = { seen: 0, sent: 0, held: 0, skipped: 0, items: [] as any[] };
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const dry = !!b.dry;
    await sql`create table if not exists pipeline.ebay_msgs (message_id text primary key, item_id text, sender text, kind text, question text,
      action text, reply text, why text, sent_ok boolean, error text, created_at timestamptz, handled_at timestamptz default now())`;
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    const model = conf.claude_model || "claude-sonnet-4-6";
    const e = JSON.parse((await sql`select decrypted_secret from vault.decrypted_secrets where name = 'papaduck_keys'`)[0].decrypted_secret).ebay;
    const trade = async (name: string, inner: string) => (await (await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-CALL-NAME": name, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-APP-NAME": e.app_id, "X-EBAY-API-DEV-NAME": e.dev_id, "X-EBAY-API-CERT-NAME": e.cert_id, "Content-Type": "text/xml" },
      body: `<?xml version="1.0" encoding="utf-8"?><${name}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${xesc(e.auth_token)}</eBayAuthToken></RequesterCredentials>${inner}</${name}Request>` })).text());
    const pick = (x: string, t: string) => (x.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
    const since = new Date(Date.now() - Number(b.hours || 36) * 3600e3).toISOString();
    const x = await trade("GetMemberMessages", `<MailMessageType>All</MailMessageType><MessageStatus>Unanswered</MessageStatus><StartCreationTime>${since}</StartCreationTime><EndCreationTime>${new Date().toISOString()}</EndCreationTime><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>`);
    if (!/<Ack>(Success|Warning)/.test(x)) throw new Error("eBay messages: " + (pick(x, "LongMessage") || x.slice(0, 200)));
    let ex = [...x.matchAll(/<MemberMessageExchange>([\s\S]*?)<\/MemberMessageExchange>/g)].map((m) => m[1]);
    // test mode: {"test":{"item_id":"...","body":"..."}} - classify a made-up question against a real listing (never sent, never saved)
    if (b.test) ex = (Array.isArray(b.test) ? b.test : [b.test]).map((t: any, i: number) => `<Item><ItemID>${t.item_id}</ItemID></Item><Question><MessageType>AskSellerQuestion</MessageType><SenderID>testbuyer</SenderID><Body>${xesc(String(t.body))}</Body><MessageID>TEST${Date.now()}${i}</MessageID></Question>`);
    const dryRun = dry || !!b.test;
    for (const m of ex) {
      const q = pick(m, "Question"), mid = pick(q, "MessageID"), typ = pick(q, "MessageType");
      if (!mid || !/AskSellerQuestion|ResponseToASQQuestion|ContactTransactionPartner/.test(typ)) continue;
      const [done] = await sql`select 1 from pipeline.ebay_msgs where message_id = ${mid}`;
      if (done) continue;
      out.seen++;
      const it = pick(m, "Item"), itemId = pick(it, "ItemID"), sender = pick(q, "SenderID"), body = un(pick(q, "Body")).slice(0, 2500), title = un(pick(it, "Title"));
      const created = pick(m, "CreationDate") || new Date().toISOString();
      // the listing, so facts come only from it
      let listing: any = { title, price: pick(it, "CurrentPrice"), condition: pick(it, "ConditionDisplayName") };
      if (itemId) {
        const g = await trade("GetItem", `<ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>`);
        const desc = un(pick(g, "Description")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000);
        const specs = [...g.matchAll(/<NameValueList><Name>([^<]*)<\/Name><Value>([^<]*)<\/Value>/g)].map((s) => `${un(s[1])}: ${un(s[2])}`).slice(0, 25);
        listing = { title: un(pick(g, "Title")) || title, sku: pick(g, "SKU"), price: pick(g, "CurrentPrice"), status: pick(g, "ListingStatus"),
          quantity_left: Number(pick(g, "Quantity") || 0) - Number(pick(g, "QuantitySold") || 0), best_offer: /<BestOfferEnabled>true/.test(g),
          condition: pick(g, "ConditionDisplayName"), condition_notes: un(pick(g, "ConditionDescription")), specifics: specs, description: desc,
          sale: typ === "ContactTransactionPartner" ? "this buyer already bought it" : "" };
      }
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: "user", content:
          `${VOICE}\n\nTHE LISTING:\n${JSON.stringify(listing)}\n\nBUYER (${sender}) WROTE (${typ}):\n"""${body}"""` }] }) });
      const j = await r.json().catch(() => ({}));
      const raw = (j.content || []).map((c: any) => c.text || "").join("").replace(/```json|```/g, "");
      let d: any = {};
      try { d = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { d = { action: "hold", reply: "", why: "could not write a reply" }; }
      let action = String(d.action || "hold"), reply = String(d.reply || "").trim().slice(0, 1900), why = String(d.why || "").slice(0, 300);
      // hard guards on top of Claude's call
      if (action === "send" && (!reply || /\$\s?\d/.test(reply) && !/make offer/i.test(reply) || /free shipping|vinted|paypal|@|https?:|www\.|\b(\d+|two|three|four|five|several|multiple) (copies|in stock)|copies (in stock|available)/i.test(reply))) { action = "hold"; why = "safety check: " + why; }
      if (/refund|damag|broken|not received|never (arrived|got)|cancel|wrong (book|item|edition)|address|copyright|attorney|legal|unauthori[sz]ed/i.test(body) && action === "send") { action = "hold"; why = "needs you: " + why; }
      let sentOk: boolean | null = null, err = "";
      if (action === "send" && !dryRun) {
        const s = await trade("AddMemberMessageRTQ", `<ItemID>${itemId}</ItemID><MemberMessage><Body>${xesc(reply)}</Body><DisplayToPublic>false</DisplayToPublic><EmailCopyToSender>true</EmailCopyToSender><ParentMessageID>${mid}</ParentMessageID><RecipientID>${xesc(sender)}</RecipientID></MemberMessage>`);
        sentOk = /<Ack>(Success|Warning)/.test(s);
        if (!sentOk) { err = pick(s, "LongMessage").slice(0, 200); action = "hold"; why = "eBay would not send it (" + err + ") - " + why; }
      }
      if (!dryRun) {
        await sql`insert into pipeline.ebay_msgs (message_id, item_id, sender, kind, question, action, reply, why, sent_ok, error, created_at)
          values (${mid}, ${itemId}, ${sender}, ${typ}, ${body}, ${action}, ${reply}, ${why}, ${sentOk}, ${err || null}, ${created}) on conflict (message_id) do nothing`;
        const pd = /^PD-/i.test(listing.sku || "") ? String(listing.sku).toUpperCase() : null, short = String(listing.title || title).slice(0, 55);
        if (action === "send") await sql`select pipeline.alert_add('eBay message', ${"Answered " + sender + ": " + short}, ${"THEY ASKED: " + body.slice(0, 600) + "\n\nI REPLIED: " + reply}, ${pd}, ${"https://www.ebay.com/itm/" + itemId}, 'handled', ${"ebaymsg:" + mid})`;
        if (action === "hold") await sql`select pipeline.alert_add('eBay message', ${"Needs you - " + sender + ": " + short}, ${"THEY ASKED: " + body.slice(0, 600) + "\n\nWHY IT'S YOURS: " + why + (reply ? "\n\nSUGGESTED REPLY (not sent): " + reply : "")}, ${pd}, ${"https://www.ebay.com/mesh/ord"}, 'question', ${"ebaymsg:" + mid})`;
      }
      out[action === "send" ? "sent" : action === "skip" ? "skipped" : "held"]++;
      out.items.push({ mid, sender, item: String(listing.title || "").slice(0, 50), q: body.slice(0, 160), action, reply, why });
    }
    return json({ ok: true, dry, ...out });
  } catch (er) {
    return json({ ok: false, error: String((er as Error).message || er).slice(0, 400), ...out }, 500);
  } finally { await sql.end({ timeout: 3 }); }
});
