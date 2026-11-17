// Duck Hunter - background: the only part that talks to the Papa Duck cloud (duck-hunter edge function).
const API = "https://gdwxwiwckxthwcsrgywh.supabase.co/functions/v1/duck-hunter";
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== "dh") return;
  (async () => {
    try {
      const { pdStationPass = "" } = await chrome.storage.local.get("pdStationPass");
      const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "x-station-pass": msg.pass || pdStationPass }, body: JSON.stringify(msg.body) });
      let j = null; try { j = await r.json(); } catch (_) {}
      if (r.status === 403 || (j && j.error === "bad_passcode")) return reply({ ok: false, error: "bad_passcode" });
      if (msg.pass && j && j.ok) await chrome.storage.local.set({ pdStationPass: msg.pass });
      reply(j || { ok: false, error: "The cloud answered " + r.status });
    } catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
  })();
  return true;
});
