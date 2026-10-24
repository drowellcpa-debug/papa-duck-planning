// Papa Duck — launch-meta (v2, 2026-10-24). v2: 4 batches at a time, answers kept in pipeline.launch_meta_stage,
// and a run that nears the time limit hands off to a fresh run (net.http_post) instead of being cut off.
// Grandpa Duck writes each book's listing details for a Launch Pad night
// (store, eBay genre/topic/narrative, language, AbeBooks keywords, Etsy taxonomy + 5 specific tags), the same fields
// Claude wrote by hand in blastoff/meta-10242026.py. Code checks every field, fills Etsy tags to 13 from the
// category pool, writes pipeline.blast_meta for the night, then runs pipeline.launch_build_files(night_id).
// POST {night_id, no_build?}  Auth: x-backup-secret = backup.config.cron_secret. Secret: ANTHROPIC_API_KEY.
import postgres from "npm:postgres@3.4.4";

const STORES: Record<string, [string, string]> = {
  CL: ["Classic Literature", "49462313018"], GN: ["General Interest & Nonfiction", "49462318018"],
  OR: ["Oregon & Pacific NW History", "49462311018"], CH: ["Children's & Early Readers", "49462317018"],
  XN: ["Orthodox & Christian Books", "49462312018"], VA: ["Vintage & Antique Books", "49462316018"],
  HS: ["Homeschool", "49462310018"], CT: ["College Textbooks", "49462314018"],
};
const ETSY: Record<string, string> = {   // taxonomy -> shop section (as used on the 10/22 and 10/24 runs)
  "347": "Fiction & Literature", "349": "Fiction & Literature", "324": "Vintage Collectibles", "335": "Vintage Collectibles",
  "345": "History & Geography", "338": "Children's Books", "351": "Bibles", "350": "Textbooks & Study", "372": "Sheet Music",
};
const POOL: Record<string, string[]> = {
  "347": ["vintage book", "classic novel", "old book", "book lover gift", "literary fiction", "reading copy", "bookshelf decor", "collectible book", "used book", "hardcover book"],
  "349": ["poetry book", "vintage book", "old book", "book lover gift", "poetry lover gift", "collectible book", "used book", "reading copy", "bookshelf decor", "gift for reader"],
  "324": ["vintage book", "old book", "collectible book", "book lover gift", "bookshelf decor", "used book", "retro book", "vintage find", "gift for reader", "reading gift"],
  "345": ["vintage book", "history book", "old book", "collectible book", "book lover gift", "used book", "nonfiction book", "gift for reader", "history lover gift", "reference book"],
  "338": ["vintage childrens", "kids book", "read aloud", "childrens book", "old book", "bedtime story", "gift for kids", "vintage book", "classic story", "collectible book"],
  "372": ["vintage music", "music book", "songbook", "sheet music", "musician gift", "piano music", "old music book", "music lover gift", "vintage songbook", "music teacher gift"],
  "351": ["christian book", "church gift", "bible study", "faith gift", "gift for pastor", "religious book", "scripture", "old book", "book lover gift", "used book"],
  "335": ["art book", "art history", "vintage book", "art lover gift", "coffee table book", "art reference", "old book", "book lover gift", "art student gift", "used book"],
  "350": ["vintage textbook", "school book", "old textbook", "vintage book", "homeschool", "teacher gift", "old book", "collectible book", "used book", "book lover gift"],
};
const BAN = /(piracy|pirated|bootleg|counterfeit|unauthori|hologram|photocop|pdf|download|free online)/;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function whenMade(y: number | null): string {
  if (!y) return "before_2007";
  if (y >= 2007) return "";            // not vintage: never on Etsy
  if (y >= 2000) return "2000_2006";
  if (y >= 1900) return `${Math.floor(y / 10) * 10}s`;
  if (y >= 1800) return "1800s";
  if (y >= 1700) return "1700s";
  return "before_1700";
}
function tags(tax: string, spec: string[]): string[] {
  const out: string[] = [];
  for (const raw of [...(spec || []), ...(POOL[tax] || POOL["324"])]) {
    const t = String(raw || "").toLowerCase().trim().replace(/\s+/g, " ");
    if (t && !out.includes(t) && t.length <= 20 && /^[a-z0-9 '\-]+$/.test(t) && !BAN.test(t)) out.push(t);
    if (out.length === 13) break;
  }
  return out;
}
function plain(h: string): string {
  return String(h || "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 700);
}

function prompt(books: any[]): string {
  return `You are Grandpa Duck, writing listing details for Papa Duck Homeschool, a family-friendly used-book seller in Gresham, Oregon.
For EACH book below return one JSON object. Reply with ONLY a JSON array, no prose.

Fields:
- "pd": the book's PD number, copied exactly.
- "store": one code. CL = classic literature, fiction, literary criticism and literary biography; GN = general nonfiction (crafts, hobbies, coloring books, language learning, dictionaries, reference, music, art, history, science, military); OR = Oregon or Pacific Northwest subjects; CH = children's and young readers' books; XN = Bibles, Christian and Orthodox books; VA = antique books printed before 1900 that fit nowhere else; HS = K-12 school textbooks and homeschool curriculum; CT = college textbooks and academic texts.
- "genre": the eBay Genre, short (e.g. "Literature & Fiction", "History", "Crafts & Hobbies", "Language Learning", "Religion & Spirituality", "Science & Nature", "Reference", "Biographies & Memoirs", "Art", "Music", "Children & Young Adults", "Textbooks, Education & Reference").
- "topic": a short specific eBay Topic (e.g. "Railroads", "Origami", "Russian Literature", "Bibles").
- "narrative": "Fiction" or "Nonfiction".
- "lang": the language the book is written in, in English (e.g. "English", "German", "Russian").
- "keywords": AbeBooks keywords, 5 to 9 comma-separated lowercase phrases: author, title words, publisher or series, subject, era. Plain letters, no prices, no "rare", under 400 characters.
- "etsy_tax": ONLY when "etsy" is true for the book, one of: "347" fiction and literature, "349" poetry, "345" history and geography (including railroads, war and travel history), "338" children's books, "351" Bibles and Christian, "335" art books, "350" textbooks and school books, "372" sheet music and songbooks, "324" everything else (crafts, coloring, language, reference). Otherwise null.
- "tags": ONLY when "etsy" is true, exactly 5 Etsy tags specific to THIS book (author name, title words, subject, publisher or series). Each lowercase, 20 characters or fewer, letters, numbers, spaces, apostrophes and hyphens only. Otherwise [].

Base everything on the facts given. Do not invent awards, editions or signatures.

Books:
${JSON.stringify(books, null, 1)}`;
}

async function askClaude(text: string, model: string): Promise<any[]> {
  for (let a = 1; a <= 4; a++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 6000, messages: [{ role: "user", content: text }] }) });
    if (r.status === 429 || r.status >= 500) { await sleep(a * 4000); continue; }
    const t = await r.text();
    if (!r.ok) throw new Error(`Claude ${r.status}: ${t.slice(0, 300)}`);
    const out = (JSON.parse(t).content || []).map((c: any) => c.text || "").join("");
    const m = out.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("Grandpa Duck did not return a list: " + out.slice(0, 200));
    return JSON.parse(m[0]);
  }
  throw new Error("Claude kept saying busy");
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  let nid = 0;
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (!cfg || req.headers.get("x-backup-secret") !== cfg.value) return json({ error: "not allowed" }, 403);
    const body = await req.json();
    nid = Number(body.night_id);
    const [n] = await sql`select * from pipeline.launch_nights where id = ${nid}`;
    if (!n) return json({ ok: false, error: "no such night" }, 400);
    const [m] = await sql`select value from pipeline.config where key = 'claude_model'`;
    const model = (m && m.value) || "claude-sonnet-4-6";
    await sql`update pipeline.launch_nights set meta_status = 'writing', updated_at = now() where id = ${nid}`;

    const rows = await sql`
      select distinct on (d.pd) d.pd, d.ident, d.pricing->>'ebay_title' as ebay_title, d.pricing->>'b2' as b2, coalesce(d.etsy,false) as etsy, pipeline.etsy_year(d) as etsy_year
        from pipeline.drafts d
       where d.pd = any(${n.pds}) and d.status = 'sent'
         and d.pd not in (select pd from pipeline.launch_reconsider where night_id = ${nid} and answer in ('hold','dont_list'))
       order by d.pd, d.id desc`;
    const books = rows.map((r: any) => {
      const i = r.ident || {};
      return { pd: r.pd, etsy: !!r.etsy, title: i.title, subtitle: i.subtitle_or_series, author: i.author, publisher: i.publisher,
        year: i.publication_year, format: i.format, subject: i.genre_or_subject, edition: i.edition_printing,
        ebay_title: r.ebay_title, description: plain(r.b2) };
    });
    const done = new Set((await sql`select pd from pipeline.launch_meta_stage where night_id = ${nid}`).map((x: any) => x.pd));
    const todo = books.filter((b: any) => !done.has(b.pd));
    const t0 = Date.now();
    for (let k = 0; k < todo.length; k += 28) {
      if (Date.now() - t0 > 70000) {   // hand off to a fresh run before the edge time limit
        await sql`select net.http_post(url := 'https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/launch-meta',
          headers := jsonb_build_object('Content-Type','application/json','x-backup-secret',(select value from backup.config where key='cron_secret')),
          body := ${sql.json({ night_id: nid, no_build: !!body.no_build })}::jsonb, timeout_milliseconds := 300000)`;
        return json({ ok: true, continued: true });
      }
      const chunk = todo.slice(k, k + 28);
      const parts: any[][] = [];
      for (let j = 0; j < chunk.length; j += 7) parts.push(chunk.slice(j, j + 7));
      const outs = await Promise.all(parts.map(async (part) => {
        for (let t = 1; t <= 2; t++) { try { return await askClaude(prompt(part), model); } catch (e) { if (t === 2) throw e; } }
        return [];
      }));
      for (const ans of outs) for (const a of ans) if (a && a.pd && books.some((b: any) => b.pd === String(a.pd).trim()))
        await sql`insert into pipeline.launch_meta_stage(night_id, pd, a) values (${nid}, ${String(a.pd).trim()}, ${sql.json(a)})
                  on conflict (night_id, pd) do update set a = excluded.a`;
      const [c] = await sql`select count(*)::int n from pipeline.launch_meta_stage where night_id = ${nid}`;
      await sql`update pipeline.launch_nights set meta_note = ${`Grandpa Duck wrote ${c.n} of ${books.length}`}, updated_at = now() where id = ${nid}`;
    }
    const got: Record<string, any> = {};
    for (const x of await sql`select pd, a from pipeline.launch_meta_stage where night_id = ${nid}`) got[x.pd] = x.a;

    const problems: string[] = [];
    const metas: any[] = [];
    for (const r of rows as any[]) {
      const a = got[r.pd]; const i = r.ident || {};
      if (!a) { problems.push(`${r.pd}: no details written`); continue; }
      const st = STORES[String(a.store || "").toUpperCase()] ? String(a.store).toUpperCase() : "GN";
      const yr = (String(i.publication_year || "").match(/(1[5-9]\d\d|20\d\d)/) || [""])[0];
      const text = [i.edition_printing, i.special_features, i.condition_notes].join(" ").toLowerCase();
      const meta: any = {
        store_name: STORES[st][0], store_id: STORES[st][1], genre: String(a.genre || "Books").slice(0, 60), topic: String(a.topic || i.genre_or_subject || "General").slice(0, 60),
        narrative: /^fic/i.test(a.narrative || "") ? "Fiction" : "Nonfiction", year: yr, lang: String(a.lang || "English").slice(0, 30),
        keywords: String(a.keywords || "").toLowerCase().replace(/[^a-z0-9 ,'&\-]/g, "").slice(0, 450),
        exlib: /^yes/i.test(String(i.ex_library || "")), signed: /\bsigned\b|\binscribed by the author\b/.test(text) && !/\bnot signed\b/.test(text),
      };
      if (!meta.keywords) problems.push(`${r.pd}: no keywords`);
      if (r.etsy) {
        const tax = ETSY[String(a.etsy_tax)] ? String(a.etsy_tax) : "324";
        const wm = whenMade(r.etsy_year);
        const tg = tags(tax, a.tags || []);
        if (!wm) problems.push(`${r.pd}: Etsy is on but the book is under 20 years old`);
        else if (tg.length !== 13) problems.push(`${r.pd}: only ${tg.length} Etsy tags`);
        else Object.assign(meta, { etsy_tax: tax, etsy_section: ETSY[tax], when_made: wm, tags: tg });
      }
      metas.push({ pd: r.pd, m: meta });
    }
    await sql`delete from pipeline.blast_meta where night = ${n.night}`;
    for (const x of metas) await sql`insert into pipeline.blast_meta(night, pd, m) values (${n.night}, ${x.pd}, ${sql.json(x.m)})`;
    await sql`update pipeline.launch_nights set meta_status = ${problems.length ? "written_with_notes" : "written"},
      meta_note = ${problems.length ? problems.join(" · ") : `Listing details written for ${metas.length} books`}, updated_at = now() where id = ${nid}`;

    let build: any = null;
    if (!body.no_build) {
      const [b] = await sql`select pipeline.launch_build_files(${nid}) as r`;
      build = b.r;
      if (!build?.ok) await sql`update pipeline.launch_nights set status = 'build_failed', meta_note = ${build?.error || "build failed"} where id = ${nid}`;
    }
    return json({ ok: true, written: metas.length, problems, build });
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 600);
    if (nid) { try { await sql`update pipeline.launch_nights set status = 'build_failed', meta_status = 'failed', meta_note = ${msg}, updated_at = now() where id = ${nid}`; } catch (_) {} }
    return json({ ok: false, error: msg }, 500);
  } finally { await sql.end({ timeout: 5 }); }
});
