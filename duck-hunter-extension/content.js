// 🦆 Duck Hunter - Papa Duck's book checker on Vinted (2026-11-17).
// Papa Duck: "see if we can do that ourselves" (like BookMine Hunter) + "add sell on ebay as well ... as long as it sells somewhere".
// Reads the listing he is looking at (title, ISBN, price, shipping), asks the Papa Duck cloud, shows one clear call.
// It never clicks anything on Vinted and never buys anything. 🛒 Bought it only logs the buy in Scout Buys.
(() => {
  if (window.__duckHunter) return; window.__duckHunter = true;
  const GREEN = "#1E5B43";
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const money = (n) => (n == null || isNaN(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Number(n)).toFixed(2));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ask = (body, pass) => new Promise((done) => chrome.runtime.sendMessage({ type: "dh", body, pass }, (r) => done(r || { ok: false, error: "No answer" })));

  // ---------- read the listing ----------
  const isbnOk = (d) => {
    d = String(d).replace(/[^0-9Xx]/g, "").toUpperCase();
    if (d.length === 13 && /^97[89]/.test(d)) { let t = 0; for (let i = 0; i < 12; i++) t += +d[i] * (i % 2 ? 3 : 1); return (10 - (t % 10)) % 10 === +d[12] ? d : ""; }
    if (d.length === 10) { let t = 0; for (let i = 0; i < 10; i++) t += (d[i] === "X" ? 10 : +d[i]) * (10 - i); return t % 11 === 0 ? d : ""; }
    return "";
  };
  function findIsbn(text) {
    const re = /(97[89](?:[\s-]?\d){10})|\b(\d(?:[\s-]?\d){8}[\s-]?[\dXx])\b/g; let m;
    while ((m = re.exec(text))) { const ok = isbnOk(m[1] || m[2]); if (ok) return ok; }
    return "";
  }
  const num = (s) => { const m = String(s || "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/); return m ? Number(m[1]) : null; };
  function readListing() {
    let name = "", desc = "", price = null;
    for (const s of $$('script[type="application/ld+json"]')) {
      try { for (const j of [JSON.parse(s.textContent)].flat()) if (j && /Product/i.test(j["@type"])) {
        name = name || j.name || ""; desc = desc || j.description || "";
        const of = [j.offers].flat()[0]; if (of && of.price != null) price = price ?? Number(of.price);
      } } catch (_) {}
    }
    const meta = (p) => (document.querySelector(`meta[property="${p}"],meta[name="${p}"]`) || {}).content || "";
    name = name || meta("og:title") || (document.querySelector("h1") || {}).textContent || "";
    desc = desc || meta("og:description") || "";
    const body = document.body.innerText || "";
    const priceEl = document.querySelector('[data-testid*="item-price"]');
    if (price == null && priceEl) price = num(priceEl.textContent);
    // what he pays: the "incl. Buyer Protection" total when Vinted shows it
    const prot = body.match(/\$\s?(\d+(?:\.\d{2})?)\s*(?:\n|\s)*incl\.?\s*(?:of\s*)?Buyer Protection/i);
    const total = prot ? Number(prot[1]) : null;
    const shipM = body.match(/Shipping(?:\s*from)?\s*\$\s?(\d+(?:\.\d{2})?)/i);
    const crumbs = $$('[itemtype*="BreadcrumbList"] a, nav[aria-label*="readcrumb"] a, [data-testid*="breadcrumb"] a').map((a) => a.textContent.trim()).join(" / ");
    const details = $$('[data-testid*="item-details"], [data-testid*="item-attributes"], [itemprop="description"]').map((e) => e.innerText).join("\n");
    const isbn = findIsbn([name, desc, details].join("\n")) || findIsbn(body.slice(0, 20000).replace(/\$\s?\d[\d.,]*/g, " "));
    name = name.replace(/\s*\|\s*Vinted.*$/i, "").trim();
    let title = name, author = "";
    const by = name.match(/^(.*?)\s+by\s+(.+)$/i) || name.match(/^(.*?)\s+[-–—]\s+(.+)$/);
    if (by) { title = by[1].trim(); author = by[2].trim(); }
    const isBook = !!isbn || /\bbooks?\b/i.test(crumbs) || /\b(hardcover|paperback|novel|isbn|textbook|edition)\b/i.test(name + " " + desc);
    return { title, author, isbn, price: total ?? price, ship: shipM ? Number(shipM[1]) : null, isBook, url: location.href.split("?")[0] };
  }

  // ---------- the panel ----------
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:76px;right:16px;z-index:2147483646";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font-family:'Atkinson Hyperlegible',Arial,sans-serif}
    .dh{width:380px;max-height:calc(100vh - 96px);overflow:auto;background:#fff;border:2px solid ${GREEN};border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.28);color:#222}
    .hd{position:sticky;top:0;background:${GREEN};color:#fff;padding:9px 12px;display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:16px;z-index:1}
    .hd button{background:transparent;border:0;color:#fff;font-size:18px;cursor:pointer;padding:0 4px}
    .tab{background:${GREEN};color:#fff;border:0;border-radius:24px;padding:10px 14px;font-weight:700;font-size:15px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.3)}
    .pad{padding:10px 12px}
    .verdict{margin:10px 12px 4px;border-radius:12px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center}
    .BUY{background:#dff3e4;color:#14532d}.MAYBE{background:#fff3c4;color:#713f12}.PASS{background:#fde2e1;color:#7f1d1d}
    .verdict b.v{font-size:28px}.verdict .pr{text-align:right;font-size:12px}.verdict .pr b{font-size:26px;display:block}
    .flag{background:#7f1d1d;color:#fff;padding:10px 12px;font-weight:700}
    .book{display:flex;gap:10px;padding:6px 12px;align-items:center}
    .book img{width:44px;height:62px;object-fit:cover;border-radius:3px;background:#ddd;flex:none}
    .t{font-weight:700;font-size:14.5px;line-height:1.2}.m{font-size:12px;color:#555}.ok{color:#15803d;font-weight:700}
    .where{margin:4px 12px 6px;border:1px solid #e5e5e5;border-radius:10px;overflow:hidden;font-size:13.5px}
    .wh,.wr{display:grid;grid-template-columns:1.05fr .85fr 1.3fr .8fr;padding:6px 9px;align-items:center;gap:4px}
    .wh{background:#f5f6f4;font-size:11px;color:#555}.wr{border-top:1px solid #eee}.wr b,.wh span:last-child{text-align:right}
    .wr.best{background:#dff3e4;font-weight:700}.neg{color:#b91c1c}
    .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:4px 12px}
    .tile{background:#f5f6f4;border-radius:10px;padding:7px 4px;text-align:center}.tile .n{font-size:17px;font-weight:700}.tile .l{font-size:11px;color:#555}
    .tile.edit{cursor:pointer;outline:1px dashed #9bb3a3}
    .chart{margin:6px 12px;border:1px solid #e5e5e5;border-radius:10px;padding:6px 8px}.chart .l{font-size:11.5px;color:#555;display:flex;justify-content:space-between}
    .mine{margin:6px 12px;background:#fff8dc;border-radius:10px;padding:7px 9px;font-size:12.5px}
    .btns{display:grid;grid-template-columns:1.3fr 1fr;gap:8px;padding:8px 12px 10px}
    button.b{border-radius:10px;padding:10px;font-weight:700;font-size:14.5px;cursor:pointer;border:1px solid #c9d6cc;background:#eef2ef;color:${GREEN}}
    button.b1{background:${GREEN};color:#fff;border:0}
    .small{font-size:11px;color:#777;padding:0 12px 10px}
    .form{display:grid;gap:8px;padding:10px 12px}.form label{font-size:12.5px;display:grid;gap:3px}
    .form input{font-size:15px;padding:7px 8px;border:2px solid #ccc;border-radius:8px}
    .spin{padding:22px 12px;text-align:center;font-size:14px;color:#444}
    .err{padding:12px;color:#7f1d1d;font-size:13.5px}
    a{color:${GREEN}}
  </style><div id="box"></div>`;
  const box = root.getElementById("box");
  let state = { listing: null, res: null, open: true, edit: false, boughtMsg: "" };

  chrome.storage.local.get("dhClosed", (v) => { state.open = !v.dhClosed; });

  function tab() { box.innerHTML = `<button class="tab" id="open">🦆 Duck Hunter</button>`; root.getElementById("open").onclick = () => { state.open = true; chrome.storage.local.set({ dhClosed: false }); paint(); if (!state.res && state.listing) run(); }; }
  const frame = (inner) => `<div class="dh"><div class="hd">🦆 Duck Hunter <span><button id="re" title="Check again">↻</button><button id="x" title="Hide">–</button></span></div>${inner}</div>`;
  function wire() {
    const x = root.getElementById("x"); if (x) x.onclick = () => { state.open = false; chrome.storage.local.set({ dhClosed: true }); paint(); };
    const re = root.getElementById("re"); if (re) re.onclick = () => { state.listing = readListing(); run(true); };
  }

  function chartSvg(c) {
    if (!c || !c.price || !c.price.some((v) => v)) return "";
    const line = (arr, inv) => { const v = arr.filter((x) => x != null); if (!v.length) return ""; const lo = Math.min(...v), hi = Math.max(...v), sp = hi - lo || 1;
      return arr.map((x, i) => x == null ? null : `${(i / (arr.length - 1) * 340).toFixed(1)},${(6 + (inv ? (x - lo) / sp : 1 - (x - lo) / sp) * 56).toFixed(1)}`).filter(Boolean).join(" "); };
    const p = c.price.filter((v) => v), lo = Math.min(...p), hi = Math.max(...p);
    return `<div class="chart"><div class="l"><span>Amazon used price · 1 year · ${money(lo)}–${money(hi)}</span><span><b style="color:${GREEN}">—</b> price <b style="color:#d97706">···</b> rank</span></div>
      <svg viewBox="0 0 340 68" width="100%" height="68"><polyline fill="none" stroke="#d97706" stroke-width="1.5" stroke-dasharray="3 3" points="${line(c.rank || [], true)}"/><polyline fill="none" stroke="${GREEN}" stroke-width="2.5" points="${line(c.price, false)}"/></svg>
      <div class="m" style="font-size:10.5px">Rank line: higher on the chart = selling better.</div></div>`;
  }

  function paint() {
    if (!state.open) return tab();
    const L = state.listing, r = state.res;
    if (!L) { box.innerHTML = ""; return; }
    if (state.needPass) {
      box.innerHTML = frame(`<form class="form" id="pf"><b>Type your Book Station passcode or PIN</b><span class="m">${esc(state.needPass === 2 ? "That passcode didn't work. Try again." : "Asked once on this computer.")}</span><input id="pp" type="password" autocomplete="current-password"><button class="b b1">Start hunting</button></form>`);
      wire(); const f = root.getElementById("pf"); root.getElementById("pp").focus();
      f.onsubmit = async (e) => { e.preventDefault(); const v = root.getElementById("pp").value.trim(); if (!v) return;
        const k = await ask({ action: "ping" }, v); if (k && k.ok) { state.needPass = 0; run(true); } else { state.needPass = 2; paint(); } };
      return;
    }
    if (state.edit || (!r && !state.loading && !state.err)) {
      box.innerHTML = frame(`<form class="form" id="ef"><b>${L.isBook ? "Check this book" : "Is this a book? Check it"}</b>
        <label>ISBN (best) <input id="fi" value="${esc(L.isbn)}" inputmode="numeric" placeholder="978…"></label>
        <label>Title <input id="ft" value="${esc(L.title)}"></label><label>Author <input id="fa" value="${esc(L.author)}"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><label>Price you pay <input id="fp" value="${L.price ?? ""}" inputmode="decimal"></label>
        <label>Shipping <input id="fs" value="${L.ship ?? ""}" inputmode="decimal" placeholder="e.g. 3.99"></label></div>
        <button class="b b1">🦆 Check it</button></form>`);
      wire();
      root.getElementById("ef").onsubmit = (e) => { e.preventDefault();
        Object.assign(L, { isbn: root.getElementById("fi").value.trim(), title: root.getElementById("ft").value.trim(), author: root.getElementById("fa").value.trim(),
          price: num(root.getElementById("fp").value), ship: num(root.getElementById("fs").value) ?? 0 });
        state.edit = false; run(true); };
      return;
    }
    if (state.loading) { box.innerHTML = frame(`<div class="spin">🦆 Checking eBay, Amazon and AbeBooks…<br><span class="m">about 20–40 seconds the first time</span></div>`); wire(); return; }
    if (state.err) { box.innerHTML = frame(`<div class="err">Couldn't check it: ${esc(state.err)}</div><div class="btns"><button class="b b1" id="again">Try again</button><button class="b" id="fix">✏️ Fix details</button></div>`); wire();
      root.getElementById("again").onclick = () => run(true); root.getElementById("fix").onclick = () => { state.edit = true; state.err = ""; paint(); }; return; }

    const v = r.verdict, ic = { BUY: "🟢", MAYBE: "🟡", PASS: "🔴" }[v] || "⚪";
    const id = r.ident || {}, amz = r.amazon || {}, hist = r.history || { sold: [], on_hand: [] };
    const tg = (r.hard || []).find((h) => /Good and the Beautiful|self-printed/i.test(h));
    const rows = (r.stores || []).map((s) => `<div class="wr${s.best ? " best" : ""}"><span>${s.best ? "⭐ " : ""}${esc(s.store)}</span><span>${money(s.sells)}</span><span>${esc(s.selling)}</span><b class="${s.profit < 0 ? "neg" : ""}">${money(s.profit)}</b></div>`).join("");
    const histTxt = hist.sold.length ? `sold ${hist.sold.length} before (${hist.sold.slice(0, 3).map((x) => esc(x.ch) + " " + money(x.price)).join(", ")})` : "never sold one";
    const onHand = hist.on_hand.length ? ` · ${hist.on_hand.length} on hand (${hist.on_hand.slice(0, 3).map((x) => esc(x.pd)).join(", ")})` : " · none on hand";
    box.innerHTML = frame(`
      ${tg ? `<div class="flag">${esc(tg)} — don't buy</div>` : ""}
      <div class="verdict ${v}"><div><b class="v">${ic} ${v}</b><div style="font-size:12.5px">${esc(r.why)}</div></div>
        <div class="pr">${r.best ? "Best profit" : "Profit"}<b>${r.best ? money(r.best.profit) : "—"}</b></div></div>
      <div class="book">${amz.image ? `<img src="${esc(amz.image)}" alt="">` : ""}<div><div class="t">${esc(id.title || L.title)}</div>
        <div class="m">${esc([id.author, id.format, id.isbn ? "ISBN " + id.isbn : ""].filter(Boolean).join(" · "))}</div>
        ${id.isbn ? `<div class="m ok">✓ Matched by ISBN${L.isbn ? "" : " (found from the title, double-check)"}</div>` : `<div class="m" style="color:#b45309">No ISBN — matched by title, double-check the edition</div>`}</div></div>
      ${rows ? `<div class="where"><div class="wh"><span>Where it sells</span><span>Sells for</span><span>Selling?</span><span>Profit</span></div>${rows}</div>` : `<div class="pad m">No copies found for sale on eBay, Amazon or AbeBooks.</div>`}
      <div class="grid">
        <div class="tile edit" id="cost" title="Change price or shipping"><div class="n">${money(r.cost)}</div><div class="l">Your cost ✏️<br>(price + ship)</div></div>
        <div class="tile"><div class="n">${amz.rank ? "#" + Number(amz.rank).toLocaleString() : "—"}</div><div class="l">Amazon<br>sales rank</div></div>
        <div class="tile"><div class="n">${r.bargain && r.bargain.buy ? money(r.bargain.buy) : amz.offers ?? "—"}</div><div class="l">${r.bargain && r.bargain.buy ? "Bargain Duck<br>buy price" : "Amazon<br>used offers"}</div></div>
      </div>
      ${chartSvg(r.chart)}
      <div class="mine">📒 <b>Your history:</b> ${histTxt}${onHand}.</div>
      ${state.boughtMsg ? `<div class="pad ok">${esc(state.boughtMsg)}</div>` : ""}
      <div class="btns"><button class="b b1" id="bought">🛒 Bought it</button><button class="b" id="amz">🔎 Check on Amazon</button></div>
      <div class="small">Profit = what it sells for minus your cost. Etsy is left out: it has no sold-price data for books. 🛒 saves the buy (cost, source Vinted, best store) to Scout Buys. <a href="#" id="fix">Wrong book? Fix it</a>${r.best && r.best.store === "eBay" && id.isbn ? ` · <a href="https://www.ebay.com/sch/i.html?_nkw=${esc(id.isbn)}&LH_Sold=1&LH_Complete=1" target="_blank">eBay sold</a>` : ""}</div>`);
    wire();
    root.getElementById("cost").onclick = root.getElementById("fix").onclick = (e) => { e.preventDefault(); state.edit = true; paint(); };
    root.getElementById("amz").onclick = () => window.open(amz.asin ? `https://www.amazon.com/dp/${amz.asin}` : `https://www.amazon.com/s?k=${encodeURIComponent(id.isbn || L.title)}&i=stripbooks`, "_blank");
    const bb = root.getElementById("bought");
    bb.onclick = async () => {
      if (bb.dataset.arm !== "1") { bb.dataset.arm = "1"; bb.textContent = `Tap again: bought for ${money(r.cost)}`; setTimeout(() => { if (bb.isConnected && bb.dataset.arm === "1") { bb.dataset.arm = ""; bb.textContent = "🛒 Bought it"; } }, 6000); return; }
      bb.disabled = true; bb.textContent = "Saving…";
      const k = await ask({ action: "bought", isbn: id.isbn || L.isbn, title: id.title || L.title, author: id.author || L.author, format: id.format, cost: r.cost,
        list: r.best ? r.best.sells : null, best: r.best ? r.best.store : "", url: L.url });
      state.boughtMsg = k.ok ? `✓ Saved to Scout Buys (Vinted, ${money(r.cost)}${r.best ? ", sell on " + r.best.store : ""}).` : "Didn't save: " + (k.error || "try again");
      paint();
    };
  }

  async function run(force) {
    const L = state.listing; if (!L) return;
    if (!force && !L.isBook) { state.res = null; paint(); return; }   // not a book: just the form
    if (!L.isbn && !L.title) { state.edit = true; paint(); return; }
    state.loading = true; state.err = ""; state.res = null; state.boughtMsg = ""; paint();
    const k = await ask({ action: "check", isbn: L.isbn, title: L.title, author: L.author, price: L.price || 0, ship: L.ship || 0, url: L.url });
    state.loading = false;
    if (k.error === "bad_passcode") { state.needPass = 1; return paint(); }
    if (!k.ok) { state.err = k.error || "unknown problem"; return paint(); }
    state.res = k; paint();
  }

  // ---------- follow Vinted page changes (it is a one-page app) ----------
  let lastUrl = "";
  function onPage() {
    const u = location.href.split("?")[0];
    if (u === lastUrl) return; lastUrl = u;
    if (!/\/items\/\d+/.test(u)) { state.listing = null; state.res = null; box.innerHTML = ""; if (host.isConnected) host.remove(); return; }
    if (!host.isConnected) document.documentElement.appendChild(host);
    state = { ...state, listing: null, res: null, edit: false, err: "", boughtMsg: "", loading: false };
    box.innerHTML = state.open ? frame(`<div class="spin">🦆 Reading the listing…</div>`) : "";
    setTimeout(() => { state.listing = readListing(); if (state.open) run(false); else paint(); }, 1800);
  }
  setInterval(onPage, 1000); onPage();
})();
