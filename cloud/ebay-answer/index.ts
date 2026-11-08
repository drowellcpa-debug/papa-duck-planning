// v6 (2026-11-08): a reply sent with reply_to stays on the Launch Pad (📨) until Papa Duck taps Read.
// v5 (2026-11-08): Papa Duck: "I am not going to grab books from the storage to make more pictures". The listing PHOTOS go to Claude with the
//   question, so contents/condition questions are answered from what the photos show; if they do not show it, an honest "all I have is in the
//   photos and description" + no-hassle returns is SENT. Held only for problems (refund, damage, cancel, address, legal, anything odd).
// v4 (2026-11-06): {"reply_to":{message_id,reply}} sends a checked reply to a held message.
// Papa Duck - Edge Function "ebay-answer" v3 (2026-11-06; v2: never states copies in stock; test mode; v3: no local pickup, no extra photos - answered automatically). Papa Duck: "Can you look at my response and respond in similar way automatically.
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
function b64(buf: Uint8Array): string { let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); }
// the listing photos for Claude (v5) - a photo that will not load is skipped
async function photoParts(urls: string[]) {
  const out: any[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await fetch(urls[i], { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length < 2000 || buf.length > 4_500_000) continue;
      out.push({ type: "text", text: `Photo ${i + 1}` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64(buf) } });
    } catch (_) { /* skip */ }
  }
  return out;
}

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
- FACTS about the book come ONLY from the listing below AND ITS PHOTOS (attached, in listing order). Look at the photos carefully (contents
  pages, credits/acknowledgments, copyright page, covers) and answer from what they clearly show. Say "from my photos" and hedge ("I don't see...")
  when a page is only partly shown. NEVER guess beyond what the listing and photos show.
- Papa Duck does NOT go back to storage to check books or take more photos (2026-11-08). If neither the listing nor the photos answer it, say kindly
  that everything he has on it is in the photos and description, and mention no-hassle returns - "send".
- LOCAL PICKUP (Papa Duck 2026-11-06: "No local pickups"): kindly say he doesn't offer local pickup, everything ships through eBay - "send".
- PHOTO REQUESTS (Papa Duck 2026-11-06: no extra photos): kindly say all the photos are in the listing; answer what they want to see from the listing
  text if it says (e.g. spine, cover, contents), and remind them of no-hassle returns - "send". Never promise to take or add photos.
- Never say how many copies are in stock or that more are available (his rule CR) - "Yes, it's still available!" is enough.
- Never mention AI, Claude, or that the reply is automatic.
DECIDE action:
- "send": you can fully and truthfully answer from his rules and the listing (offers, availability, bundles/combined shipping, returns policy,
  shipping method/speed in general terms, contents/condition/edition questions - answered from the listing and photos, or honestly
  "that's all I have in the photos and description" + no-hassle returns).
- "hold": ONLY things only he can decide: address change, cancel requests, item not received / late, damaged / not as described / refund / return problems,
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
    // v4: send a reply to a HELD message, after Papa Duck / Claude checked it ({"reply_to":{"message_id":"...","reply":"..."}})
    if (b.reply_to) {
      const [row] = await sql`select * from pipeline.ebay_msgs where message_id = ${String(b.reply_to.message_id)}`;
      if (!row) return json({ ok: false, error: "no such held message" }, 404);
      if (row.sent_ok) return json({ ok: false, error: "already answered" }, 409);
      const reply = String(b.reply_to.reply || "").trim().slice(0, 1900);
      const s = await trade("AddMemberMessageRTQ", `<ItemID>${row.item_id}</ItemID><MemberMessage><Body>${xesc(reply)}</Body><DisplayToPublic>false</DisplayToPublic><EmailCopyToSender>true</EmailCopyToSender><ParentMessageID>${row.message_id}</ParentMessageID><RecipientID>${xesc(row.sender)}</RecipientID></MemberMessage>`);
      const ok = /<Ack>(Success|Warning)/.test(s);
      if (!ok) return json({ ok: false, error: pick(s, "LongMessage").slice(0, 300) }, 502);
      await sql`update pipeline.ebay_msgs set action = 'send', reply = ${reply}, sent_ok = true, why = ${"answered after checking the photos - " + (row.why || "")}, handled_at = now() where message_id = ${row.message_id}`;
      await sql`update pipeline.alerts set kind = 'handled', title = ${"Answered " + row.sender + " (checked photos)"}, detail = ${"THEY ASKED: " + String(row.question).slice(0, 600) + "\n\nI REPLIED: " + reply}, done_at = null where dedupe = ${"ebaymsg:" + row.message_id}`;
      return json({ ok: true, sent: true });
    }
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
      let pics: string[] = [];
      if (itemId) {
        const g = await trade("GetItem", `<ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>`);
        const desc = un(pick(g, "Description")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000);
        const specs = [...g.matchAll(/<NameValueList><Name>([^<]*)<\/Name><Value>([^<]*)<\/Value>/g)].map((s) => `${un(s[1])}: ${un(s[2])}`).slice(0, 25);
        pics = [...g.matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)].map((x) => un(x[1]).split("?")[0].replace(/\$_\d+\./, "$_57.")).slice(0, 8);
        listing = { title: un(pick(g, "Title")) || title, sku: pick(g, "SKU"), price: pick(g, "CurrentPrice"), status: pick(g, "ListingStatus"),
          quantity_left: Number(pick(g, "Quantity") || 0) - Number(pick(g, "QuantitySold") || 0), best_offer: /<BestOfferEnabled>true/.test(g),
          condition: pick(g, "ConditionDisplayName"), condition_notes: un(pick(g, "ConditionDescription")), specifics: specs, description: desc,
          sale: typ === "ContactTransactionPartner" ? "this buyer already bought it" : "" };
      }
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: [
          ...(await photoParts(pics)),
          { type: "text", text: `${VOICE}\n\nTHE LISTING (photos above, in listing order):\n${JSON.stringify(listing)}\n\nBUYER (${sender}) WROTE (${typ}):\n"""${body}"""` }] }] }) });
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
