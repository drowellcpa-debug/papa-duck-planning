// Papa Duck — Edge Function "vinted-writer" v2 (2026-11-11; v2 adds his own Drafts answers/grade per item).
// Papa Duck: "when I click set ... can you auto review the pictures, create the full set description based on the items I select".
// POST {"lot": <vinted_lots.id>}  (auth: x-backup-secret = backup.config cron_secret)
// Looks at the lot's photos (up to 16, by URL) and the items' titles, and writes the Vinted listing: title, description (honest condition
// from what the photos show), condition, category, package size. Saves it on the lot. Price is left as it is (his number).
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ ok: false, error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const id = Number(b.lot) || 0;
    const [lot] = await sql`select * from pipeline.vinted_lots where id = ${id}`;
    if (!lot) return json({ ok: false, error: "no such lot" }, 404);
    const items = await sql`select c.id, c.title, c.author, c.isbn, c.list_price,
        (select string_agg(v, '; ') from jsonb_each_text(coalesce(d.answers,'{}'::jsonb)) e(k, v) where k ~ '^[0-9]+$' and v !~* '^(skip|none|one at a time.*)$') said,
        d.ident->>'grade' grade
      from pipeline.cleanup_piles c left join pipeline.drafts d on d.id = c.draft_id where c.id = any(${lot.items})`;
    const photos: string[] = (lot.photos || []).slice(0, 16);
    const [m] = await sql`select value from pipeline.config where key = 'claude_model'`;
    const list = items.map((x: any, i: number) => `${i + 1}. ${x.title || "?"}${x.author ? " - " + x.author : ""}${x.isbn ? " (ISBN/UPC " + x.isbn + ")" : ""}${x.grade ? " [his grade: " + x.grade + "]" : ""}${x.said ? " [he said, with it in hand: " + x.said + "]" : ""}`).join("\n");
    const content: any[] = photos.map((u) => ({ type: "image", source: { type: "url", url: u } }));
    content.push({ type: "text", text:
`You are writing a listing for Papa Duck's PERSONAL Vinted account (US). It is one lot: ${items.length} item(s):
${list}

Look carefully at every photo. Write:
- title: max 90 characters, what buyers search for (e.g. "Lot of 6 Berenstain Bears Kids Books Paperback"). Count and format (books / CDs / cassettes / VHS / DVD).
- description: plain text, friendly and honest, for Vinted. Start with one line saying what the lot is. Then list each item on its own line (title, plus format if useful). Then a short "Condition:" paragraph. It MUST plainly state every problem in the [he said, with it in hand: ...] notes (e.g. "The case is broken.") - he held it, the photos can miss it, and his word wins over the photos. Then add what the photos actually show (e.g. light shelf wear, creased corner, name written inside, sticker residue, cracked CD case). If something can't be seen, don't claim it. For CDs/tapes/records/VHS/DVDs always add: "No visible scratches. Not tested (no player)." unless a photo shows scratches - then say so. End with "Ships together." No phone numbers, web addresses, emails or store names. No emojis. Under 1,500 characters.
- condition: exactly one of "New with tags", "New without tags", "Very good", "Good", "Satisfactory" - the WORST item decides.
- category: Vinted style, e.g. "Entertainment > Books > Kids' books", "Entertainment > Books", "Entertainment > Music > CDs", "Entertainment > Music > Cassettes", "Entertainment > Video > DVDs".
- package: "Small", "Medium" or "Large" by the total size/weight you see (Small ~ 1-2 books, Medium ~ up to 6 books, Large = more).
- photo_notes: one short line of anything he should double-check (or "").
Respond ONLY JSON: {"title":"","description":"","condition":"","category":"","package":"","photo_notes":""}` });
    const ar = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: String(m?.value || "claude-sonnet-4-6"), max_tokens: 1500, messages: [{ role: "user", content }] }) });
    const aj = await ar.json();
    const txt = (aj.content || []).map((x: any) => x.text || "").join("");
    if (!ar.ok || !txt) return json({ ok: false, error: (aj.error && aj.error.message) || "Claude did not answer" }, 502);
    const o = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    const clean = (s: string) => String(s || "").replace(/(https?:\/\/|www\.)\S+/gi, "").replace(/\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, "").trim();
    const conds = ["New with tags", "New without tags", "Very good", "Good", "Satisfactory"], pk = ["Small", "Medium", "Large"];
    await sql`update pipeline.vinted_lots set
      title = ${clean(o.title).slice(0, 100) || lot.title}, description = ${clean(o.description) || lot.description},
      condition = ${conds.includes(o.condition) ? o.condition : lot.condition}, category = ${String(o.category || lot.category)},
      package = ${pk.includes(o.package) ? o.package : lot.package}, notes = ${String(o.photo_notes || "")}, written_at = now()
      where id = ${id}`;
    return json({ ok: true, lot: id, photos: photos.length, notes: o.photo_notes || "" });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
