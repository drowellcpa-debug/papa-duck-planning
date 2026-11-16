#!/usr/bin/env python3
"""Build launchpad.html (Netlify, no claude.ai connector) from launchpad-v1.html (the claude.ai artifact).
2026-11-16 Papa Duck: "ok ready for the next move" (Launch Pad todo 88, part 2).
Same page; only the transport changes: queries go to the drafts-api edge function (passcode / PIN, allowlisted
function calls only). Grandpa Duck (the chat) needs claude.ai, so on the web it points there instead.
Run: python3 tools/build-launchpad-web.py   (re-run after every launchpad-v1.html change)."""
import pathlib, sys

root = pathlib.Path(__file__).resolve().parent.parent
s = (root / "launchpad-v1.html").read_text()

def rep(old, new, count=1):
    global s
    if s.count(old) != count:
        sys.exit(f"build-launchpad-web: expected {count} of: {old[:80]!r}, found {s.count(old)}")
    s = s.replace(old, new)

rep('''      const res = await mcp.callTool(SERVER, TOOL, { project_id: PROJECT, query: sql }, { cache: false });
      if (/look up the project organization/i.test(JSON.stringify((res && res.payload) || ""))) throw new Error("Failed to look up the project organization");
      return parse(res);''', '''      return await webSql(sql);''')

rep('''async function q(sql) {''', '''// ---------- web transport (launchpad.html on Netlify) ----------
const DAPI = "https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/drafts-api";
const PASS_KEY = "pdStationPass";   // same passcode / PIN as the Book Station, Sorting Helper and Drafts on this site
function webPass(){ try { return localStorage.getItem(PASS_KEY) || ""; } catch (e) { return ""; } }
function askPass(msg){
  return new Promise((done) => {
    const w = document.createElement("div");
    w.style.cssText = "position:fixed;inset:0;z-index:99;background:rgba(0,0,0,.45);display:grid;place-items:center;padding:16px";
    w.innerHTML = '<form style="background:#fff;border-radius:14px;padding:18px;max-width:340px;width:100%;display:grid;gap:10px;font-family:inherit">' +
      '<b style="font-size:1.1rem">🚀 Papa Duck Launch Pad</b><span>' + (msg || "Type your Book Station passcode or PIN.") + '</span>' +
      '<input id="pdpass" type="password" inputmode="numeric" autocomplete="current-password" style="font-size:1.2rem;padding:10px;border:2px solid #ccc;border-radius:10px">' +
      '<button style="font-size:1.05rem;padding:10px;border:0;border-radius:10px;background:#1E5B43;color:#fff;font-weight:700">Open Launch Pad</button></form>';
    document.body.appendChild(w);
    const f = w.querySelector("form"); w.querySelector("#pdpass").focus();
    f.onsubmit = (e) => { e.preventDefault(); const v = w.querySelector("#pdpass").value.trim(); if (!v) return;
      try { localStorage.setItem(PASS_KEY, v); } catch (_) {} w.remove(); done(v); };
  });
}
async function webSql(query){
  const r = await fetch(DAPI, { method: "POST", headers: { "content-type": "application/json", "x-station-pass": webPass() }, body: JSON.stringify({ q: query }) });
  let j = null; try { j = await r.json(); } catch (_) {}
  if (r.status === 403 || (j && j.error === "bad_passcode")) {
    try { localStorage.removeItem(PASS_KEY); } catch (_) {}
    await askPass("That passcode didn't work. Type your Book Station passcode or PIN.");
    return webSql(query);
  }
  if (!r.ok || !j || !j.ok) throw Object.assign(new Error((j && j.error) || ("the cloud answered " + r.status)), { code: r.status >= 500 ? "server_unavailable" : "tool_error" });
  return j.rows || [];
}

async function q(sql) {''')

rep('''  mcp = window.claude && await window.claude.use("mcp");
  if (!mcp) { $("conn").textContent = "Open this page inside claude.ai to connect."; $("main").innerHTML = '<p class="empty">This page talks to Supabase through your claude.ai connector, so it only works when opened in claude.ai.</p>'; return; }
  window.claude.use("sample").then((s) => { sample = s; if (!s) { $("duckhint").textContent = "Grandpa Duck isn't available in this view."; $("askbtn").disabled = true; } });''',
'''  mcp = { web: true };
  if (!webPass()) await askPass();
  sample = null; $("duckhint").textContent = "Grandpa Duck chats in the Claude version of the Launch Pad."; $("askbtn").disabled = true;''')

rep('''<title>Papa Duck Launch Pad</title>''', '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- BUILT by tools/build-launchpad-web.py from launchpad-v1.html - edit launchpad-v1.html, then re-run the build. -->
<title>Papa Duck Launch Pad</title>''')
s = s.rstrip() + "\n</html>\n"
(root / "launchpad.html").write_text(s)
print("launchpad.html built:", len(s), "bytes")
