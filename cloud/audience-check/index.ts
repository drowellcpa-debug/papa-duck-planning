// Papa Duck — Edge Function "audience-check" v3 (v1 2026-10-07 22:05; v2 2026-10-31; v3 2026-11-13).
// Papa Duck: "also nudity or things that would not fly with my audience of family friendly content?" ... "yes please add it very
// important and flag any in the book station right now". Standing Rule #6: a FLAG, not an auto-reject - he decides.
// Every draft gets ident.audience = {ok, level, note, title, checked_at}. A flagged book cannot be Sent (or go to FBA)
// until he presses "OK to list" (answers.audience_ok = "yes") or marks it Don't list.
// v2 (2026-10-31): tea cups and teapots were flagged just for being "not a book". The shop sells non-book items too
//   (china, games, records, collectibles) - being a non-book is never a reason to flag; only the family-friendly test counts.
// v3 (2026-11-13, "yes I agree make this change"): looser - Night, A People's History, To the Finland Station and Cruel Shoes were all
//   flagged. Serious history, classics, school reading, political/economic history from any viewpoint, mild humor and ordinary
//   biographies are fine. Rule of thumb: would a homeschool parent reasonably assign or shelve this for a high schooler?
//   "caution" (unsure) no longer blocks - only a real "flag" needs his OK.
// Cron pd-audience-check every minute (only when a draft has no check yet, or its title changed). Body {all:true} = recheck every open draft.
import postgres from "npm:postgres@3.4.4";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROMPT = `Papa Duck Homeschool is a Christian, family-friendly homeschool shop. It sells mostly books, and ALSO non-book items such as vintage china, teacups, teapots, board games, records and collectibles.
Decide whether this item fits that audience. Use the photos (if any), the title, author, publisher and description, and what you know about it.
BEING A NON-BOOK ITEM IS NEVER A REASON TO FLAG.

Rule of thumb: would a homeschool parent reasonably assign or shelve this for a high schooler? If yes, it is fine.

FLAG it (ok=false, level "flag") ONLY if one of these is clearly true:
- nudity: nude or partly nude people on the cover or inside (art, photography, figure drawing, explicit sex-education images)
- sexual content: erotica, romance with explicit sex scenes, sexually suggestive cover, sexual themes as the focus
- occult, witchcraft, tarot, spells, demonology or New Age/shamanic practice as the main focus (e.g. Carlos Castaneda)
- horror or gore as the main focus; true crime built around graphic detail
- books that glorify drug use
- HEAVY profanity throughout as a feature of the book
These are FINE (ok=true) - do not flag them:
- serious history of any kind, including war, the Holocaust, slavery, genocide and politics (e.g. Night, The Fall of Fortresses)
- classic literature and school reading-list books
- political, economic or social history from any viewpoint (e.g. A People's History of the United States, To the Finland Station)
- mild or absurd humor (e.g. Steve Martin's Cruel Shoes); ordinary biographies and memoirs, including music and rock biographies, unless explicit
- ordinary adult fiction with some mature themes, unless it is known for explicit content
Do not flag just because you are unsure - only flag a clear concern from the list above.

Answer with JSON only: {"ok": true|false, "level": "ok"|"flag", "note": "one short plain sentence: what the concern is, or 'No concerns.'"}`;

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const conf = Object.fromEntries((await sql`select key, value from pipeline.config`).map((r: any) => [r.key, r.value]));
    const model = String(conf.claude_model || "claude-sonnet-4-6");
    const rows = b.all
      ? await sql`select id, pd, ident, pricing, photos from pipeline.drafts where status in ('drafted','sent','fba') and built_at is null and archived_at is null and ident is not null order by id limit ${Number(b.limit || 40)} offset ${Number(b.offset || 0)}`
      : await sql`select id, pd, ident, pricing, photos from pipeline.drafts where status in ('drafted','sent') and built_at is null and ident is not null
          and (ident->'audience' is null or ident->'audience'->>'title' is distinct from ident->>'title') order by id limit 4`;
    if (!rows.length) return json({ ok: true, idle: true });
    const done: unknown[] = [];
    for (const d of rows as any[]) {
      const i = d.ident || {}, p = d.pricing || {};
      const desc = String(p.b2 || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1800);
      const content: any[] = [];
      // up to 3 photos we already hold as base64 (Book Station photos); Drive scans are judged from the text
      const blobs = (d.photos || []).filter((x: any) => !x.removed && String(x.drive_id || "").startsWith("blob:")).slice(0, 3);
      for (const ph of blobs) {
        const key = String(ph.drive_id).slice(5).replace(/[^A-Za-z0-9_.-]/g, "");
        const [r] = await sql`select mime, b64 from pipeline.photo_blobs where key = ${key}`;
        if (r?.b64 && r.b64.length < 6_000_000) content.push({ type: "image", source: { type: "base64", media_type: r.mime || "image/jpeg", data: r.b64 } });
      }
      const kind = i.kind === "item" || String(i.format || "").toLowerCase() === "other" ? "Non-book item (sold in the shop on purpose)" : "Book";
      content.push({ type: "text", text: `Kind: ${kind}\nTitle: ${i.title || ""}\nSubtitle/series: ${i.subtitle_or_series || ""}\nAuthor: ${i.author || ""}\nPublisher: ${i.publisher || ""}\nYear: ${i.publication_year || ""}\nSubject: ${i.genre_or_subject || ""}\nListing title: ${p.ebay_title || ""}\nDescription: ${desc}\n\n${PROMPT}` });
      let out: any = null, err = "";
      for (let a = 1; a <= 3 && !out; a++) {
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
          headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: "user", content }] }) });
        const j = await r.json();
        if (r.ok) {
          const raw = (j.content || []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").replace(/```json|```/g, "");
          try { out = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { err = "answer was not JSON"; }
        } else { err = `${r.status} ${JSON.stringify(j).slice(0, 150)}`; if (r.status === 429 || r.status >= 500) await sleep(3000 * a); else break; }
      }
      if (!out) { done.push({ pd: d.pd, id: d.id, error: err }); continue; }
      // safety net: a flag whose only reason is "not a book" is not a flag
      if (out.ok !== true && /not a book|non-book|book shop|bookshop/i.test(String(out.note || "")) && !/nud|sex|violen|gore|occult|witch|tarot|horror|profan|drug|alcohol|crude/i.test(String(out.note || ""))) {
        out = { ok: true, level: "ok", note: "No concerns." };
      }
      // v3: only a real flag blocks; an unsure "caution" does not
      const ok = !(out.ok === false && out.level !== "ok" && out.level !== "caution");
      const aud = { ok, level: ok ? "ok" : "flag", note: String(out.note || "").slice(0, 300),
        title: i.title || "", checked_at: new Date().toISOString(), photos: content.length - 1 };
      await sql`update pipeline.drafts set ident = jsonb_set(coalesce(ident, '{}'::jsonb), '{audience}', ${sql.json(aud as any)}::jsonb) where id = ${d.id}`;
      done.push({ id: d.id, pd: d.pd, title: i.title, ...aud });
    }
    return json({ ok: true, done });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
