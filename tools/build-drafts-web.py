#!/usr/bin/env python3
"""Build drafts.html (Netlify, no claude.ai connector) from drafts-v62.html (the claude.ai artifact).
2026-11-15 Papa Duck: "can we move this to the new way quickly?" (Launch Pad todo 88).
The page is the same; only the transport changes: SQL goes to the drafts-api edge function (passcode-protected,
fixed query shapes only), Book Station photos load straight from their public storage address.
Run: python3 tools/build-drafts-web.py   (re-run after every drafts-v62.html change)."""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
s = (root / "drafts-v62.html").read_text()

def rep(old, new, count=1):
    global s
    if s.count(old) != count:
        sys.exit(f"build-drafts-web: expected {count} of: {old[:80]!r}, found {s.count(old)}")
    s = s.replace(old, new)

# 1) SQL goes straight to drafts-api
rep('''      const r = await mcp.callTool(SUPA, "execute_sql", { project_id: PROJECT, query }, { cache: false });
      const raw = JSON.stringify((r && (r.payload ?? r)) || "");
      if (SQL_RETRY.test(raw) && /look up the project organization/i.test(raw)) throw new Error("Failed to look up the project organization");
      return sqlRows(r);''',
'''      return await webSql(query);''')

# 2) Book Station photos: public storage address (no connector, no database read)
rep('''  if (pid.indexOf("blob:") === 0) {   // Book Station photo — a copy is kept in the database for this page''',
'''  if (/^https:\\/\\/[a-z0-9]+\\.supabase\\.co\\/storage\\/v1\\/object\\/public\\//.test(String(p.url || ""))) {
    photoCache[pid] = String(p.url);
    if (!quiet && view.mode === "detail" && current()) renderDetail(current());
    return;
  }
  if (pid.indexOf("blob:") === 0) {   // Book Station photo — a copy is kept in the database for this page''')
rep('''      const r = await mcp.callTool(SUPA, "execute_sql", { project_id: PROJECT, query: "select mime, b64 from pipeline.photo_blobs where key = '" + key + "'" },
        { cache: { staleTime: 3600000, gcTime: 86400000 } });
      const row = sqlRows(r)[0];''',
'''      const row = await webPhoto(key);''')
# Google Drive photos (old drafts) can't be read without the connector
rep('''    const r = await mcp.callTool(DRIVE, "download_file_content", { fileId: p.drive_id }, { cache: { staleTime: 300000, gcTime: 86400000 } });''',
'''    const r = null; throw Object.assign(new Error("Google Drive photo - open the Claude version of Drafts to see it"), { code: "tool_error" });''')

# 3) start-up: passcode instead of the connector
rep('''  try { mcp = await window.claude.use("mcp"); } catch (_) { mcp = null; }''',
'''  mcp = { web: true };
  if (!webPass()) { await askPass(); }''')

# 4) the web transport itself (inserted before sql())
rep('''async function sql(query){''', '''// ---------- web transport (drafts.html on Netlify) ----------
const DAPI = "https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/drafts-api";
const PASS_KEY = "pdStationPass";   // same passcode / PIN the Book Station and Sorting Helper use on this site
function webPass(){ try { return localStorage.getItem(PASS_KEY) || ""; } catch (e) { return ""; } }
function askPass(msg){
  return new Promise((done) => {
    const w = document.createElement("div");
    w.style.cssText = "position:fixed;inset:0;z-index:99;background:rgba(0,0,0,.45);display:grid;place-items:center;padding:16px";
    w.innerHTML = '<form style="background:#fff;border-radius:14px;padding:18px;max-width:340px;width:100%;display:grid;gap:10px;font-family:inherit">' +
      '<b style="font-size:1.1rem">🦆 Papa Duck Drafts</b><span>' + (msg || "Type your Book Station passcode or PIN.") + '</span>' +
      '<input id="pdpass" type="password" inputmode="numeric" autocomplete="current-password" style="font-size:1.2rem;padding:10px;border:2px solid #ccc;border-radius:10px">' +
      '<button style="font-size:1.05rem;padding:10px;border:0;border-radius:10px;background:#1E5B43;color:#fff;font-weight:700">Open Drafts</button></form>';
    document.body.appendChild(w);
    const f = w.querySelector("form"); w.querySelector("#pdpass").focus();
    f.onsubmit = (e) => { e.preventDefault(); const v = w.querySelector("#pdpass").value.trim(); if (!v) return;
      try { localStorage.setItem(PASS_KEY, v); } catch (_) {} w.remove(); done(v); };
  });
}
async function webCall(body){
  const r = await fetch(DAPI, { method: "POST", headers: { "content-type": "application/json", "x-station-pass": webPass() }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) {}
  if (r.status === 403 || (j && j.error === "bad_passcode")) {
    try { localStorage.removeItem(PASS_KEY); } catch (_) {}
    await askPass("That passcode didn't work. Type your Book Station passcode or PIN.");
    return webCall(body);
  }
  if (!r.ok || !j || !j.ok) throw Object.assign(new Error((j && j.error) || ("the cloud answered " + r.status)), { code: r.status >= 500 ? "server_unavailable" : "tool_error" });
  return j;
}
async function webSql(query){ return (await webCall({ q: query })).rows || []; }
async function webPhoto(key){ const j = await webCall({ photo: key }); return { mime: j.mime, b64: j.b64 }; }

async function sql(query){''')

# 5) a full web page + label it
rep('''<title>Papa Duck Drafts</title>''', '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- BUILT by tools/build-drafts-web.py from drafts-v62.html - edit drafts-v62.html, then re-run the build. -->
<title>Papa Duck Drafts</title>''')
# 6) the Launch Pad link goes to the web Launch Pad
rep('https://claude.ai/artifact/DiKnn9WmWgGqCp41ZPDT73', 'launchpad.html')
s = s.rstrip() + "\n"
if "</html>" not in s:
    s += "</html>\n"

(root / "drafts.html").write_text(s)
print("drafts.html built:", len(s), "bytes")
