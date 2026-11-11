// Papa Duck — Edge Function "vinted-sort" v1 (2026-11-11).
// Papa Duck: "can you start building lots based on genre, cd, etc, and put them in their pre-assigned V number so that when I get the cd
// actually processed I will know what bag to put it in" + "when the lot is too big, then add it to another V number".
// POST {"pile": <cleanup_piles.id>} sorts that one item (Book Station Quick check, answer shown right away);
// POST {} sorts every unsorted item in the 🛍️ Vinted box (cron pd-vinted-sort). Auth: x-backup-secret = backup.config cron_secret.
// Claude picks format + genre from a fixed list -> pipeline.vinted_assign puts it in the open bag of that group or starts a new V-number.
import postgres from "npm:postgres@3.4.4";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

const GENRES: Record<string, string[]> = {
  "CDs": ["Country", "Christian & Gospel", "Rock & Pop", "Oldies & Easy Listening", "Jazz & Blues", "Classical", "Holiday", "Kids", "Soundtracks", "Other"],
  "Cassettes": ["Country", "Christian & Gospel", "Rock & Pop", "Oldies & Easy Listening", "Jazz & Blues", "Classical", "Holiday", "Kids", "Audiobooks", "Other"],
  "8-tracks": ["Country", "Christian & Gospel", "Rock & Pop", "Oldies & Easy Listening", "Other"],
  "Vinyl records": ["Country", "Christian & Gospel", "Rock & Pop", "Oldies & Easy Listening", "Jazz & Blues", "Classical", "Holiday", "Kids", "Other"],
  "VHS": ["Family & Kids", "Christian", "Movies", "TV & Other"],
  "DVDs": ["Family & Kids", "Christian", "Movies", "TV & Other"],
  "Books": ["Kids picture books", "Kids chapter books", "Christian", "Fiction", "Cookbooks", "Homeschool & School", "Other"],
};
const guessFmt = (t: string) => /8[- ]?track|stereo 8/i.test(t) ? "8-tracks" : /cassette|\btapes?\b/i.test(t) ? "Cassettes" : /vinyl|\blp\b|record album/i.test(t) ? "Vinyl records"
  : /vhs/i.test(t) ? "VHS" : /dvd|blu-?ray/i.test(t) ? "DVDs" : /\bcds?\b|compact disc/i.test(t) ? "CDs" : "Books";

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const [cfg] = await sql`select value from backup.config where key = 'cron_secret'`;
    if (req.headers.get("x-backup-secret") !== cfg?.value) return json({ ok: false, error: "not allowed" }, 403);
    const b = await req.json().catch(() => ({}));
    const one = Number(b.pile) || 0;
    const rows = one
      ? await sql`select id, title, author, vinted_lot from pipeline.cleanup_piles where id = ${one} and pile = 'VINTED'`
      : await sql`select id, title, author, vinted_lot from pipeline.cleanup_piles where pile = 'VINTED' and vinted_lot is null and vgroup is null order by id limit 25`;
    if (!rows.length) return json({ ok: true, n: 0, bags: [] });
    const todo = rows.filter((r: any) => !r.vinted_lot);
    const groups: Record<number, string> = {};
    if (todo.length) {
      const list = todo.map((r: any) => `${r.id}: ${r.title || "?"}${r.author ? " - " + r.author : ""}`).join("\n");
      const menu = Object.entries(GENRES).map(([f, g]) => `${f}: ${g.join(" | ")}`).join("\n");
      try {
        const ar = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
          headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200, messages: [{ role: "user", content:
`Sort these used items into resale bundles. For each, pick its format and ONE genre exactly as written in this list:
${menu}
A "title - artist" with no format word is usually a CD if it is music. Kids = children's music. Use Other only when nothing fits.
Items:
${list}
Respond ONLY JSON: [{"id":123,"format":"CDs","genre":"Country"}]` }] }) });
        const aj = await ar.json();
        const txt = (aj.content || []).map((x: any) => x.text || "").join("");
        const arr = JSON.parse(txt.slice(txt.indexOf("["), txt.lastIndexOf("]") + 1));
        for (const o of arr) {
          const f = GENRES[o.format] ? o.format : null;
          if (f) groups[Number(o.id)] = `${f} · ${GENRES[f].includes(o.genre) ? o.genre : "Other"}`;
        }
      } catch (_) { /* fall back to format only */ }
    }
    const bags: any[] = [];
    for (const r of rows as any[]) {
      const g = groups[r.id] || `${guessFmt(String(r.title || ""))} · Other`;
      const [x] = await sql`select pipeline.vinted_assign(${r.id}, ${g}) as a`;
      bags.push({ pile: r.id, ...x.a });
    }
    return json({ ok: true, n: bags.length, bags, ...(one ? bags[0] : {}) });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) }, 500);
  } finally { await sql.end({ timeout: 2 }); }
});
