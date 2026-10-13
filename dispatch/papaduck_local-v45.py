#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""papaduck_local.py - the Papa Duck local helper. Version is VERSION below (same number as the page).

Runs on Papa Duck's machine, listens ONLY on 127.0.0.1:8765, and:
  1. serves the Delete Station page at  http://127.0.0.1:8765/
  2. runs papaduck_ebay.py / papaduck_abe.py on the page's behalf
  3. VERIFIES every action (eBay GetItem after end/revise; AbeBooks public site after delete)
  4. ARCHIVES every run - locally to C:\\PapaDuck\\runs\\<date>.jsonl, and to the Airtable table
     "Helper Runs" so Claude can read results directly. Nothing is ever pasted into chat.
  5. installs updated files from Downloads (no PowerShell needed after the first install)
  6. v23: sends the nightly Etsy file through the Etsy API (only books he switched Etsy ON, only
     20+ years old), and takes sold books off Etsy from the Sold tab

A browser page cannot launch PowerShell - that is the sandbox, not a setting. This helper is the
standard way around it.

SAFETY
  * Binds to 127.0.0.1 only - nothing outside this computer can reach it.
  * Accepts requests only from its own page (Origin http://127.0.0.1:8765) with the X-PapaDuck header.
  * Runs a fixed menu of commands with fixed paths. It never runs arbitrary text.
  * Credentials stay in ini files on this machine. The Airtable token is written by the app's
    Settings panel and never leaves this computer.
"""
import json, os, sys, subprocess, time, re, threading, shutil, glob, configparser
import urllib.request, urllib.parse, urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
try:
    from http.server import ThreadingHTTPServer          # v24: /progress must answer WHILE a push runs
except ImportError:
    from socketserver import ThreadingMixIn
    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer): daemon_threads = True

VERSION = "45"
HOST, PORT = "127.0.0.1", 8765
BASE    = os.path.dirname(os.path.abspath(__file__))          # C:\PapaDuck
EBAY    = os.path.join(BASE, "ebay", "papaduck_ebay.py")
ABE     = os.path.join(BASE, "abe",  "papaduck_abe.py")
EBAYDIR = os.path.join(BASE, "ebay")
ABEDIR  = os.path.join(BASE, "abe")
ETSYDIR = os.path.join(BASE, "etsy")      # v23: nightly Etsy files land here
AMZDIR  = os.path.join(BASE, "amazon")    # v29: nightly Amazon files land here
ABEIMG  = os.path.join(BASE, "abe", "papaduck_abe_images.py")
IDMAP   = os.path.join(BASE, "ebay", "pd_itemids.json")
PAGE    = os.path.join(BASE, "papaduck-delete-station.html")
LOG     = os.path.join(BASE, "papaduck_local.log")
RUNS    = os.path.join(BASE, "runs")
ATINI   = os.path.join(BASE, "airtable_credentials.ini")
ORIGIN  = "http://%s:%d" % (HOST, PORT)
PD_RE   = re.compile(r"^PD-\d{4}[A-Z]?$")
ID_RE   = re.compile(r"^\d{9,15}$")
DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads")
SELLER_WORDS = ("papa duck", "papaduck")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PapaDuckHelper/4"
AT_BASE, AT_RUNS = "appdMXzb9U4sdXpAr", "tblUtIsfVQdll2E04"
# v20: Inventory table, for the ItemID fallback (Tracking / Title / eBay ItemID)
AT_INV = "tblKxgB4q7v9SPqze"
F_TRACK, F_TITLE, F_ITEMID = "fldxiwKYi6z1t0iDx", "fld4IZiZDz3Glnf7B", "fldKGZyyXy0Gjox5b"

# v7: match on the STEM, case-insensitively, tolerating anything a browser adds -
# " (1)", "(1)", "-2", "_2", " copy", a doubled ".txt.txt". An exact-name matcher is why
# two correctly-downloaded v6 files never appeared in the Install tab on 2026-09-19.
def _clean(name):
    n = name.strip()
    while True:
        m = re.match(r"^(.*)\.(txt|html|json|py)\.(txt|html|json|py)$", n, re.I)
        if not m: break
        n = m.group(1) + "." + m.group(3)
    base, ext = os.path.splitext(n)
    base = re.sub(r"(?:\s*\(\d+\)|\s*-\s*copy|\s*copy|[-_ ]v?\d+)\s*$", "", base, flags=re.I)
    base = re.sub(r"(?:\s*\(\d+\)|[-_ ]v?\d+)\s*$", "", base, flags=re.I)   # e.g. "_v10 (1)"
    return (base.strip() + ext.lower())

INSTALL = [
  (re.compile(r"^papaduck_ebay$",           re.I), os.path.join(BASE, "ebay", "papaduck_ebay.py")),
  (re.compile(r"^papaduck_local$",          re.I), os.path.join(BASE, "papaduck_local.py")),
  (re.compile(r"^papaduck-delete-station$", re.I), PAGE),
  (re.compile(r"^papaduck.?dispatch$",      re.I), PAGE),
  (re.compile(r"^pd_itemids$",              re.I), IDMAP),
  (re.compile(r"^papaduck_abebooks_.*$",    re.I), os.path.join(BASE, "abe")),
  (re.compile(r"^papaduck_ebay_rows_.*$",   re.I), EBAYDIR),
  (re.compile(r"^papaduck_etsy_.*$",        re.I), ETSYDIR),      # v23
  (re.compile(r"^papaduck_amazon_.*$",      re.I), AMZDIR),       # v29
]
try: os.makedirs(AMZDIR, exist_ok=True)
except Exception: pass
try: os.makedirs(ETSYDIR, exist_ok=True)     # must exist, or the installer would treat "etsy" as a file name
except Exception: pass
EXT_OK = {".txt", ".html", ".json", ".csv"}

# ------------------------------------------------------------------ logging / archive
def log(s):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write("%s  %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), s))

def at_token():
    if not os.path.exists(ATINI): return ""
    c = configparser.ConfigParser(); c.read(ATINI, encoding="utf-8")
    try: return c["airtable"]["token"].strip()
    except KeyError: return ""

def archive(action, pds, result, output, verify="", inp="", notes=""):
    """Local JSONL always; Airtable when a token is configured. Returns the Airtable record id or ''."""
    os.makedirs(RUNS, exist_ok=True)
    rec = dict(when=time.strftime("%Y-%m-%dT%H:%M:%S"), action=action, pds=pds, result=result,
               output=output, verify=verify, input=inp, notes=notes)
    with open(os.path.join(RUNS, time.strftime("%Y-%m-%d") + ".jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")
    tok = at_token()
    if not tok: return ""
    fields = {"Run": "%s %s" % (time.strftime("%Y-%m-%d %H:%M"), action),
              "When": time.strftime("%Y-%m-%dT%H:%M:%S") , "Action": action, "PDs": pds[:250],
              "Result": result, "Output": output[:95000], "Verify": verify[:95000],
              "Input": inp[:95000], "Notes": notes[:95000]}
    body = json.dumps({"records": [{"fields": fields}], "typecast": True}).encode()
    req = urllib.request.Request("https://api.airtable.com/v0/%s/%s" % (AT_BASE, AT_RUNS), data=body,
            headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())["records"][0]["id"]
    except urllib.error.HTTPError as e:
        log("AIRTABLE-ARCHIVE-FAIL %s %s" % (e.code, e.read().decode(errors="replace")[:300])); return ""
    except Exception as e:
        log("AIRTABLE-ARCHIVE-FAIL %s" % e); return ""

def at_lookup(pds):
    """v20 - the /idmap only knows books this app listed itself (from 09-19). A book listed any other
    way (Seller Hub CSV, by hand) has its ItemID in Airtable Inventory instead. PD-0122 sold on
    AbeBooks 2026-09-22 and the Sold tab could not end it on eBay because of exactly this.
    Returns {PD: {"itemid": "...", "title": "..."}} for every PD found. Never raises."""
    tok = at_token(); pds = [p for p in (pds or []) if PD_RE.match(str(p))]
    if not tok or not pds: return {}
    out = {}
    for i in range(0, len(pds), 40):
        chunk = pds[i:i + 40]; recs = None
        for ref in (F_TRACK, "Tracking"):            # field ID first; the field NAME if a formula rejects the ID
            formula = "OR(" + ",".join("{%s}='%s'" % (ref, p) for p in chunk) + ")"
            qs = [("filterByFormula", formula), ("returnFieldsByFieldId", "true"),
                  ("fields[]", F_TRACK), ("fields[]", F_TITLE), ("fields[]", F_ITEMID)]
            url = "https://api.airtable.com/v0/%s/%s?%s" % (AT_BASE, AT_INV, urllib.parse.urlencode(qs))
            try:
                req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
                with urllib.request.urlopen(req, timeout=30) as r: recs = json.loads(r.read().decode()).get("records", [])
                break
            except urllib.error.HTTPError as e:
                log("AIRTABLE-LOOKUP-FAIL %s %s %s" % (ref, e.code, e.read().decode(errors="replace")[:300]))
                if e.code != 422: break
            except Exception as e:
                log("AIRTABLE-LOOKUP-FAIL %s" % e); break
        if not recs: continue
        for rec in recs:
            f = rec.get("fields", {}); pd = str(f.get(F_TRACK, "")).strip()
            iid = re.sub(r"\D", "", str(f.get(F_ITEMID, "") or ""))
            if PD_RE.match(pd):
                cur = out.get(pd, {})
                out[pd] = {"itemid": iid or cur.get("itemid", ""), "title": str(f.get(F_TITLE, "") or "") or cur.get("title", "")}
    return out

def result_of(rc, out):
    # "4 attempted  4 listed  0 failed" is a SUCCESS line - do not let the word 'failed' in a zero
    # count mark a clean run as failed (seen live 2026-09-19 on two perfect ebay-add runs).
    o = re.sub(r"\b0\s+(FAILED|ERRORS?)\b", "", out.upper())
    o = re.sub(r"\bNO (FAILURES|ERRORS)\b", "", o)
    if rc != 0 or "FAILED" in o or "ERROR" in o: return "failed" if "REFUSED" not in o else "refused"
    if "REFUSED" in o: return "refused"
    if "ACK=WARNING" in o or "WARNING" in o: return "warning"
    return "ok"

# ------------------------------------------------------------------ run our scripts
_busy = 0
_busy_lock = threading.Lock()
def _set_busy(d):
    global _busy
    with _busy_lock: _busy = max(0, _busy + d)

def run(argv, timeout=600):
    """v16: a run holds the 'busy' flag so the watcher never restarts the helper - and so kills the
    child - while an upload or listing is in flight (this cut off the 22:03 photo push on 2026-09-19)."""
    _set_busy(+1)
    try:
        return _run(argv, timeout)
    finally:
        _set_busy(-1)

def _run(argv, timeout=600):
    log("RUN " + " ".join(argv))
    p = subprocess.run([sys.executable, "-u"] + argv, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout, cwd=os.path.dirname(argv[0]))
    out = (p.stdout or "") + (("\n" + p.stderr) if p.stderr else "")
    log("RC=%d %s" % (p.returncode, out[-300:].replace("\n", " | ")))
    return p.returncode, out

# ------------------------------------------------------------------ live progress (v24)
# Papa Duck 2026-09-30: "can I see the progress bar for each pd#" - the page polls GET /progress every
# ~1.5 s while an AbeBooks push or an Etsy send runs, and draws one bar per PD.
_prog_lock = threading.Lock()
PROGRESS = {"job": "", "file": "", "stage": "", "running": False, "items": {}, "order": [], "started": "", "finished": "", "last": "", "last_at": ""}

def prog_start(job, f, pds, totals):
    with _prog_lock:
        PROGRESS.update(job=job, file=f, stage="starting", running=True, started=time.strftime("%H:%M:%S"), finished="", last="", last_at="",
                        order=list(pds), items={p: {"done": 0, "total": int(totals.get(p, 0)), "state": "waiting", "note": ""} for p in pds})

def prog_set(pd=None, stage=None, **kw):
    with _prog_lock:
        if stage is not None: PROGRESS["stage"] = stage
        if pd and pd in PROGRESS["items"]: PROGRESS["items"][pd].update(kw)

def prog_all(state, only_if=None):
    with _prog_lock:
        for it in PROGRESS["items"].values():
            if only_if is None or it["state"] in only_if: it["state"] = state

def prog_end(stage):
    with _prog_lock: PROGRESS.update(running=False, stage=stage, finished=time.strftime("%H:%M:%S"))

def prog_snapshot():
    with _prog_lock: return json.loads(json.dumps(PROGRESS))

def run_stream(argv, timeout=600, on_line=None):
    """Like run(), but reads the child's output line by line so progress can update as it happens."""
    _set_busy(+1)
    try:
        log("RUN(stream) " + " ".join(argv))
        p = subprocess.Popen([sys.executable, "-u"] + argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             encoding="utf-8", errors="replace", cwd=os.path.dirname(argv[0]))
        killer = threading.Timer(timeout, lambda: p.kill()); killer.start()
        buf = []
        try:
            for line in p.stdout:
                buf.append(line)
                if on_line:
                    try: on_line(line.rstrip("\n"))
                    except Exception as e: log("PROGRESS-PARSE %s" % e)
            p.wait()
        finally:
            killer.cancel()
        out = "".join(buf)
        log("RC=%d %s" % (p.returncode, out[-300:].replace("\n", " | ")))
        return p.returncode, out
    finally:
        _set_busy(-1)

_SENT_RE = re.compile(r"(PD-\d{4}[A-Z]?).{0,40}?SENT\s+(\d+)\s*/\s*(\d+)")
_PD_ANY  = re.compile(r"\b(PD-\d{4}[A-Z]?)\b")
_JPG_RE  = re.compile(r"(PD-\d{4}[A-Z]?)_(\d+)\.jpg", re.I)
def abe_photo_line(line):
    """v31 (Papa Duck 10-02: "I want to see it moving that it is doing the final step"). The images script first GETS every
    photo ready (prints PD_n.jpg names), then uploads them and only prints SENT a/b at the end. v24 filled the bars on the
    PD_n.jpg names, so they sat at 100% through the whole upload. Now: names = "ready" (half the bar), then every bar
    pulses as "uploading", with the latest output line and a running clock on the page; SENT turns a bar green."""
    with _prog_lock:
        if line.strip(): PROGRESS["last"] = line.strip()[:140]; PROGRESS["last_at"] = time.strftime("%H:%M:%S")
    m = _SENT_RE.search(line)
    if m:
        pd, a, b = m.group(1), int(m.group(2)), int(m.group(3))
        prog_set(pd, done=a, total=b, state="done" if a >= b else "short", note="%d/%d sent" % (a, b)); return
    for pd, n in _JPG_RE.findall(line):
        n = int(n)
        with _prog_lock:
            it = PROGRESS["items"].get(pd)
            if it and it["state"] not in ("done", "short", "uploading"):
                it["state"] = "staging"; it["done"] = max(it["done"], min(n, it["total"] or n))
                it["note"] = "photo %d of %d ready" % (it["done"], it["total"])
            items = [x for x in PROGRESS["items"].values() if x["state"] not in ("done", "short", "failed")]
            if items and all(x["total"] and x["done"] >= x["total"] for x in items):
                for x in items: x["state"] = "uploading"; x["note"] = "uploading to AbeBooks..."
                PROGRESS["stage"] = "3/3 uploading photos to AbeBooks - the last step, usually 1 to 3 minutes"
        return
    m = _PD_ANY.search(line)
    if m:
        with _prog_lock:
            it = PROGRESS["items"].get(m.group(1))
            if it and it["state"] == "waiting": it["state"] = "staging"; it["note"] = "working"

def only_pds(xs):
    xs = [str(x).strip() for x in (xs or [])]
    bad = [x for x in xs if not (PD_RE.match(x) or ID_RE.match(x))]
    if bad: raise ValueError("not a PD number or ItemID: %s" % bad)
    return xs

def ebay_items(ids):
    if not ids: return []
    rc, out = run([EBAY, "item"] + ids)
    try: return json.loads(out[out.index("["):])
    except Exception: return []

# ------------------------------------------------------------------ AbeBooks public-site verify
def abe_verify(title, pages=2):
    kn = " ".join(re.sub(r"[^A-Za-z0-9 ]", " ", title or "").split()[:8])
    if not kn: return dict(ok=False, error="no title to search")
    seen, found = 0, False
    for p in range(1, pages + 1):
        url = "https://www.abebooks.com/servlet/SearchResults?kn=%s&sortby=17&pn=%d" % (urllib.parse.quote(kn), p)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-US"})
            with urllib.request.urlopen(req, timeout=30) as r: body = r.read().decode("utf-8", "replace")
        except Exception as e:
            return dict(ok=False, query=kn, error=str(e)[:200], checked=time.strftime("%H:%M"))
        seen += 1; low = body.lower()
        if any(w in low for w in SELLER_WORDS): found = True; break
        if "no results" in low or "unable to find" in low: break
    return dict(ok=True, query=kn, found=found, pages_checked=seen, checked=time.strftime("%H:%M"))

def fmt_verify_abe(v):
    if not v.get("ok"): return "AbeBooks check could not run: %s" % v.get("error")
    return ("AbeBooks public search %s at %s (%d page%s, query '%s'): %s"
            % ("still SHOWS a Papa Duck copy" if v["found"] else "shows NO Papa Duck copy",
               v["checked"], v["pages_checked"], "s" if v["pages_checked"] != 1 else "", v["query"],
               "NOT YET GONE - search index refreshes about hourly, re-verify later" if v["found"] else "GONE / verified"))

def fmt_verify_ebay(items):
    return "\n".join("eBay %s (%s): %s, qty %s, remaining %s, price %s"
        % (it.get("pd") or "", it.get("itemid"), it.get("status"), it.get("quantity"), it.get("remaining"), it.get("price"))
        for it in items if it.get("ok")) or "eBay check returned nothing"

# ------------------------------------------------------------------ AbeBooks photo check
def abe_rows_photos(path):
    """Read listingid + imgurl out of a flat file -> {PD: [urls]} (imgurl is space separated)."""
    out = {}
    with open(path, encoding="utf-8") as fh:
        head = fh.readline().rstrip("\n").split("\t")
        try: i_id, i_img = head.index("listingid"), head.index("imgurl")
        except ValueError: return out
        for line in fh:
            c = line.rstrip("\n").split("\t")
            if len(c) <= max(i_id, i_img): continue
            if PD_RE.match(c[i_id].strip()):
                out[c[i_id].strip()] = [u for u in c[i_img].split(" ") if u.strip()]
    return out

def photo_alive(url):
    """A dead imgbb link still returns 200 - it serves a ~1031 byte image/png placeholder (master section 6).
    So judge content-type and size, never the status code."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=25) as r:
            ct = (r.headers.get("Content-Type") or "").lower(); body = r.read(200000)
        n = len(body)
        if "image/png" in ct and n < 4000: return False, "%d bytes %s (placeholder)" % (n, ct)
        if n < 4000: return False, "%d bytes %s (too small)" % (n, ct)
        if "image" not in ct: return False, "%s" % ct
        return True, "%d bytes %s" % (n, ct)
    except Exception as e:
        return False, str(e)[:80]

def abe_photo_report(path, only=None):
    rows = abe_rows_photos(path); lines = []; dead = []; total = 0; ok = 0
    for pd in sorted(rows):
        if only and pd not in only: continue
        urls = rows[pd]; good = 0; bad = []
        for u in urls:
            total += 1; alive, why = photo_alive(u)
            if alive: good += 1; ok += 1
            else: bad.append("%s (%s)" % (u, why))
        lines.append("%s %d/%d photos reachable%s" % (pd, good, len(urls), "" if not bad else "  <-- DEAD"))
        for b in bad: lines.append("    " + b); dead.append(pd)
    head = "PHOTO CHECK: %d of %d source images reachable across %d book(s)" % (ok, total, len([p for p in rows if not only or p in only]))
    if dead: head += " - DEAD LINKS on " + ", ".join(sorted(set(dead))) + ": re-shoot through Book Station OVERRIDE before pushing"
    return head + "\n" + "\n".join(lines), (not dead), total, ok

# ------------------------------------------------------------------ install
def _dest_for(name):
    """Try the raw name FIRST, then the cleaned one - so a real date suffix
    (PapaDuck_eBay_Rows_09192026) is never mistaken for a browser's copy counter."""
    raw = os.path.basename(str(name))
    for cand in (raw, _clean(raw)):
        stem, ext = os.path.splitext(cand)
        if ext.lower() not in EXT_OK: continue
        for rx, d in INSTALL:
            if rx.match(stem):
                keep = raw if cand == raw else _clean(raw)
                return d if not os.path.isdir(d) else os.path.join(d, keep)
    return None

def _looks_like_ours(name):
    """A Papa Duck file we do NOT recognise - shown in the Install tab with a reason instead of
    silently vanishing. 'Nothing coming up' must never be the only feedback again."""
    n = os.path.basename(str(name)).lower()
    return ("papaduck" in n or "papa duck" in n or n.startswith("pd_")) and not _dest_for(name)

def file_version(path):
    """The version a helper or page file declares: VERSION = "17" / const VERSION="10". None if unknown."""
    try:
        head = open(path, encoding="utf-8", errors="replace").read(20000)
    except Exception:
        return None
    m = re.search(r'VERSION\s*=\s*["\'](\d+)["\']', head)
    return int(m.group(1)) if m else None

def install_from_downloads(names):
    """Install the NEWEST copy per destination; older duplicates are skipped and never overwrite."""
    out = []; restart = False; newest = {}
    for name in names:
        name = os.path.basename(str(name)); src = os.path.join(DOWNLOADS, name)
        if not os.path.exists(src): out.append((name, "NOT IN DOWNLOADS")); continue
        dest = _dest_for(name)
        if not dest: out.append((name, "NOT AN ALLOWED FILE")); continue
        nv, iv = file_version(src), (file_version(dest) if os.path.exists(dest) else None)
        if nv is not None and iv is not None:
            if nv < iv:  out.append((name, "v%d is OLDER than the installed v%d - skipped" % (nv, iv))); continue
            if nv == iv: out.append((name, "v%d is already installed - skipped" % nv)); continue
        elif os.path.exists(dest) and os.path.getmtime(src) <= os.path.getmtime(dest):
            out.append((name, "older than the installed copy - skipped")); continue
        key = lambda p: (file_version(p) or -1, os.path.getmtime(p))
        if dest not in newest or key(src) > key(newest[dest]): newest[dest] = src
    for dest, src in newest.items():
        for name in names:
            s2 = os.path.join(DOWNLOADS, os.path.basename(str(name)))
            if os.path.exists(s2) and s2 != src and _dest_for(os.path.basename(s2)) == dest:
                out.append((os.path.basename(s2), "older copy - skipped (left in Downloads)"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.exists(dest): shutil.copy2(dest, dest + ".prev")
        shutil.move(src, dest); out.append((os.path.basename(src), "installed -> " + dest))
        if dest.endswith("papaduck_local.py"): restart = True
    return out, restart

_server = None
_restarting = threading.Event()   # v21
def running_version():
    """v21: the version of a helper already answering on the port, or None."""
    try:
        with urllib.request.urlopen(ORIGIN + "/ping", timeout=3) as r:
            return int(json.loads(r.read().decode()).get("version"))
    except Exception:
        return None

def spawn_new_copy():
    """v21: start a fresh, detached copy of the helper file now on disk. Returns True if started."""
    argv = [sys.executable, os.path.abspath(__file__)]
    if os.name != "nt":
        subprocess.Popen(argv, cwd=BASE, close_fds=True, start_new_session=True); return True
    DETACHED, NEWGRP, NOWIN, BREAKAWAY = 0x00000008, 0x00000200, 0x08000000, 0x01000000
    for flags in (DETACHED | NEWGRP | NOWIN | BREAKAWAY, DETACHED | NEWGRP | NOWIN):
        try:
            subprocess.Popen(argv, cwd=BASE, close_fds=True, creationflags=flags,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except OSError as e:
            log("RESTART spawn attempt failed (%s) - trying without job breakaway" % e)
    return False

def restart_self():
    """v21: the helper restarts ITSELF. v17-v20 exited and waited for Task Scheduler's 'restart on
    failure' - on 2026-09-22 that never came back and he needed PowerShell. Now: release the port,
    launch the new file as a detached process, then exit. Exit code stays 3, so if Windows ALSO
    relaunches, that second copy sees v21 already answering on /ping and quietly exits."""
    _restarting.set()          # keeps the main thread alive after serve_forever returns
    time.sleep(0.8); log("RESTART - releasing the port and starting the new file myself")
    try:
        if _server: _server.shutdown(); _server.server_close()
    except Exception as e: log("RESTART shutdown: %s" % e)
    try:
        ok = spawn_new_copy(); log("RESTART new copy %s" % ("started" if ok else "NOT started - Task Scheduler will relaunch"))
    except Exception as e:
        log("RESTART spawn error %s - Task Scheduler will relaunch" % e)
    os._exit(3)

def downloads_candidates(max_age_h=48):
    """Recognised files modified in the last 48 h, newest first; only the newest per destination is 'newest'."""
    cutoff = time.time() - max_age_h * 3600; rows = []
    for p in glob.glob(os.path.join(DOWNLOADS, "*")):
        n = os.path.basename(p)
        if os.path.getmtime(p) < cutoff: continue
        if _dest_for(n) or _looks_like_ours(n): rows.append((os.path.getmtime(p), n))
    rows.sort(reverse=True); seen = set(); out = []
    for m, n in rows:
        d = _dest_for(n); when = time.strftime("%H:%M", time.localtime(m))
        if not d:
            out.append({"name": n, "newest": False, "when": when,
                        "note": "not a name I install - tell Claude this exact filename"}); continue
        out.append({"name": n, "newest": d not in seen, "when": when, "dest": d}); seen.add(d)
    return out

def recent_runs(n=40):
    files = sorted(glob.glob(os.path.join(RUNS, "*.jsonl")))[-3:]
    rows = []
    for f in files:
        for line in open(f, encoding="utf-8"):
            try: rows.append(json.loads(line))
            except Exception: pass
    return rows[-n:][::-1]

# ------------------------------------------------------------------ regression guard (v8)
def undo_regressions():
    """If a managed file's .prev is NEWER than the file itself, the last install replaced a newer
    copy with an older one (seen 2026-09-19: a stray 'papaduck_ebay (2).py' in Downloads overwrote
    the current eBay script). Put the newer one back and say so."""
    fixed = []
    for _, d in INSTALL:
        if os.path.isdir(d): continue
        prev = d + ".prev"
        try:
            if os.path.exists(prev) and os.path.exists(d) and os.path.getmtime(prev) > os.path.getmtime(d) + 1:
                bad = d + ".regressed"
                shutil.copy2(d, bad); shutil.copy2(prev, d); fixed.append("%s restored from .prev (older copy kept as %s)" % (os.path.basename(d), os.path.basename(bad)))
        except Exception as e:
            fixed.append("%s: could not check (%s)" % (os.path.basename(d), e))
    if fixed:
        txt = "\n".join(fixed); log("REGRESSION-GUARD\n" + txt)
        archive("regression-guard", "", "warning", txt, "an older file had replaced a newer one; the newer one is back")
    return fixed

# ------------------------------------------------------------------ auto-install watcher (v7)
AUTO_EVERY   = 15          # seconds between scans
AUTO_SETTLE  = 3           # a file must stop growing for this long before we touch it
_auto_seen   = {}          # path -> mtime already handled

def _stable(path):
    """Don't grab a file the browser is still writing."""
    try:
        a = os.path.getsize(path); time.sleep(AUTO_SETTLE); return a == os.path.getsize(path)
    except Exception:
        return False

def auto_install_loop():
    """Papa Duck's rule, 2026-09-19: 'I make lots of changes to the apps this has to be more
    automatic.' He downloads a file; it installs itself. No Install tab, no PowerShell.
    Only files this helper already recognises, only from Downloads, only newer than last seen."""
    time.sleep(5)
    while True:
        try:
            cutoff = time.time() - 48 * 3600
            cands = []
            for p in glob.glob(os.path.join(DOWNLOADS, "*")):
                n = os.path.basename(p)
                if not _dest_for(n): continue
                try: mt = os.path.getmtime(p)
                except OSError: continue
                if mt < cutoff or _auto_seen.get(p) == mt: continue
                cands.append((mt, p, n))
            if cands and _busy:
                log("AUTO-INSTALL deferred - a run is in progress"); time.sleep(AUTO_EVERY); continue
            if cands:
                cands.sort()
                names = []
                for mt, p, n in cands:
                    _auto_seen[p] = mt
                    if _stable(p): names.append(n)
                if names:
                    res, restart = install_from_downloads(names)
                    txt = "\n".join("%s: %s" % r for r in res)
                    log("AUTO-INSTALL\n" + txt)
                    archive("auto-install", "", "ok", txt, "installed automatically from Downloads - no click needed")
                    if restart:
                        while _busy: time.sleep(2)          # never restart under a running job
                        threading.Thread(target=restart_self, daemon=True).start(); return
        except Exception as e:
            log("AUTO-INSTALL-ERROR %s" % e)
        time.sleep(AUTO_EVERY)

# ------------------------------------------------------------------ ETSY (v23, 2026-09-29)
# Papa Duck: eBay + AbeBooks get every book; Etsy gets ONLY books he switched "Etsy ON" in Drafts,
# and ONLY books 20+ years old. Claude builds PapaDuck_Etsy_*.json at blast off; this sends it.
# Ported step-for-step from Run-EtsyBatch.ps1 v3/v4 (proven live on 400+ listings, July 2026):
#   refresh token ONCE (it rotates - saved immediately) -> createDraftListing (form) -> every photo in
#   order (multipart, max 20) -> SKU via inventory read-modify-write (readiness_state_id on every
#   offering) -> state=active -> read back. Master section 12 is the contract.
import uuid, datetime
ETSY_RESULTS = os.path.join(ETSYDIR, "etsy_results.json")
ETSY_CLIENT, ETSY_SHOP = "n9os0m3u7hm64f7cdqzb2fgu", "65331509"
ETSY_READY, ETSY_RETURN = 1502395825992, 1503578809801
ETSY_PROFILES = {"311855277605": "Paperback", "312059762493": "Hardcover 2 lb", "311987833328": "Textbook 5 lb", "311987874784": "Oversize"}
ETSY_WHEN = ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s",
             "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"]
ETSY_BANNED = ["piracy", "pirated", "bootleg", "counterfeit", "unauthorized", "unauthorised", "hologram", "regional printing",
               "international edition", "grey market", "gray market", "photocopy", "photocopies", "photocopied",
               "free online", "pdf", "download"]
F_ETSY_ID, F_ETSY_DATE, F_ETSY_PROF = "fld3GGIsBv0tXqjFL", "fldTwkJvnhIsmWJbE", "fldDiRDilHHcBiKSV"
_etsy_lock = threading.Lock()

def etsy_cred_dir():
    for d in (ETSYDIR, r"C:\ShelfIQ"):
        if os.path.exists(os.path.join(d, "etsy_tokens.json")) and os.path.exists(os.path.join(d, "etsy_shared_secret.txt")):
            return d
    return ""

def _etsy_when_ok(when, year):
    """when_made must be a real Etsy value AND contain the publication year."""
    if when not in ETSY_WHEN: return False
    if when in ("1800s", "1700s"): s = int(when[:4]); return s <= year < s + 100
    if re.match(r"^\d{4}s$", when): s = int(when[:4]); return s <= year < s + 10
    if when == "2000_2006": return 2000 <= year <= 2006
    if when == "before_2007": return year < 2007
    if when == "before_1700": return year < 1700
    return False

def etsy_preflight(books):
    """Master section 12. Any failure refuses the WHOLE file - nothing goes to Etsy."""
    cutoff = datetime.date.today().year - 20; bad = []
    for b in books:
        sku = str(b.get("sku", "")); t = str(b.get("title", "")); d = str(b.get("description", ""))
        if not PD_RE.match(sku): bad.append("%s: not a PD number" % sku); continue
        try: y = int(str(b.get("pub_year", "")).strip())
        except ValueError: y = 0
        if not y: bad.append("%s: no confirmed year - Etsy only takes books 20+ years old" % sku)
        elif y > cutoff: bad.append("%s: %d is under 20 years old (needs %d or older)" % (sku, y, cutoff))
        elif not _etsy_when_ok(str(b.get("when_made", "")), y): bad.append("%s: when_made '%s' does not fit year %d" % (sku, b.get("when_made"), y))
        if not t.strip() or len(t) > 140: bad.append("%s: title blank or over 140 characters" % sku)
        if t.count("&") > 1: bad.append("%s: more than one & in the title" % sku)
        caps = [w for w in t.split() if re.match(r"^[A-Z]{2}", w)]
        if len(caps) > 3: bad.append("%s: %d all-caps words in the title (Etsy allows 3)" % (sku, len(caps)))
        low = (t + " " + d).lower()
        hits = [w for w in ETSY_BANNED if re.search(r"\b" + re.escape(w) + r"\b", low)]
        if hits: bad.append("%s: Etsy trigger words %s" % (sku, ", ".join(hits)))
        if not d.strip(): bad.append("%s: blank description" % sku)
        if re.search(r"<[a-zA-Z/][^>]*>", d): bad.append("%s: HTML in description" % sku)
        if any(ord(c) > 127 for c in t + d): bad.append("%s: non-ASCII characters" % sku)
        try:
            if float(b.get("price")) <= 0: bad.append("%s: price not above 0" % sku)
        except Exception: bad.append("%s: bad price" % sku)
        try:
            if int(b.get("quantity")) < 1: bad.append("%s: quantity below 1" % sku)
        except Exception: bad.append("%s: bad quantity" % sku)
        if str(b.get("shipping_profile_id")) not in ETSY_PROFILES: bad.append("%s: unknown shipping profile %s" % (sku, b.get("shipping_profile_id")))
        imgs = b.get("image_urls") or []
        if not imgs: bad.append("%s: no photos" % sku)
        if any(not str(u).startswith("https://") for u in imgs): bad.append("%s: a photo URL is not https" % sku)
    return bad

def _etsy_results():
    try: return json.load(open(ETSY_RESULTS, encoding="utf-8"))
    except Exception: return {}

def _etsy_save_results(r):
    os.makedirs(ETSYDIR, exist_ok=True); tmp = ETSY_RESULTS + ".tmp"
    json.dump(r, open(tmp, "w", encoding="utf-8"), indent=1); os.replace(tmp, ETSY_RESULTS)

class EtsyAPI:
    def __init__(self):
        d = etsy_cred_dir()
        if not d: raise ValueError("Etsy keys not found - expected etsy_tokens.json and etsy_shared_secret.txt in C:\\PapaDuck\\etsy or C:\\ShelfIQ")
        self.dir = d
        self.secret = open(os.path.join(d, "etsy_shared_secret.txt"), encoding="utf-8-sig").read().strip()
        if cloud_mode():                       # v42: the cloud owns the Etsy refresh token
            self.tok = cloud_etsy_token(); return
        old = json.load(open(os.path.join(d, "etsy_tokens.json"), encoding="utf-8-sig"))
        body = json.dumps({"grant_type": "refresh_token", "client_id": ETSY_CLIENT, "refresh_token": old["refresh_token"]}).encode()
        req = urllib.request.Request("https://api.etsy.com/v3/public/oauth/token", data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=40) as r: new = json.loads(r.read().decode())
        if not new.get("access_token") or not new.get("refresh_token"): raise ValueError("Etsy did not return a new token")
        p = os.path.join(d, "etsy_tokens.json"); tmp = p + ".tmp"       # the refresh token ROTATES - save it now, atomically
        shutil.copy2(p, p + ".prev"); json.dump(new, open(tmp, "w", encoding="utf-8"), indent=1); os.replace(tmp, p)
        self.tok = new["access_token"]

    def _hdr(self, extra=None):
        h = {"x-api-key": "%s:%s" % (ETSY_CLIENT, self.secret), "Authorization": "Bearer " + self.tok, "Accept": "application/json"}
        h.update(extra or {}); return h

    def call(self, method, path, form=None, js=None, raw=None, ctype=None):
        url = "https://openapi.etsy.com/v3/application" + path
        data, h = None, {}
        if form is not None: data = urllib.parse.urlencode(form).encode(); h["Content-Type"] = "application/x-www-form-urlencoded"
        elif js is not None: data = json.dumps(js).encode(); h["Content-Type"] = "application/json"
        elif raw is not None: data = raw; h["Content-Type"] = ctype
        for attempt in range(3):
            req = urllib.request.Request(url, data=data, headers=self._hdr(h), method=method)
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    txt = r.read().decode("utf-8", "replace"); return json.loads(txt) if txt.strip() else {}
            except urllib.error.HTTPError as e:
                msg = e.read().decode("utf-8", "replace")[:500]
                if e.code in (429, 500, 502, 503, 504) and attempt < 2: time.sleep(3 * (attempt + 1)); continue
                raise ValueError("Etsy %s %s -> %d %s" % (method, path, e.code, msg))

    def upload_image(self, lid, img_bytes, rank, name):
        b = "----PapaDuck" + uuid.uuid4().hex
        body = (("--%s\r\nContent-Disposition: form-data; name=\"rank\"\r\n\r\n%d\r\n" % (b, rank)).encode()
                + ("--%s\r\nContent-Disposition: form-data; name=\"image\"; filename=\"%s\"\r\nContent-Type: image/jpeg\r\n\r\n" % (b, name)).encode()
                + img_bytes + ("\r\n--%s--\r\n" % b).encode())
        return self.call("POST", "/shops/%s/listings/%s/images" % (ETSY_SHOP, lid), raw=body, ctype="multipart/form-data; boundary=" + b)

    def set_inventory(self, lid, sku=None, qty=None):
        """Read-modify-write. GET omits readiness_state_id but PUT requires it on EVERY offering (Failure #3)."""
        inv = self.call("GET", "/listings/%s/inventory" % lid)
        products = []
        for p in inv.get("products") or []:
            offs = []
            for o in p.get("offerings") or []:
                pr = o.get("price") or {}
                amt = float(pr.get("amount", 0)) / float(pr.get("divisor", 100) or 100)
                offs.append({"price": round(amt, 2), "quantity": int(qty if qty is not None else o.get("quantity", 1)),
                             "is_enabled": bool(o.get("is_enabled", True)), "readiness_state_id": int(o.get("readiness_state_id") or ETSY_READY)})
            products.append({"sku": sku if sku is not None else (p.get("sku") or ""), "property_values": [], "offerings": offs})
        return self.call("PUT", "/listings/%s/inventory" % lid, js={"products": products})

def _fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        ct = (r.headers.get("Content-Type") or "").lower(); b = r.read()
    if "image" not in ct or len(b) < 4000: raise ValueError("photo not reachable (%s, %d bytes) %s" % (ct, len(b), url))
    return b

def _at_find(tok, pd, fields):
    """Inventory records for one PD. Formula by field ID first, by the field NAME if Airtable rejects the ID."""
    for ref in (F_TRACK, "Tracking"):
        qs = [("filterByFormula", "{%s}='%s'" % (ref, pd)), ("returnFieldsByFieldId", "true")] + [("fields[]", f) for f in fields]
        url = "https://api.airtable.com/v0/%s/%s?%s" % (AT_BASE, AT_INV, urllib.parse.urlencode(qs))
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + tok}), timeout=30) as r:
                return json.loads(r.read().decode()).get("records", [])
        except urllib.error.HTTPError as e:
            if e.code != 422: raise
    return []

def at_etsy_writeback(pd, lid, profile):
    """Etsy ListingID / Listed Date / Shipping Profile onto the Inventory record. Returns a status line."""
    tok = at_token()
    if not tok: return "Airtable token not set - ListingID not written"
    try:
        recs = _at_find(tok, pd, [F_TRACK])
        if not recs: return "Airtable: no Inventory record for %s - write the ListingID by hand" % pd
        body = json.dumps({"records": [{"id": recs[0]["id"], "fields": {F_ETSY_ID: str(lid), F_ETSY_DATE: time.strftime("%Y-%m-%d"), F_ETSY_PROF: str(profile)}}], "typecast": True}).encode()
        req = urllib.request.Request("https://api.airtable.com/v0/%s/%s" % (AT_BASE, AT_INV), data=body,
                                     headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}, method="PATCH")
        with urllib.request.urlopen(req, timeout=30): pass
        return "Airtable updated"
    except Exception as e:
        return "Airtable write-back failed: %s" % str(e)[:150]

def at_etsy_id(pd):
    tok = at_token()
    if not tok: return ""
    try:
        recs = _at_find(tok, pd, [F_ETSY_ID])
        return re.sub(r"\D", "", str((recs[0].get("fields") or {}).get(F_ETSY_ID, ""))) if recs else ""
    except Exception:
        return ""

def _sec_key(t):
    import html as _h
    t = _h.unescape(str(t or "")).replace("\u2019", "'").lower()
    return " ".join(re.sub(r"[^a-z0-9&' ]", " ", t).split())

def etsy_sections(api):
    """v25: shop section title -> shop_section_id (Papa Duck 09-30: 'this needs to happen automatically')."""
    try:
        d = api.call("GET", "/shops/%s/sections" % ETSY_SHOP)
        return {_sec_key(x.get("title")): int(x.get("shop_section_id")) for x in (d.get("results") or []) if x.get("shop_section_id")}
    except Exception as e:
        log("ETSY-SECTIONS %s" % e); return {}

def etsy_section_id(api, secs, name):
    """v25: id for a section title; CREATES the section in the shop if it does not exist yet (e.g. Christmas, Easter)."""
    k = _sec_key(name)
    if not k: return None
    if k in secs: return secs[k]
    try:
        d = api.call("POST", "/shops/%s/sections" % ETSY_SHOP, form={"title": str(name).strip()[:24]})
        sid = int(d.get("shop_section_id") or 0)
        if sid: secs[k] = sid; log("ETSY-SECTION created %s -> %s" % (name, sid)); return sid
    except Exception as e:
        log("ETSY-SECTION create failed %s: %s" % (name, e))
    return None

def etsy_update_file(path, only=None):
    """v25: for books ALREADY on Etsy, set the title and shop section from the file, then read both back."""
    books = json.load(open(path, encoding="utf-8")); books = [books] if isinstance(books, dict) else books
    if only: books = [b for b in books if b.get("sku") in only]
    res = _etsy_results(); lines = ["ETSY UPDATE (titles + sections) - %s" % os.path.basename(path)]
    todo = [(b, (res.get(b["sku"]) or {}).get("listing_id") or at_etsy_id(b["sku"])) for b in books]
    for b, lid in todo:
        if not lid: lines.append("%s  not on Etsy yet - use Send instead" % b["sku"])
    todo = [(b, lid) for b, lid in todo if lid]
    if not todo: return "\n".join(lines + ["", "Nothing to update."]), [], [], "ok"
    prog_start("etsy-update", os.path.basename(path), [b["sku"] for b, _ in todo], {b["sku"]: 2 for b, _ in todo})
    api = EtsyAPI(); secs = etsy_sections(api); done, failed = [], []
    prog_set(stage="updating titles and sections")
    for b, lid in todo:
        sku = b["sku"]; form = {}
        t = str(b.get("title") or "").strip()
        if t and len(t) <= 140 and t.count("&") <= 1 and not any(ord(c) > 127 for c in t): form["title"] = t
        want = str(b.get("section") or "").strip(); sid = etsy_section_id(api, secs, want) if want else None
        if want and not sid: lines.append("%s  section '%s' could not be found or created - left as is" % (sku, want))
        if sid: form["shop_section_id"] = sid
        if not form: lines.append("%s  nothing to change" % sku); prog_set(sku, done=2, state="done", note="nothing to change"); continue
        prog_set(sku, state="sending", done=1, note="updating")
        try:
            api.call("PATCH", "/shops/%s/listings/%s" % (ETSY_SHOP, lid), form=form)
            back = api.call("GET", "/listings/%s" % lid)
            import html as _h
            ok = (("title" not in form) or _h.unescape(str(back.get("title") or "")) == form["title"])   # Etsy returns ' as &#39; and (("shop_section_id" not in form) or int(back.get("shop_section_id") or 0) == sid)
            lines.append("%s  %s  Etsy %s  section: %s  title: %s" % (sku, "UPDATED" if ok else "CHECK THIS ONE", lid, want or "-", back.get("title")))
            (done if ok else failed).append(sku)
            prog_set(sku, done=2, state="done" if ok else "short", note=("section " + want) if ok else "check it")
        except Exception as e:
            failed.append(sku); lines.append("%s  FAILED: %s" % (sku, str(e)[:250])); prog_set(sku, state="failed", note="FAILED")
    lines.append(""); lines.append(("*** NOT CLOSED - check: %s ***" % ", ".join(failed)) if failed else "CLOSED - every title and section updated and read back.")
    prog_end("NOT CLOSED" if failed else "CLOSED")
    return "\n".join(lines), done, failed, ("ok" if not failed else "warning")

def etsy_list_file(path, only=None):
    books = json.load(open(path, encoding="utf-8"))
    if isinstance(books, dict): books = [books]
    if only: books = [b for b in books if b.get("sku") in only]
    lines = ["ETSY LIST - %s (%d book%s)" % (os.path.basename(path), len(books), "" if len(books) == 1 else "s")]
    bad = etsy_preflight(books)
    if bad:
        return "\n".join(lines + ["REFUSED - nothing was sent to Etsy. Fix the file (tell Claude):"] + ["  " + x for x in bad]), [], [], "refused"
    res = _etsy_results(); done, failed = [], []
    todo = [b for b in books if (res.get(b["sku"]) or {}).get("status") != "OK"]
    for b in books:
        if b not in todo: lines.append("%s  already listed on Etsy (%s) - skipped" % (b["sku"], res[b["sku"]].get("listing_id")))
    if not todo:
        return "\n".join(lines + ["", "CLOSED - every book in this file is already on Etsy."]), [], [], "ok"
    prog_start("etsy", os.path.basename(path), [b["sku"] for b in todo], {b["sku"]: min(20, len(b.get("image_urls") or [])) + 2 for b in todo})
    prog_set(stage="refreshing the Etsy token")
    api = EtsyAPI()
    lines.append("Etsy token refreshed once for the run (keys in %s)" % api.dir)
    secs = etsy_sections(api)
    prog_set(stage="sending to Etsy")
    for b in todo:
        sku = b["sku"]; lid = ""; prof = str(b["shipping_profile_id"])
        imgs = list(b.get("image_urls") or [])
        trimmed = len(imgs) > 20
        imgs = imgs[:20]
        prog_set(sku, state="sending", note="creating the draft")
        sid = etsy_section_id(api, secs, b.get("section")) if b.get("section") else None
        try:
            d = api.call("POST", "/shops/%s/listings" % ETSY_SHOP, form={
                "quantity": int(b["quantity"]), "title": b["title"], "description": b["description"], "price": "%.2f" % float(b["price"]),
                "who_made": "someone_else", "when_made": b["when_made"], "taxonomy_id": int(b["taxonomy_id"]),
                "shipping_profile_id": int(prof), "readiness_state_id": ETSY_READY, "return_policy_id": ETSY_RETURN,
                "type": "physical", "is_supply": "false", **({"shop_section_id": sid} if sid else {})})
            if b.get("section") and not sid: lines.append("%s  section '%s' could not be found or created - listed without a section" % (sku, b.get("section")))
            lid = str(d.get("listing_id") or "")
            if not lid: raise ValueError("Etsy returned no listing_id: %s" % json.dumps(d)[:200])
            prog_set(sku, done=1, note="draft %s" % lid)
            for i, u in enumerate(imgs, 1):
                prog_set(sku, note="photo %d of %d" % (i, len(imgs)))
                api.upload_image(lid, _fetch(u), i, "%s_%d.jpg" % (sku, i))
                prog_set(sku, done=1 + i)
            prog_set(sku, note="going live")
            try: api.set_inventory(lid, sku=sku); sku_ok = True
            except Exception as e: sku_ok = False; lines.append("%s  SKU not set (%s) - listing is still fine" % (sku, str(e)[:120]))
            api.call("PATCH", "/shops/%s/listings/%s" % (ETSY_SHOP, lid), form={"state": "active"})
            back = api.call("GET", "/listings/%s?includes=Images" % lid)
            n_img = len(back.get("images") or [])
            st = back.get("state")
            ok = (st == "active") and n_img == len(imgs)
            res[sku] = {"listing_id": lid, "status": "OK" if ok else "CHECK", "when": time.strftime("%Y-%m-%d %H:%M"), "photos": n_img, "profile": prof}
            _etsy_save_results(res)
            at = at_etsy_writeback(sku, lid, prof)
            lines.append("%s  %s  Etsy %s  photos %d/%d%s  %s  %s  https://www.etsy.com/listing/%s" % (
                sku, "LIVE" if ok else "CHECK THIS ONE", lid, n_img, len(imgs),
                " (trimmed from %d - Etsy's limit is 20; eBay keeps all)" % len(b["image_urls"]) if trimmed else "",
                "SKU set" if sku_ok else "no SKU", at, lid))
            (done if ok else failed).append(sku)
            prog_set(sku, done=len(imgs) + 2, state="done" if ok else "short", note=("LIVE  %d/%d photos" % (n_img, len(imgs))) if ok else ("CHECK  %d/%d photos" % (n_img, len(imgs))))
        except Exception as e:
            failed.append(sku)
            res[sku] = {"listing_id": lid, "status": "FAILED", "when": time.strftime("%Y-%m-%d %H:%M"), "error": str(e)[:300]}
            _etsy_save_results(res)
            lines.append("%s  FAILED: %s%s" % (sku, str(e)[:300], ("  (draft %s is sitting in your Etsy drafts - not live)" % lid) if lid else ""))
            prog_set(sku, state="failed", note="FAILED: " + str(e)[:80])
    lines.append("")
    lines.append(("*** NOT CLOSED - check: %s ***" % ", ".join(failed)) if failed else "CLOSED - every book is live on Etsy with every photo.")
    prog_end("NOT CLOSED" if failed else "CLOSED")
    return "\n".join(lines), done, failed, ("ok" if not failed else "warning")

def etsy_sync(targets):
    """Sold somewhere else -> make Etsy match what is left on the shelf. targets = {PD: copies left}.
    0 left = take it off Etsy (inactive). Some left = set the Etsy quantity to exactly that number.
    Setting a number (never 'minus one') means running the same orders file twice changes nothing."""
    res = _etsy_results(); lines = []; api = None
    for pd, left in targets.items():
        left = max(0, int(left))
        lid = (res.get(pd) or {}).get("listing_id") or at_etsy_id(pd)
        if not lid: lines.append("%s: not on Etsy - nothing to do" % pd); continue
        try:
            if api is None: api = EtsyAPI()
            cur = api.call("GET", "/listings/%s" % lid)
            st, q = cur.get("state"), int(cur.get("quantity") or 0)
            if st != "active":
                lines.append("%s: Etsy %s already off (%s) - nothing to do" % (pd, lid, st)); continue
            if left == 0:
                api.call("PATCH", "/shops/%s/listings/%s" % (ETSY_SHOP, lid), form={"state": "inactive"})
                back = api.call("GET", "/listings/%s" % lid)
                lines.append("%s: Etsy %s %s" % (pd, lid, ("OFF Etsy (" + str(back.get("state")) + ")") if back.get("state") != "active" else "STILL ACTIVE - check it in Shop Manager"))
            elif q == left:
                lines.append("%s: Etsy %s already shows %d - nothing to do" % (pd, lid, q))
            else:
                api.set_inventory(lid, qty=left)
                back = api.call("GET", "/listings/%s" % lid)
                ok = int(back.get("quantity") or 0) == left
                lines.append("%s: Etsy %s quantity %d -> %s%s" % (pd, lid, q, back.get("quantity"), " (still live)" if ok else "  QUANTITY DID NOT CHANGE - check it in Shop Manager"))
        except Exception as ex:
            lines.append("%s: Etsy update FAILED %s - check it in Shop Manager" % (pd, str(ex)[:200]))
    return "\n".join(lines)


# ------------------------------------------------------------------ AMAZON SP-API (v26, 2026-10-01)
# Papa Duck: "the papa duck draft needs to do the same for Amazon eligible if I am not restricted" + "also indicate
# if it is a good fit for amazon, based on sales ranking". Keys live ONLY in C:\PapaDuck\amazon_credentials.ini on this
# PC (as promised to Amazon in the developer profile). This helper asks the cloud which drafts need a check, asks
# Amazon, and sends back ONLY the result (eligible / restricted / not on Amazon, rank, lowest used price, fit).
AMZ_INI   = os.path.join(BASE, "amazon_credentials.ini")
AMZ_MKT   = "ATVPDKIKX0DER"
AMZ_HOST  = "https://sellingpartnerapi-na.amazon.com"
SUPA_URL  = "https://gdwxwiwckxthwcsrgywh.supabase.co"
SUPA_ANON = "sb_publishable_ru5tlajGZWEtUgFzKIlI_Q_UkVhfi7v"
AMZ_CLOUD_SECRET = "PASTE_FROM_WORKING_COPY"   # GitHub copy: redacted. Only lets this helper read ISBNs / write Amazon results
AMZ_COND  = {"Brand New": "new_new", "New": "new_new", "Like New": "used_like_new", "Very Good": "used_very_good",
             "Good": "used_good", "Acceptable": "used_acceptable"}
AMZ_EVERY = 120
_amz_lock = threading.Lock()

def amz_creds():
    if not os.path.exists(AMZ_INI): return {}
    c = configparser.ConfigParser(); c.read(AMZ_INI, encoding="utf-8")
    try: d = dict(c["amazon"])
    except KeyError: return {}
    return d if all(d.get(k) for k in ("client_id", "client_secret", "refresh_token", "seller_id")) else {}

class AmazonAPI:
    def __init__(self):
        self.c = amz_creds()
        if not self.c: raise ValueError("Amazon keys not saved yet - Dispatch > Settings > Amazon")
        body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": self.c["refresh_token"],
                                       "client_id": self.c["client_id"], "client_secret": self.c["client_secret"]}).encode()
        req = urllib.request.Request("https://api.amazon.com/auth/o2/token", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r: j = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            raise ValueError("Amazon login failed (%d): %s - check the Client ID / Secret / refresh token in Settings" % (e.code, e.read().decode(errors="replace")[:200]))
        self.tok = j["access_token"]; self.exp = time.time() + int(j.get("expires_in", 3600)) - 120
    def get(self, path, params):
        url = AMZ_HOST + path + "?" + urllib.parse.urlencode(params, doseq=True)
        for a in range(5):
            req = urllib.request.Request(url, headers={"x-amz-access-token": self.tok, "Accept": "application/json", "User-Agent": "PapaDuckDispatch/26 (Language=Python)"})
            try:
                with urllib.request.urlopen(req, timeout=40) as r: return json.loads(r.read().decode() or "{}")
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503) and a < 4: time.sleep(2.5 * (a + 1)); continue
                raise ValueError("Amazon %s -> %d %s" % (path.split("/")[1], e.code, e.read().decode(errors="replace")[:240]))

def _isbns(raw):
    """Every valid ISBN-13 / ISBN-10 in a messy field ('ISBN-10: 1-59915-055-7 / ISBN-13: 978-...')."""
    out = []
    for m in re.findall(r"[0-9][0-9\- ]{8,16}[0-9Xx]", str(raw or "")):
        c = re.sub(r"[^0-9Xx]", "", m).upper()
        if len(c) == 13 and c.isdigit() and (-sum(int(x) * (1, 3)[i % 2] for i, x in enumerate(c[:12]))) % 10 == int(c[12]): out.append(c)
        elif len(c) == 10 and (c[:9].isdigit() and (c[9].isdigit() or c[9] == "X")) and \
             sum((10 - i) * (10 if x == "X" else int(x)) for i, x in enumerate(c)) % 11 == 0: out.append(c)
    return list(dict.fromkeys(out))

def _words(t): return set(w for w in re.sub(r"[^a-z0-9 ]", " ", str(t or "").lower()).split() if len(w) > 2 and w not in ("the", "and", "for", "with"))

def _rank_of(item):
    """Books rank: the display-group rank (e.g. 'Books') first; a category rank only if that's all Amazon gives."""
    disp, cls = [], []
    for sr in item.get("salesRanks") or []:
        disp += [g.get("rank") for g in (sr.get("displayGroupRanks") or []) if g.get("rank")]
        cls += [g.get("rank") for g in (sr.get("classificationRanks") or []) if g.get("rank")]
    return min(disp) if disp else (max(cls) if cls else None)

def amz_find(api, isbn_raw, title, author):
    params = {"marketplaceIds": AMZ_MKT, "includedData": "summaries,salesRanks,productTypes"}
    for code in _isbns(isbn_raw):
        j = api.get("/catalog/2022-04-01/items", dict(params, identifiers=code, identifiersType="ISBN"))
        items = j.get("items") or []
        if items: return items[0], "ISBN " + code
    if title:                                    # no ISBN (or Amazon doesn't know it): title + author, only a close match
        j = api.get("/catalog/2022-04-01/items", dict(params, keywords=(str(title) + " " + str(author or "")).strip()[:180], pageSize=5))
        want = _words(title)
        for it in j.get("items") or []:
            name = ((it.get("summaries") or [{}])[0]).get("itemName", "")
            if want and len(want & _words(name)) / len(want) >= 0.75: return it, "title match"
    return None, ""

_keepa_wait = 0.0
def keepa_key():
    if not os.path.exists(AMZ_INI): return ""
    c = configparser.ConfigParser(); c.read(AMZ_INI, encoding="utf-8")
    try: return c["keepa"]["key"].strip()
    except KeyError: return ""

def keepa_stats(asin):
    """Keepa (Pro = ~1 token a minute): rank drops = how many times it sold. Returns {} when out of tokens."""
    global _keepa_wait
    k = keepa_key()
    if not k: return {"keepa": "no key"}
    if time.time() < _keepa_wait: return {"keepa": "waiting"}
    url = "https://api.keepa.com/product?" + urllib.parse.urlencode({"key": k, "domain": 1, "asin": asin, "stats": 180, "history": 0})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept-Encoding": "gzip"}), timeout=40) as r: raw = r.read()
        if raw[:2] == b"\x1f\x8b":                # Keepa ALWAYS gzips its answer (v28 fix)
            import gzip; raw = gzip.decompress(raw)
        j = json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 429: _keepa_wait = time.time() + 65
        return {"keepa": "waiting" if e.code == 429 else "error %d" % e.code}
    except Exception as e:
        return {"keepa": "error " + str(e)[:60]}
    p = (j.get("products") or [{}])[0]; st = p.get("stats") or {}
    cur, a180 = st.get("current") or [], st.get("avg180") or []
    c = lambda arr, i: (arr[i] if len(arr) > i and arr[i] is not None and arr[i] >= 0 else None)
    cents = lambda v: round(v / 100.0, 2) if v else None
    return {"keepa": "ok", "tokens_left": j.get("tokensLeft"),
            "sold_30": st.get("salesRankDrops30"), "sold_90": st.get("salesRankDrops90"), "sold_180": st.get("salesRankDrops180"),
            "bought_month": p.get("monthlySold"), "rank_avg180": c(a180, 3),
            "used_avg180": cents(c(a180, 2)), "new_avg180": cents(c(a180, 1)), "amazon_sells": bool(c(cur, 0))}

def amz_check(api, d):
    """One draft -> result dict stored on the draft (shown in Drafts)."""
    grade = str(d.get("grade") or "")
    cond = AMZ_COND.get(grade, "used_good")
    res = {"grade": grade, "cond": cond, "checked": time.strftime("%Y-%m-%d %H:%M")}
    item, how = amz_find(api, d.get("isbn"), d.get("title"), d.get("author"))
    if not item:
        res.update(status="not_on_amazon", note="No Amazon page found for this book (no ASIN)"); return res
    asin = item.get("asin"); summ = (item.get("summaries") or [{}])[0]
    res.update(asin=asin, amazon_title=summ.get("itemName", "")[:140], matched_by=how, rank=_rank_of(item),
               product_type=((item.get("productTypes") or [{}])[0]).get("productType") or "")
    rj = api.get("/listings/2021-08-01/restrictions", {"asin": asin, "sellerId": api.c["seller_id"], "marketplaceIds": AMZ_MKT, "conditionType": cond})
    reasons = []
    for r in rj.get("restrictions") or []:
        for x in r.get("reasons") or []:
            link = next((l.get("resource") for l in (x.get("links") or []) if l.get("resource")), "")
            reasons.append({"code": x.get("reasonCode", ""), "message": (x.get("message") or "")[:300], "link": link})
    res["status"] = "restricted" if reasons else "ok"
    if reasons: res["reasons"] = reasons
    try:                                          # lowest price + competition in THIS condition family (used / new)
        oj = api.get("/products/pricing/v0/items/%s/offers" % asin, {"MarketplaceId": AMZ_MKT, "ItemCondition": "New" if cond == "new_new" else "Used"})
        summ2 = (oj.get("payload") or {}).get("Summary") or {}
        lows = [float((p.get("LandedPrice") or p.get("ListingPrice") or {}).get("Amount") or 0) for p in summ2.get("LowestPrices") or []]
        lows = [x for x in lows if x > 0]
        res["low_price"] = round(min(lows), 2) if lows else None
        res["offers"] = sum(int(n.get("OfferCount") or 0) for n in summ2.get("NumberOfOffers") or [])
        if not res.get("rank"):
            sr = summ2.get("SalesRankings") or []
            if sr: res["rank"] = sr[0].get("Rank")
        time.sleep(2.1)                           # pricing API allows ~0.5 requests/second
    except Exception as e:
        res["price_note"] = str(e)[:120]
    if res["status"] == "ok":                    # sales history only matters if he can list it
        res.update(keepa_stats(asin))
    # FIT - same thresholds he already uses for buying (BSR < 500K fast; > 2M = HOLD). Net is an ESTIMATE:
    # lowest price x 0.85 (15% referral) - $1.80 closing fee; the $3.99 book shipping credit is taken as covering postage.
    rank = res.get("rank"); low = res.get("low_price")
    net = round(low * 0.85 - 1.80, 2) if low else None; res["est_net"] = net
    if res["status"] != "ok": fit = "No - restricted"
    elif res.get("sold_180") is not None:        # Keepa: rank drops in 180 days ~= copies sold
        s180 = res["sold_180"] or 0
        if s180 >= 12 and (net is None or net >= 5): fit = "Good"
        elif s180 >= 3 and (net is None or net >= 3): fit = "OK - slower"
        else: fit = "Poor"
    elif rank is None: fit = "Unknown - no sales rank"
    elif rank <= 500000 and (net is None or net >= 5): fit = "Good"
    elif rank <= 2000000 and (net is None or net >= 3): fit = "OK - slower"
    else: fit = "Poor"
    res["fit"] = fit
    res["fit_why"] = ("sold ~%s in 180 days (%s in 30) | " % (res["sold_180"], res.get("sold_30")) if res.get("sold_180") is not None else "") + "rank %s%s%s" % ("{:,}".format(rank) if rank else "?", (" | lowest %s $%.2f" % ("new" if cond == "new_new" else "used", low)) if low else "",
                                     (" | %d offers | est. net $%.2f" % (res.get("offers") or 0, net)) if net is not None else "")
    return res

def _supa_rpc(fn, body):
    req = urllib.request.Request(SUPA_URL + "/rest/v1/rpc/" + fn, data=json.dumps(body).encode(), method="POST",
                                 headers={"apikey": SUPA_ANON, "Authorization": "Bearer " + SUPA_ANON, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=40) as r: return json.loads(r.read().decode() or "null")

def amz_sweep(limit=10):
    """Check the drafts the cloud says need it; write results back. Returns a text report."""
    if not amz_creds(): return "Amazon keys not saved - nothing checked"
    if not _amz_lock.acquire(blocking=False): return "an Amazon check is already running"
    try:
        todo = _supa_rpc("pd_amazon_pending", {"p_secret": AMZ_CLOUD_SECRET, "p_limit": limit}) or []
        if not todo: return "nothing waiting for an Amazon check"
        api = AmazonAPI(); out = {}; lines = []
        for d in todo:
            try: r = amz_check(api, d)
            except Exception as e: r = {"status": "error", "note": str(e)[:240], "grade": d.get("grade"), "checked": time.strftime("%Y-%m-%d %H:%M")}
            out[d["pd"]] = r
            lines.append("%s  %s  %s  %s" % (d["pd"], r.get("status"), r.get("fit", ""), r.get("fit_why") or r.get("note") or ""))
        n = _supa_rpc("pd_amazon_set", {"p_secret": AMZ_CLOUD_SECRET, "p_results": out})
        txt = "AMAZON CHECK - %d book(s), %s saved to Drafts\n" % (len(out), n) + "\n".join(lines)
        archive("amazon-check", ", ".join(out)[:250], "warning" if any(v.get("status") == "error" for v in out.values()) else "ok", txt, txt)
        return txt
    finally:
        _amz_lock.release()


# ------------------------------------------------------------------ AMAZON LISTING + SOLD SYNC (v29, 2026-10-01)
# Papa Duck: only books whose Amazon fit is GOOD go to Amazon (he can switch any book off in Drafts). Claude builds
# PapaDuck_Amazon_*.json at blast off; this sends it as an OFFER on the existing Amazon page (Listings Items API,
# LISTING_OFFER_ONLY): SKU = PD number, condition from his grade, Block 1 as the condition note, price, quantity.
# "Preview" asks Amazon to check every book without listing anything (mode=VALIDATION_PREVIEW).
AMZ_RESULTS = os.path.join(AMZDIR, "amazon_results.json")
AMZ_CONDS = {"new_new", "used_like_new", "used_very_good", "used_good", "used_acceptable"}
_amzlist_lock = threading.Lock()

def _amz_results():
    try: return json.load(open(AMZ_RESULTS, encoding="utf-8"))
    except Exception: return {}

def _amz_save_results(r):
    os.makedirs(AMZDIR, exist_ok=True); tmp = AMZ_RESULTS + ".tmp"
    json.dump(r, open(tmp, "w", encoding="utf-8"), indent=1); os.replace(tmp, AMZ_RESULTS)

def amz_preflight(books):
    bad = []
    for b in books:
        sku = str(b.get("sku", ""))
        if not PD_RE.match(sku): bad.append("%s: not a PD number" % sku); continue
        if not re.match(r"^[0-9A-Z]{10}$", str(b.get("asin", ""))): bad.append("%s: no Amazon ASIN" % sku)
        if b.get("cond") not in AMZ_CONDS: bad.append("%s: unknown condition %s" % (sku, b.get("cond")))
        try:
            if float(b.get("price")) <= 0: bad.append("%s: price not above 0" % sku)
        except Exception: bad.append("%s: bad price" % sku)
        try:
            if int(b.get("quantity")) < 1: bad.append("%s: quantity below 1" % sku)
        except Exception: bad.append("%s: bad quantity" % sku)
        n = str(b.get("note", ""))
        if not n.strip(): bad.append("%s: blank condition note" % sku)
        if len(n) > 1000: bad.append("%s: condition note over 1000 characters" % sku)
    return bad

def _amz_product_type(api, b):
    pt = str(b.get("product_type") or "")
    if pt: return pt
    try:
        j = api.get("/catalog/2022-04-01/items/%s" % b["asin"], {"marketplaceIds": AMZ_MKT, "includedData": "productTypes"})
        return ((j.get("productTypes") or [{}])[0]).get("productType") or "PRODUCT"
    except Exception:
        return "PRODUCT"

def _amz_send(api, method, path, params, body=None):
    url = AMZ_HOST + path + "?" + urllib.parse.urlencode(params, doseq=True)
    data = json.dumps(body).encode() if body is not None else None
    for a in range(5):
        req = urllib.request.Request(url, data=data, method=method, headers={"x-amz-access-token": api.tok, "Content-Type": "application/json",
                                     "Accept": "application/json", "User-Agent": "PapaDuckDispatch/29 (Language=Python)"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            txt = e.read().decode(errors="replace")
            if e.code in (429, 500, 502, 503) and a < 4: time.sleep(2.5 * (a + 1)); continue
            try: return dict(json.loads(txt), http=e.code)
            except Exception: raise ValueError("Amazon %s %s -> %d %s" % (method, path.split("/")[1], e.code, txt[:240]))

def amz_check_live(skus):
    """v32 (2026-10-02, 16 books showed "Missing offer"): ask Amazon for each SKU's live state and EVERY issue it lists,
    plus what offer / fulfillment / shipping it actually holds. Read-only."""
    api = AmazonAPI(); seller = api.c["seller_id"]; lines = []
    for sku in skus:
        try:
            g = api.get("/listings/2021-08-01/items/%s/%s" % (seller, urllib.parse.quote(sku)),
                        {"marketplaceIds": AMZ_MKT, "includedData": "summaries,issues,offers,fulfillmentAvailability,attributes", "issueLocale": "en_US"})
            sm = (g.get("summaries") or [{}])[0]; at = g.get("attributes") or {}
            offers = ["%s %s" % (o.get("offerType"), (o.get("price") or {}).get("amount")) for o in (g.get("offers") or [])]
            fa = ["%s qty %s" % (f.get("fulfillmentChannelCode"), f.get("quantity")) for f in (g.get("fulfillmentAvailability") or [])]
            lines.append("%s  status: %s  | offers: %s | fulfillment: %s | shipping group: %s | audience: %s" % (
                sku, ", ".join(sm.get("status") or []) or "-", "; ".join(offers) or "NONE", "; ".join(fa) or "NONE",
                json.dumps(at.get("merchant_shipping_group"))[:80] if at.get("merchant_shipping_group") else "none",
                ((at.get("purchasable_offer") or [{}])[0]).get("audience", "not set")))
            lines.append("    type %s | price attr: %s | qty attr: %s | cond: %s" % (sm.get("productType") or "?",
                json.dumps(at.get("purchasable_offer"))[:260] if at.get("purchasable_offer") else "MISSING",
                json.dumps(at.get("fulfillment_availability"))[:160] if at.get("fulfillment_availability") else "MISSING",
                json.dumps(at.get("condition_type"))[:80] if at.get("condition_type") else "MISSING"))
            for i in g.get("issues") or []:
                lines.append("    %s %s: %s  (fields: %s)" % (i.get("severity"), i.get("code"), str(i.get("message"))[:220], ", ".join(i.get("attributeNames") or [])))
            if not g.get("issues"): lines.append("    (Amazon lists no issues)")
        except Exception as e:
            lines.append("%s  could not read: %s" % (sku, str(e)[:200]))
        time.sleep(0.3)
    return "AMAZON LIVE CHECK - %d book(s)\n" % len(skus) + "\n".join(lines)

def amz_fix_offer(path, only=None):
    """v33 (2026-10-02): 16 books sat DISCOVERABLE with offers NONE / fulfillment NONE and no issues listed.
    PATCH price + quantity onto each existing listing (same SKU, never a duplicate), using the product type Amazon
    itself holds for the SKU, and print Amazon's answer and EVERY issue it returns for each book."""
    books = json.load(open(path, encoding="utf-8")); books = [books] if isinstance(books, dict) else books
    if only: books = [b for b in books if b.get("sku") in only]
    bad = amz_preflight(books)
    if bad: return "\n".join(["AMAZON FIX - REFUSED, nothing sent:"] + ["  " + x for x in bad]), [], [], "refused"
    api = AmazonAPI(); seller = api.c["seller_id"]; res = _amz_results(); done, failed = [], []
    lines = ["AMAZON FIX PRICE + QUANTITY - %s (%d book%s)" % (os.path.basename(path), len(books), "" if len(books) == 1 else "s")]
    prog_start("amazon", os.path.basename(path), [b["sku"] for b in books], {b["sku"]: 2 for b in books})
    prog_set(stage="fixing price + quantity on Amazon")
    for b in books:
        sku = b["sku"]; prog_set(sku, state="sending", note="fixing")
        p = "/listings/2021-08-01/items/%s/%s" % (seller, urllib.parse.quote(sku))
        try:
            pt = ""
            try:
                g = api.get(p, {"marketplaceIds": AMZ_MKT, "includedData": "summaries"})
                pt = ((g.get("summaries") or [{}])[0]).get("productType") or ""
            except Exception: pass
            pt = pt or _amz_product_type(api, b)
            body = {"productType": pt, "patches": [
                {"op": "replace", "path": "/attributes/purchasable_offer", "value": [{"audience": "ALL", "currency": "USD", "marketplace_id": AMZ_MKT,
                    "our_price": [{"schedule": [{"value_with_tax": round(float(b["price"]), 2)}]}]}]},
                {"op": "replace", "path": "/attributes/fulfillment_availability", "value": [{"fulfillment_channel_code": "DEFAULT", "quantity": int(b["quantity"])}]},
                {"op": "replace", "path": "/attributes/condition_type", "value": [{"value": b["cond"], "marketplace_id": AMZ_MKT}]}]}
            r = _amz_send(api, "PATCH", p, {"marketplaceIds": AMZ_MKT, "issueLocale": "en_US"}, body)
            st = r.get("status") or ("HTTP %s" % r.get("http"))
            iss = list(r.get("issues") or []) + [{"severity": "ERROR", "code": e.get("code"), "message": e.get("message")} for e in (r.get("errors") or [])]
            ok = st == "ACCEPTED" and not [i for i in iss if i.get("severity") == "ERROR"]
            lines.append("%s  %s  (%s)  type %s  $%.2f x%s" % (sku, "FIX SENT" if ok else "FIX FAILED", st, pt, float(b["price"]), b["quantity"]))
            for i in iss: lines.append("    %s %s: %s  (fields: %s)" % (i.get("severity"), i.get("code"), str(i.get("message"))[:240], ", ".join(i.get("attributeNames") or [])))
            if ok:
                e = res.get(sku) or {}; e.update({"asin": b["asin"], "status": "LISTED", "price": b["price"], "qty": b["quantity"], "product_type": pt,
                                                   "fixed": time.strftime("%Y-%m-%d %H:%M")}); res[sku] = e; _amz_save_results(res)
            (done if ok else failed).append(sku); prog_set(sku, done=2, state="done" if ok else "failed", note="OK" if ok else st)
        except Exception as e:
            failed.append(sku); lines.append("%s  FIX FAILED: %s" % (sku, str(e)[:250])); prog_set(sku, state="failed", note="FAILED")
        time.sleep(0.3)
    lines += ["", ("*** NOT CLOSED - check: %s ***" % ", ".join(failed)) if failed else "FIX SENT for every book. Wait 5-10 minutes, then press Check on Amazon."]
    prog_end("NOT CLOSED" if failed else "CLOSED")
    return "\n".join(lines), done, failed, ("ok" if not failed else "warning")

def amz_list_file(path, only=None, preview=False, resend=False):
    books = json.load(open(path, encoding="utf-8")); books = [books] if isinstance(books, dict) else books
    if only: books = [b for b in books if b.get("sku") in only]
    lines = ["AMAZON %s - %s (%d book%s)" % ("PREVIEW (nothing listed)" if preview else "LIST", os.path.basename(path), len(books), "" if len(books) == 1 else "s")]
    bad = amz_preflight(books)
    if bad: return "\n".join(lines + ["REFUSED - nothing was sent. Tell Claude:"] + ["  " + x for x in bad]), [], [], "refused"
    res = _amz_results(); done, failed = [], []
    todo = books if (preview or resend) else [b for b in books if (res.get(b["sku"]) or {}).get("status") != "LISTED"]
    for b in books:
        if b not in todo: lines.append("%s  already on Amazon - skipped" % b["sku"])
    if not todo: return "\n".join(lines + ["", "CLOSED - every book in this file is already on Amazon."]), [], [], "ok"
    prog_start("amazon-preview" if preview else "amazon", os.path.basename(path), [b["sku"] for b in todo], {b["sku"]: 2 for b in todo})
    api = AmazonAPI(); seller = api.c["seller_id"]
    prog_set(stage="asking Amazon to check each book" if preview else "listing on Amazon")
    for b in todo:
        sku = b["sku"]; prog_set(sku, state="sending", note="sending")
        try:
            pt = _amz_product_type(api, b)
            body = {"productType": pt, "requirements": "LISTING_OFFER_ONLY", "attributes": {
                "merchant_suggested_asin": [{"value": b["asin"], "marketplace_id": AMZ_MKT}],
                "condition_type": [{"value": b["cond"], "marketplace_id": AMZ_MKT}],
                "condition_note": [{"value": b["note"], "language_tag": "en_US", "marketplace_id": AMZ_MKT}],
                "purchasable_offer": [{"audience": "ALL", "currency": "USD", "marketplace_id": AMZ_MKT, "our_price": [{"schedule": [{"value_with_tax": round(float(b["price"]), 2)}]}]}],
                "fulfillment_availability": [{"fulfillment_channel_code": "DEFAULT", "quantity": int(b["quantity"])}]}}
            params = {"marketplaceIds": AMZ_MKT, "issueLocale": "en_US"}
            if preview: params["mode"] = "VALIDATION_PREVIEW"
            r = _amz_send(api, "PUT", "/listings/2021-08-01/items/%s/%s" % (seller, urllib.parse.quote(sku)), params, body)
            st = r.get("status") or ("HTTP %s" % r.get("http"))
            errs = [i for i in (r.get("issues") or []) if i.get("severity") == "ERROR"] + [{"message": e.get("message")} for e in (r.get("errors") or [])]
            warns = [i for i in (r.get("issues") or []) if i.get("severity") == "WARNING"]
            ok = st in ("ACCEPTED", "VALID") and not errs
            msg = "; ".join(str(i.get("message"))[:160] for i in errs) or ""
            if ok and not preview:
                res[sku] = {"asin": b["asin"], "status": "LISTED", "when": time.strftime("%Y-%m-%d %H:%M"), "price": b["price"], "qty": b["quantity"], "submission": r.get("submissionId"), "product_type": pt}
                _amz_save_results(res)
            lines.append("%s  %s  ASIN %s  $%.2f x%s  %s%s%s" % (sku, ("OK" if ok else "PROBLEM") if preview else ("SENT - live within ~15 min" if ok else "FAILED"),
                         b["asin"], float(b["price"]), b["quantity"], b["cond"], ("  " + msg) if msg else "",
                         ("  (note: " + "; ".join(str(w.get("message"))[:100] for w in warns[:2]) + ")") if warns else ""))
            (done if ok else failed).append(sku)
            prog_set(sku, done=2, state="done" if ok else "failed", note=("OK" if ok else (msg[:60] or st)))
        except Exception as e:
            failed.append(sku); lines.append("%s  FAILED: %s" % (sku, str(e)[:250])); prog_set(sku, state="failed", note="FAILED")
        time.sleep(0.25)
    if not preview and done:                       # read back a few minutes later is best; check what is visible now
        lines.append("")
        for sku in done[:25]:
            try:
                g = api.get("/listings/2021-08-01/items/%s/%s" % (seller, urllib.parse.quote(sku)), {"marketplaceIds": AMZ_MKT, "includedData": "summaries,issues"})
                sm = (g.get("summaries") or [{}])[0]
                lines.append("%s  read back: %s" % (sku, ", ".join(sm.get("status") or []) or "still processing (normal for a few minutes)"))
            except Exception as e:
                lines.append("%s  read back: not visible yet (%s)" % (sku, str(e)[:80]))
    lines.append("")
    lines.append(("*** NOT CLOSED - check: %s ***" % ", ".join(failed)) if failed else
                 ("PREVIEW CLEAN - Amazon accepted every book. Press List to put them live." if preview else "CLOSED - every book sent to Amazon."))
    prog_end("NOT CLOSED" if failed else ("PREVIEW CLEAN" if preview else "CLOSED"))
    return "\n".join(lines), done, failed, ("ok" if not failed else "warning")

def amz_sync(targets):
    """Sold somewhere else -> Amazon matches the shelf. 0 left = delete the offer; some left = set the quantity."""
    res = _amz_results(); lines = []; api = None
    for pd, left in targets.items():
        if (res.get(pd) or {}).get("status") != "LISTED": lines.append("%s: not on Amazon - nothing to do" % pd); continue
        try:
            if api is None: api = AmazonAPI()
            seller = api.c["seller_id"]; path = "/listings/2021-08-01/items/%s/%s" % (seller, urllib.parse.quote(pd))
            if int(left) <= 0:
                r = _amz_send(api, "DELETE", path, {"marketplaceIds": AMZ_MKT})
                ok = r.get("status") == "ACCEPTED"
                if ok: res[pd]["status"] = "DELETED"; res[pd]["deleted"] = time.strftime("%Y-%m-%d %H:%M"); _amz_save_results(res)
                lines.append("%s: Amazon offer %s" % (pd, "REMOVED" if ok else "NOT removed - %s" % json.dumps(r)[:160]))
            else:
                pt = res[pd].get("product_type") or "PRODUCT"
                r = _amz_send(api, "PATCH", path, {"marketplaceIds": AMZ_MKT}, {"productType": pt, "patches": [{"op": "replace",
                     "path": "/attributes/fulfillment_availability", "value": [{"fulfillment_channel_code": "DEFAULT", "quantity": int(left)}]}]})
                ok = r.get("status") == "ACCEPTED"
                lines.append("%s: Amazon quantity -> %d %s" % (pd, int(left), "OK" if ok else "NOT changed - %s" % json.dumps(r)[:160]))
        except Exception as e:
            lines.append("%s: Amazon update FAILED %s" % (pd, str(e)[:200]))
    return "\n".join(lines) or "no Amazon listings among these books"

def amz_orders(days=7):
    """Amazon orders in the last N days -> [{pd, qty, order, date, status}] (SKU = PD number). No buyer details."""
    api = AmazonAPI(); after = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - int(days) * 86400))
    out = []; token = None
    for _ in range(10):
        p = {"MarketplaceIds": AMZ_MKT}
        if token: p["NextToken"] = token
        else: p.update(CreatedAfter=after, OrderStatuses="Unshipped,PartiallyShipped,Shipped,Pending")
        j = api.get("/orders/v0/orders", p); pl = j.get("payload") or {}
        for o in pl.get("Orders") or []:
            time.sleep(2.1)
            it = api.get("/orders/v0/orders/%s/orderItems" % o["AmazonOrderId"], {})
            for x in ((it.get("payload") or {}).get("OrderItems") or []):
                sku = str(x.get("SellerSKU") or "")
                out.append({"pd": sku if PD_RE.match(sku) else "", "sku": sku, "qty": int(x.get("QuantityOrdered") or 1), "title": (x.get("Title") or "")[:70],
                            "order": o["AmazonOrderId"], "date": (o.get("PurchaseDate") or "")[:10], "status": o.get("OrderStatus"),
                            "price": ((x.get("ItemPrice") or {}).get("Amount"))})
        token = pl.get("NextToken")
        if not token: break
        time.sleep(60)
    return out

def amazon_loop():
    time.sleep(20)
    while True:
        try:
            if amz_creds() and not _busy:
                r = amz_sweep(10)
                if not r.startswith("nothing"): log("AMAZON " + r[:300].replace("\n", " | "))
        except Exception as e:
            log("AMAZON-LOOP %s" % e)
        time.sleep(AMZ_EVERY)


# ------------------------------------------------------------------ ABEBOOKS SALES (v35, 2026-10-04)
# Papa Duck: "this has to be easier ... it has to be easier then this dig deeper" / "this should be able to be run in the
# dispatch". Before v35 an AbeBooks sale meant pasting the order page (or OCR of a screenshot) into the Sold tab, and the
# eBay end refused because eBay still shows 1 copy. Now the helper READS the order from the AbeBooks Order Update API
# (orderupdate.abebooks.com:10003 - switched on in his account since 2026-09-05, Rule AN) and closes it everywhere:
#   last copy  -> eBay END (forced, by ItemID), Etsy off, Amazon off, Sold Archive row, Inventory Status=Sold
#   copies left-> eBay quantity, Etsy/Amazon quantity and Inventory Quantity set to what is left
# It checks AbeBooks by itself every 15 minutes and shows a red "AbeBooks sale waiting" pill on the page.
# Nothing is closed without his click. A sale already closed (state file or Sold Archive) is never done twice.
import xml.etree.ElementTree as _ET
from xml.sax.saxutils import escape as _xesc
ABE_INI = os.path.join(ABEDIR, "abe_credentials.ini")
ABE_ORDER_URL = "https://orderupdate.abebooks.com:10003"
ABE_DONE = os.path.join(ABEDIR, "abe_sold_done.json")       # same state file papaduck_abe_sold.py v1 writes
ABE_FEE = 0.135
AT_SOLD = "tblm6DXvqF1jY3w9o"
S_TRACK, S_TITLE, S_AUTHOR, S_COST, S_PRICE = "fldrrmZq55FuVHRH9", "fldbnQDMerE0TbsDU", "fldwMVNnYFn7H2L0r", "fldPtXwY2ARnx9Mtg", "fldSegOhwT5QfQnIM"
S_FEES, S_NET, S_DATE, S_DAYS, S_CHAN, S_CAT = "fldzOquojqOHThFU1", "fldYrbMvbI4AUIqnI", "fldHxShSFmERwbaX7", "fldEav8vwfN1H0X2Y", "fldsnUnNs0PURNnjK", "flda2PWTEJpMpMdxf"
F_AUTHOR, F_QTY, F_COST, F_LIST, F_STORE, F_LISTED, F_STATUS, F_LOC = ("fldToxEOqQy79EU3s", "fld7MrQXX1D8iD0ap", "fldyhCaL3G2km40fk", "fldqfykAq3wumx32C",
                                                                      "fldcjYzvY1rrtstsl", "fldkjGa3cDhKgaN3N", "fldK5pTHj5iCEmf0w", "fldQaBBSqVE71YJ3k")
ABE_EVERY = 900
ABE_WAITING = {"checked": "", "orders": [], "error": ""}
_abesold_lock = threading.Lock()

def abe_order_creds():
    if not os.path.exists(ABE_INI): raise ValueError("AbeBooks credentials not found: %s" % ABE_INI)
    c = configparser.ConfigParser(); c.read(ABE_INI, encoding="utf-8-sig")
    for sec in c.sections():
        s = c[sec]
        user = (s.get("order_username") or "").strip() or (s.get("username") or s.get("user") or s.get("userid") or "").strip()
        pw = (s.get("order_password") or "").strip() or (s.get("password") or s.get("api_key") or s.get("apikey") or s.get("key") or "").strip()
        if user and pw: return user, pw
    raise ValueError("No username / API key found in %s" % ABE_INI)

def _abe_num(el):
    try: return round(float((el.text or "0").strip()), 2) if el is not None else 0.0
    except ValueError: return 0.0

def _abe_date(el):
    d = el.find("date") if el is not None else None
    try: return "%04d-%02d-%02d" % (int(d.findtext("year")), int(d.findtext("month")), int(d.findtext("day")))
    except Exception: return ""

def abe_parse_orders(raw):
    root = _ET.fromstring(raw)
    if root.tag == "requestError":
        code = (root.findtext("code") or "?").strip()
        raise ValueError("AbeBooks error %s: %s%s" % (code, root.findtext("message") or "",
                         " (110 = the Order API switch is off in the AbeBooks account settings)" if code == "110" else ""))
    out = []
    for po in root.iter("purchaseOrder"):
        if po.find("purchaseOrderItemList") is None: continue
        tot = po.find("orderTotals"); items = []
        for it in po.iter("purchaseOrderItem"):
            b = it.find("book")
            if b is None: continue
            items.append({"item_id": it.get("id"), "pd": (b.findtext("vendorKey") or "").strip().upper(), "title": (b.findtext("title") or "").strip(),
                          "author": (b.findtext("author") or "").strip(), "price": _abe_num(b.find("price")), "status": (it.findtext("status") or "").strip()})
        out.append({"po": po.get("id"), "date": _abe_date(po.find("orderDate")), "status": (po.findtext("status") or "").strip(),
                    "shipping": _abe_num(tot.find("shipping")) if tot is not None else 0.0,
                    "total": _abe_num(tot.find("total")) if tot is not None else 0.0, "items": items})
    return out

def abe_orders_api(po=None):
    user, pw = abe_order_creds()
    inner = ('<purchaseOrder id="%s"/>' % re.sub(r"\D", "", str(po))) if po else "<limit>500</limit><offset>0</offset>"
    body = ('<?xml version="1.0" encoding="ISO-8859-1"?>\n<orderUpdateRequest version="1.1"><action name="%s"><username>%s</username>'
            '<password>%s</password></action>%s</orderUpdateRequest>' % ("getOrder" if po else "getAllNewOrders", _xesc(user), _xesc(pw), inner)).encode("iso-8859-1", "replace")
    req = urllib.request.Request(ABE_ORDER_URL, data=body, headers={"Content-Type": "application/xml"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: raw = r.read()
    except urllib.error.URLError as e:
        raise ValueError("could not reach AbeBooks orders (%s) - port 10003 is sometimes blocked on office networks" % e)
    return abe_parse_orders(raw)

def _at_req(method, table, qs=None, body=None):
    tok = at_token()
    if not tok: raise ValueError("Airtable token not set - Settings")
    url = "https://api.airtable.com/v0/%s/%s" % (AT_BASE, table) + ("?" + urllib.parse.urlencode(qs, doseq=True) if qs else "")
    data = json.dumps(body).encode() if body is not None else None
    for a in range(4):
        req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=40) as r: return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and a < 3: time.sleep(2 * (a + 1)); continue
            raise ValueError("Airtable %d: %s" % (e.code, e.read().decode(errors="replace")[:300]))

def _at_rows(table, field, pd, fields):
    for ref in (field, "Tracking", "Tracking Number"):
        try:
            return _at_req("GET", table, [("filterByFormula", "{%s}='%s'" % (ref, pd)), ("returnFieldsByFieldId", "true")] + [("fields[]", f) for f in fields]).get("records", [])
        except ValueError as e:
            if "422" not in str(e): raise
    return []

_opt = lambda v: (v.get("name") if isinstance(v, dict) else v) or ""

def _abe_done():
    try: return json.load(open(ABE_DONE, encoding="utf-8"))
    except Exception: return {}

def abe_sales_plan(po=None):
    """Read-only: every AbeBooks sale (new orders, or one PO) with what Dispatch WOULD do for it."""
    orders = abe_orders_api(po); done = _abe_done(); plan = []
    for o in orders:
        by = {}
        for it in o["items"]: by.setdefault(it["pd"], []).append(it)
        for pd, its in by.items():
            row = {"key": "%s:%s" % (o["po"], pd), "po": o["po"], "date": o["date"], "pd": pd, "n": len(its), "title": its[0]["title"][:70],
                   "author": its[0]["author"], "price": round(sum(i["price"] for i in its), 2), "shipping": o["shipping"], "state": "todo", "note": ""}
            if "cancel" in (o["status"] + " " + its[0]["status"]).lower(): row.update(state="skip", note="cancelled on AbeBooks")
            elif not PD_RE.match(pd): row.update(state="skip", note="no PD number on this AbeBooks listing - tell Claude")
            elif row["key"] in done: row.update(state="done", note="already closed out %s" % done[row["key"]].get("when", ""))
            else:
                sold = _at_rows(AT_SOLD, S_TRACK, pd, [S_TRACK, S_DATE, S_CHAN])
                if any(_opt(r["fields"].get(S_CHAN)) == "AbeBooks" and r["fields"].get(S_DATE) == o["date"] for r in sold):
                    row.update(state="done", note="already in the Sold Archive")
                else:
                    inv = _at_rows(AT_INV, F_TRACK, pd, [F_TRACK, F_TITLE, F_AUTHOR, F_QTY, F_COST, F_ITEMID, F_LIST, F_STORE, F_LISTED, F_STATUS, F_LOC])
                    if not inv: row.update(state="skip", note="not in Airtable Inventory - tell Claude")
                    else:
                        f = inv[0]["fields"]; have = int(f.get(F_QTY) or 1); left = max(0, have - len(its))
                        cost = round(float(f.get(F_COST) or 0) * len(its), 2); fees = round(row["price"] * ABE_FEE, 2)
                        row.update(rec=inv[0]["id"], itemid=re.sub(r"\D", "", str(f.get(F_ITEMID) or "")), left=left, have=have, cost=cost, fees=fees,
                                   net=round(row["price"] - fees - cost, 2), list_price=float(f.get(F_LIST) or 0), store=_opt(f.get(F_STORE)),
                                   listed=f.get(F_LISTED) or "", where=_opt(f.get(F_LOC)) or "Garage", title=(f.get(F_TITLE) or row["title"])[:70],
                                   author=f.get(F_AUTHOR) or row["author"])
                        row["note"] = ("last copy: eBay END + Etsy/Amazon off" if left == 0 else "%d left: eBay/Etsy/Amazon qty -> %d" % (left, left)) + " - pull from " + row["where"]
            plan.append(row)
    return orders, plan

def abe_sales_close(po=None, keys=None):
    orders, plan = abe_sales_plan(po)
    todo = [p for p in plan if p["state"] == "todo" and (not keys or p["key"] in keys)]
    lines = ["ABEBOOKS SALES - %d order(s), %d to close" % (len(orders), len(todo))]
    for p in plan:
        if p not in todo: lines.append("%s  %s  $%.2f  - %s" % (p["pd"] or "(no PD)", p["title"][:45], p["price"], p["note"]))
    done_map = _abe_done(); closed, problems = [], []
    for p in todo:
        pd, left = p["pd"], p["left"]
        L = ["%s  %s  sold $%.2f (+$%.2f ship)  net $%.2f  - PULL FROM %s" % (pd, p["title"][:50], p["price"], p["shipping"], p["net"], p["where"].upper())]
        ok = True
        if p["itemid"]:
            if left == 0:
                rc, out = run([EBAY, "end", p["itemid"], "--force"])
                v = fmt_verify_ebay(ebay_items([p["itemid"]])); L.append("    eBay: " + v)
                if "Active" in v: ok = False
            else:
                rc, out = run([EBAY, "revise", p["itemid"], "%.2f" % p["list_price"], "--qty", str(left)])
                v = fmt_verify_ebay(ebay_items([p["itemid"]])); L.append("    eBay: " + v)
        else:
            L.append("    eBay: no ItemID in Airtable - nothing to end")
        try: L.append("    Etsy: " + etsy_sync({pd: left}))
        except Exception as e: L.append("    Etsy: check failed %s" % str(e)[:120])
        try: L.append("    Amazon: " + amz_sync({pd: left}))
        except Exception as e: L.append("    Amazon: check failed %s" % str(e)[:120])
        try:
            days = (datetime.date.fromisoformat(p["date"]) - datetime.date.fromisoformat(p["listed"])).days if p.get("listed") else None
        except Exception: days = None
        try:
            fields = {S_TRACK: pd, S_TITLE: p["title"], S_AUTHOR: p["author"], S_COST: p["cost"], S_PRICE: p["price"], S_FEES: p["fees"],
                      S_NET: p["net"], S_DATE: p["date"], S_DAYS: days, S_CHAN: "AbeBooks", S_CAT: p["store"]}
            _at_req("POST", AT_SOLD, body={"typecast": True, "records": [{"fields": {k: v for k, v in fields.items() if v not in (None, "")}}]})
            _at_req("PATCH", AT_INV, body={"typecast": True, "records": [{"id": p["rec"], "fields": ({F_STATUS: "Sold", F_QTY: 0} if left == 0 else {F_QTY: left})}]})
            L.append("    Airtable: Sold Archive row written, Inventory %s" % ("marked Sold" if left == 0 else "Quantity -> %d" % left))
            done_map[p["key"]] = {"when": time.strftime("%Y-%m-%d"), "po": p["po"], "price": p["price"]}
        except Exception as e:
            ok = False; L.append("    Airtable: FAILED %s" % str(e)[:200])
        (closed if ok else problems).append(pd); lines += L
    try: json.dump(done_map, open(ABE_DONE, "w", encoding="utf-8"), indent=1)
    except Exception as e: log("ABE-DONE save %s" % e)
    lines.append("")
    lines.append(("*** NOT CLOSED - check: %s ***" % ", ".join(problems)) if problems else
                 ("CLOSED - every AbeBooks sale is logged and off eBay / Etsy / Amazon." if todo else "Nothing new to close."))
    ABE_WAITING["orders"] = [x for x in ABE_WAITING["orders"] if x.get("key") not in done_map]
    return "\n".join(lines), closed, problems

def abe_sales_loop():
    time.sleep(45)
    while True:
        try:
            if os.path.exists(ABE_INI) and at_token() and not cloud_mode():
                _, plan = abe_sales_plan()
                todo = [p for p in plan if p["state"] == "todo"]
                ABE_WAITING.update(checked=time.strftime("%H:%M"), error="", orders=todo)
                if todo and AUTO_CLOSE: _auto_run("abe-sold-auto", _abesold_lock, ABE_WAITING, lambda: abe_sales_close(None, [p["key"] for p in todo]))
        except Exception as e:
            ABE_WAITING.update(checked=time.strftime("%H:%M"), error=str(e)[:200]); log("ABE-SALES-LOOP %s" % e)
        time.sleep(ABE_EVERY)

# ------------------------------------------------------------------ EVERY SALE LOGGED + ETSY SALES (v36, 2026-10-04)
# Papa Duck: "yes this has to happen" / "this has to be 100% in cross selling". Before v36 an Etsy sale had no
# automatic pull (nothing ended it on eBay / AbeBooks / Amazon), and eBay + Amazon + Etsy sales closed in the Sold tab
# were never written to the Sold Archive or marked Sold in Inventory. Now:
#   /etsy/orders   reads Etsy receipts (SKU = PD) -> the Sold tab list, like Amazon orders
#   /sold/log      after every Sold-tab Run: one Sold Archive row per sale + Inventory Sold/Quantity, never twice
#   etsy_sales_loop checks Etsy every 30 minutes and lights the "etsy sales" pill when a sale is not closed yet
SOLD_DONE = os.path.join(BASE, "sold_log_done.json")       # channel:order:PD -> when logged
CHAN_NAME = {"ebay": "eBay", "abe": "AbeBooks", "amazon": "Amazon", "etsy": "Etsy"}
ETSY_SALES_EVERY = 1800
ETSY_WAITING = {"checked": "", "orders": [], "error": ""}
_soldlog_lock = threading.Lock()
_etsysold_lock = threading.Lock()
_MON = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

def chan_fees(chan, price):
    """Same arithmetic as the Sold Archive rows already there. Amazon has no rows yet -> estimate, flagged."""
    if chan == "ebay": return round(price * 0.1325 + 0.40, 2), ""
    if chan == "abe": return round(price * ABE_FEE, 2), ""
    if chan == "etsy": return round(price * 0.065 + 0.20, 2), ""
    if chan == "amazon": return round(price * 0.15 + 1.80, 2), " (Amazon fee estimated 15% + $1.80 - check the payout)"
    return 0.0, ""

def norm_date(s):
    """eBay 'Oct-03-26', 'Oct 3, 2026', '10/03/2026', ISO -> 'YYYY-MM-DD'. '' if unreadable."""
    s = str(s or "").strip()
    if not s: return ""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m: return m.group(0)[:10]
    m = re.match(r"^([A-Za-z]{3})[a-z]*[-\s]+(\d{1,2})[-,\s]+(\d{2,4})", s)
    if m and m.group(1).lower() in _MON:
        y = int(m.group(3)); y = y + 2000 if y < 100 else y
        return "%04d-%02d-%02d" % (y, _MON[m.group(1).lower()], int(m.group(2)))
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})", s)
    if m:
        y = int(m.group(3)); y = y + 2000 if y < 100 else y
        return "%04d-%02d-%02d" % (y, int(m.group(1)), int(m.group(2)))
    return ""

def _money(v):
    try: return round(float(re.sub(r"[^\d.\-]", "", str(v)) or 0), 2)
    except ValueError: return 0.0

def _sold_done():
    try: return json.load(open(SOLD_DONE, encoding="utf-8"))
    except Exception: return {}

def sold_log(sales):
    """sales = [{pd, channel, price (total for the line), qty, date, left, order?}]. Writes the Sold Archive row and sets
    Inventory (0 left -> Status Sold + Quantity 0; copies left -> Quantity = left). Skips anything already logged:
    same channel+order in the local state file, or a Sold Archive row with the same PD + channel + date."""
    done = _sold_done(); lines = []; logged, skipped, problems = [], [], []
    for s in sales:
        pd = str(s.get("pd") or "").upper(); chan = str(s.get("channel") or "").lower()
        if not PD_RE.match(pd) or chan not in CHAN_NAME: problems.append(pd or "?"); lines.append("%s: no PD / channel - not logged" % (pd or "?")); continue
        date = norm_date(s.get("date")) or time.strftime("%Y-%m-%d"); qty = max(1, int(s.get("qty") or 1))
        order = str(s.get("order") or "").strip(); dkey = "%s:%s:%s" % (chan, order or date, pd)
        if dkey in done: skipped.append(pd); lines.append("%s: %s sale already logged %s - skipped" % (pd, CHAN_NAME[chan], done[dkey].get("when", ""))); continue
        try:
            prior = _at_rows(AT_SOLD, S_TRACK, pd, [S_TRACK, S_DATE, S_CHAN])
            if any(_opt(r["fields"].get(S_CHAN)) == CHAN_NAME[chan] and r["fields"].get(S_DATE) == date for r in prior):
                done[dkey] = {"when": time.strftime("%Y-%m-%d"), "note": "found in Sold Archive"}
                skipped.append(pd); lines.append("%s: already in the Sold Archive (%s %s) - skipped" % (pd, CHAN_NAME[chan], date)); continue
            inv = _at_rows(AT_INV, F_TRACK, pd, [F_TRACK, F_TITLE, F_AUTHOR, F_QTY, F_COST, F_LIST, F_STORE, F_LISTED, F_STATUS])
            f = inv[0]["fields"] if inv else {}
            price = _money(s.get("price")); note = ""
            if price <= 0:
                price = round(float(f.get(F_LIST) or 0) * qty, 2); note = " (no sold price given - used the list price, check it)"
            fees, fnote = chan_fees(chan, price); note += fnote
            cost = round(float(f.get(F_COST) or 0) * qty, 2); net = round(price - fees - cost, 2)
            try: days = (datetime.date.fromisoformat(date) - datetime.date.fromisoformat(str(f.get(F_LISTED))[:10])).days if f.get(F_LISTED) else None
            except Exception: days = None
            title = (f.get(F_TITLE) or s.get("title") or "")[:200]
            row = {S_TRACK: pd, S_TITLE: title, S_AUTHOR: f.get(F_AUTHOR) or "", S_COST: cost, S_PRICE: price, S_FEES: fees, S_NET: net,
                   S_DATE: date, S_DAYS: days, S_CHAN: CHAN_NAME[chan], S_CAT: _opt(f.get(F_STORE))}
            _at_req("POST", AT_SOLD, body={"typecast": True, "records": [{"fields": {k: v for k, v in row.items() if v not in (None, "")}}]})
            if inv:
                left = s.get("left")
                if left is None: left = max(0, int(f.get(F_QTY) or 1) - qty)
                left = max(0, int(left))
                _at_req("PATCH", AT_INV, body={"typecast": True, "records": [{"id": inv[0]["id"], "fields": ({F_STATUS: "Sold", F_QTY: 0} if left == 0 else {F_QTY: left})}]})
                inv_txt = "Inventory marked Sold" if left == 0 else "Inventory Quantity -> %d" % left
            else:
                inv_txt = "NOT in Inventory - archive row written, tell Claude"
            done[dkey] = {"when": time.strftime("%Y-%m-%d"), "price": price}
            logged.append(pd)
            lines.append("%s: %s %s  sold $%.2f  fees $%.2f  cost $%.2f  net $%.2f  - %s%s" % (pd, CHAN_NAME[chan], date, price, fees, cost, net, inv_txt, note))
        except Exception as e:
            problems.append(pd); lines.append("%s: Sold Archive FAILED %s" % (pd, str(e)[:200]))
    try:
        tmp = SOLD_DONE + ".tmp"; json.dump(done, open(tmp, "w", encoding="utf-8"), indent=1); os.replace(tmp, SOLD_DONE)
    except Exception as e: log("SOLD-DONE save %s" % e)
    head = "SOLD ARCHIVE - %d logged, %d already there%s" % (len(logged), len(skipped), (", %d PROBLEM(S): %s" % (len(problems), ", ".join(problems))) if problems else "")
    ETSY_WAITING["orders"] = [x for x in ETSY_WAITING["orders"] if "etsy:%s:%s" % (x.get("order"), x.get("pd")) not in done]
    return head + "\n" + "\n".join(lines), logged, skipped, problems

def _etsy_pd_by_listing():
    m = {}
    for pd, v in (_etsy_results() or {}).items():
        lid = str((v or {}).get("listing_id") or "")
        if lid: m[lid] = pd
    return m

def etsy_orders(days=7):
    """Etsy receipts in the last N days -> [{pd, qty, price, order, date, title, status}] (no buyer details kept)."""
    api = EtsyAPI(); after = int(time.time() - int(days) * 86400); out = []; by_lid = None; offset = 0
    for _ in range(10):
        j = api.call("GET", "/shops/%s/receipts?%s" % (ETSY_SHOP, urllib.parse.urlencode({"min_created": after, "limit": 100, "offset": offset})))
        R = j.get("results") or []
        for rc in R:
            st = str(rc.get("status") or "")
            if st.lower() in ("canceled", "cancelled", "fully refunded"): continue
            if rc.get("is_paid") is False: continue                 # v40: unpaid Etsy orders are never closed out
            for t in rc.get("transactions") or []:
                sku = str(t.get("sku") or "").strip().upper()
                if not PD_RE.match(sku):
                    if by_lid is None: by_lid = _etsy_pd_by_listing()
                    sku = by_lid.get(str(t.get("listing_id") or ""), "")
                pr = t.get("price") or {}; q = int(t.get("quantity") or 1)
                unit = float(pr.get("amount") or 0) / float(pr.get("divisor") or 100)
                ts = t.get("paid_timestamp") or rc.get("create_timestamp") or rc.get("created_timestamp") or 0
                out.append({"pd": sku, "sku": str(t.get("sku") or ""), "qty": q, "price": round(unit * q, 2), "order": str(rc.get("receipt_id")),
                            "date": time.strftime("%Y-%m-%d", time.localtime(int(ts))) if ts else "", "title": (t.get("title") or "")[:70],
                            "status": st, "listing_id": str(t.get("listing_id") or "")})
        if len(R) < 100: break
        offset += 100
    return out

def etsy_sales_loop():
    time.sleep(90)
    while True:
        try:
            if etsy_cred_dir() and at_token() and not cloud_mode():
                done = _sold_done()
                todo = [o for o in etsy_orders(3) if o["pd"] and "etsy:%s:%s" % (o["order"], o["pd"]) not in done]
                ETSY_WAITING.update(checked=time.strftime("%H:%M"), error="", orders=todo)
                if todo and AUTO_CLOSE: _auto_run("etsy-sold-auto", _etsysold_lock, ETSY_WAITING, lambda: etsy_sales_close(3, ["%s:%s" % (o["order"], o["pd"]) for o in todo]))
        except Exception as e:
            ETSY_WAITING.update(checked=time.strftime("%H:%M"), error=str(e)[:200]); log("ETSY-SALES-LOOP %s" % e)
        time.sleep(ETSY_SALES_EVERY)

# ------------------------------------------------------------------ EBAY SALES (v37, 2026-10-04)
# Papa Duck: "i want ebay to check automatically". Before v37 an eBay sale meant downloading the Seller Hub orders CSV
# and dropping it in the Sold tab. Now the helper asks eBay itself (Trading API GetOrders, the same login in
# ebay_credentials.ini that already ends and revises listings) every 15 minutes, lights a red "ebay sales" pill,
# and one click closes the sale everywhere:
#   eBay listing ended / 0 left -> AbeBooks DELETE, Etsy off, Amazon off, Sold Archive row, Inventory Sold
#   copies still on eBay       -> Etsy / Amazon / Inventory quantity set to what eBay shows left (AbeBooks kept)
# Nothing is closed without his click. A sale already logged (state file or Sold Archive) never shows again.
EBAY_INI = os.path.join(EBAYDIR, "ebay_credentials.ini")
EBAY_EVERY = 900
EBAY_WAITING = {"checked": "", "orders": [], "error": ""}
_ebaysold_lock = threading.Lock()
_EB_NS = "{urn:ebay:apis:eBLBaseComponents}"

def ebay_ini():
    c = configparser.ConfigParser(); c.read(EBAY_INI, encoding="utf-8-sig")
    try: s = c["ebay"]
    except KeyError: raise ValueError("eBay settings not found in %s" % EBAY_INI)
    d = {k: (s.get(k) or "").strip() for k in ("app_id", "dev_id", "cert_id", "auth_token")}
    if not d["auth_token"]: raise ValueError("auth_token is blank in %s" % EBAY_INI)
    return d

def ebay_trading(call, inner):
    d = ebay_ini()
    body = ('<?xml version="1.0" encoding="utf-8"?><%sRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
            '<RequesterCredentials><eBayAuthToken>%s</eBayAuthToken></RequesterCredentials>%s</%sRequest>'
            % (call, _xesc(d["auth_token"]), inner, call)).encode("utf-8")
    hdr = {"X-EBAY-API-CALL-NAME": call, "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
           "X-EBAY-API-APP-NAME": d["app_id"], "X-EBAY-API-DEV-NAME": d["dev_id"], "X-EBAY-API-CERT-NAME": d["cert_id"],
           "Content-Type": "text/xml"}
    req = urllib.request.Request("https://api.ebay.com/ws/api.dll", data=body, headers=hdr, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r: root = _ET.fromstring(r.read())
    ack = root.findtext(_EB_NS + "Ack") or ""
    if ack not in ("Success", "Warning"):
        errs = ["%s %s" % (e.findtext(_EB_NS + "ErrorCode"), e.findtext(_EB_NS + "LongMessage")) for e in root.iter(_EB_NS + "Errors")]
        raise ValueError("eBay %s: %s" % (call, "; ".join(errs)[:300] or ack))
    return root

def _eb(el, path):
    for p in path.split("/"):
        el = el.find(_EB_NS + p) if el is not None else None
    return (el.text or "").strip() if el is not None and el.text else ""

def _local_date(iso):
    try: return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
    except Exception: return iso[:10]

_PD_BY_ITEM = {}
def at_pd_by_itemid(iids):
    """v38: an old listing with no Custom Label (PD-0588 on 2026-10-05) -> find its PD by eBay ItemID in Airtable Inventory."""
    want = [i for i in iids if i and i not in _PD_BY_ITEM]
    for k in range(0, len(want), 20):
        chunk = want[k:k + 20]
        for ref in (F_ITEMID, "eBay ItemID"):
            f = "OR(%s)" % ",".join("{%s}='%s'" % (ref, i) for i in chunk)
            try:
                recs = _at_req("GET", AT_INV, [("filterByFormula", f), ("returnFieldsByFieldId", "true"), ("fields[]", F_TRACK), ("fields[]", F_ITEMID)]).get("records", [])
            except ValueError as e:
                if "422" in str(e): continue
                raise
            for r in recs:
                fl = r.get("fields") or {}; iid = re.sub(r"\D", "", str(fl.get(F_ITEMID) or "")); pd = str(fl.get(F_TRACK) or "").upper()
                if iid and PD_RE.match(pd): _PD_BY_ITEM[iid] = pd
            break
    return {i: _PD_BY_ITEM[i] for i in iids if i in _PD_BY_ITEM}

def ebay_orders(days=3):
    """Paid eBay orders in the last N days -> [{pd, itemid, qty, price, order, date, title}] (no buyer details kept)."""
    now = datetime.datetime.now(datetime.timezone.utc); frm = now - datetime.timedelta(days=int(days))
    f = lambda t: t.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    try: idrev = {str(v): k for k, v in json.load(open(IDMAP)).items()}
    except Exception: idrev = {}
    out = []
    for page in range(1, 11):
        root = ebay_trading("GetOrders", "<CreateTimeFrom>%s</CreateTimeFrom><CreateTimeTo>%s</CreateTimeTo><OrderRole>Seller</OrderRole>"
                            "<OrderStatus>All</OrderStatus><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>%d</PageNumber></Pagination>"
                            % (f(frm), f(now), page))
        for o in root.iter(_EB_NS + "Order"):
            st = _eb(o, "OrderStatus"); paid = _eb(o, "PaidTime")
            if st in ("Cancelled", "CancelPending", "Inactive") or not paid: continue
            for t in o.iter(_EB_NS + "Transaction"):
                iid = _eb(t, "Item/ItemID"); sku = (_eb(t, "Item/SKU") or _eb(t, "Variation/SKU")).upper()
                pd = sku if PD_RE.match(sku) else idrev.get(iid, "")
                q = int(_eb(t, "QuantityPurchased") or 1)
                try: unit = float(_eb(t, "TransactionPrice") or 0)
                except ValueError: unit = 0.0
                out.append({"pd": pd, "itemid": iid, "qty": q, "price": round(unit * q, 2), "order": _eb(o, "OrderID"),
                            "date": _local_date(paid or _eb(o, "CreatedTime")), "title": _eb(t, "Item/Title")[:70]})
        if (_eb(root, "HasMoreOrders") or "false").lower() != "true": break
    miss = sorted({o["itemid"] for o in out if not o["pd"] and o["itemid"]})
    if miss:
        try:
            found = at_pd_by_itemid(miss)
            for o in out:
                if not o["pd"] and o["itemid"] in found: o["pd"] = found[o["itemid"]]; o["pd_from"] = "Airtable (no Custom Label on eBay)"
        except Exception as e: log("EBAY-PD-LOOKUP %s" % e)
    return out

def _abe_deleted(pd):
    """True if an AbeBooks delete of this PD already came back OK in the last 30 days (Runs archive on disk)."""
    pat = re.compile(r"\[\s*OK\s*\]\s*%s\b" % re.escape(pd))
    for f in sorted(glob.glob(os.path.join(RUNS, "*.jsonl")))[-30:]:
        try:
            for line in open(f, encoding="utf-8"):
                if '"abe-delete"' in line and pd in line:
                    r = json.loads(line)
                    if r.get("action") == "abe-delete" and pat.search(r.get("output") or ""): return True
        except Exception: pass
    return False

def ebay_sales_plan(days=3):
    """Read-only: every eBay sale not yet logged, with what Dispatch WOULD do for it."""
    orders = ebay_orders(days); done = _sold_done(); plan = []
    by = {}
    for o in orders:
        k = "%s:%s" % (o["order"], o["pd"] or o["itemid"])
        if k in by: by[k]["qty"] += o["qty"]; by[k]["price"] = round(by[k]["price"] + o["price"], 2)
        else: by[k] = dict(o, key=k)
    live = {it.get("itemid"): it for it in ebay_items(sorted({o["itemid"] for o in by.values() if o["itemid"]})) if it.get("ok")} if by else {}
    for row in by.values():
        row.update(state="todo", note="")
        if not row["pd"]: row.update(state="skip", note="no PD number on eBay and item number not in Airtable - tell Claude")
        elif ("ebay:%s:%s" % (row["order"], row["pd"])) in done or ("ebay:%s:%s" % (row["date"], row["pd"])) in done:
            row.update(state="done", note="already closed out")
        else:
            prior = _at_rows(AT_SOLD, S_TRACK, row["pd"], [S_TRACK, S_DATE, S_CHAN])
            if any(_opt(r["fields"].get(S_CHAN)) == "eBay" and r["fields"].get(S_DATE) == row["date"] for r in prior):
                row.update(state="done", note="already in the Sold Archive")
            else:
                it = live.get(row["itemid"]) or {}
                active = it.get("status") == "Active"; left = int(it.get("remaining") or 0) if active else 0
                row["left"] = left; row["ebay_now"] = ("Active, %d left" % left) if active else (it.get("status") or "not found")
                row["note"] = ("last copy: AbeBooks DELETE + Etsy/Amazon off" if left == 0 else
                               "%d still on eBay: Etsy/Amazon quantity -> %d, AbeBooks kept" % (left, left)) + \
                              (" (PD found in Airtable by item number)" if row.get("pd_from") else "")
        plan.append(row)
    return orders, plan

def ebay_sales_close(days=3, keys=None):
    orders, plan = ebay_sales_plan(days)
    todo = [p for p in plan if p["state"] == "todo" and (not keys or p["key"] in keys)]
    lines = ["EBAY SALES - %d order line(s), %d to close" % (len(plan), len(todo))]
    for p in plan:
        if p not in todo: lines.append("%s  %s  $%.2f  - %s" % (p["pd"] or "(no PD)", p["title"][:45], p["price"], p["note"]))
    closed, problems, sales = [], [], []
    for p in todo:
        pd, left = p["pd"], p["left"]; ok = True
        L = ["%s  %s  sold $%.2f  (eBay now: %s)" % (pd, p["title"][:50], p["price"], p["ebay_now"])]
        if left == 0 and _abe_deleted(pd):
            L.append("    AbeBooks: already deleted earlier - nothing to do")
        elif left == 0:
            rc, out = run([ABE, "delete", pd])
            first = next((l.strip() for l in out.splitlines() if pd in l and ("OK" in l or "ERR" in l.upper() or "not" in l.lower())), out.strip()[-160:])
            L.append("    AbeBooks: " + (first or "delete sent"))
            if rc != 0 and "not found" not in out.lower() and "no such" not in out.lower(): ok = False
        else:
            L.append("    AbeBooks: kept (%d still for sale)" % left)
        try: L.append("    Etsy: " + etsy_sync({pd: left}))
        except Exception as e: L.append("    Etsy: check failed %s" % str(e)[:120]); ok = False
        try: L.append("    Amazon: " + amz_sync({pd: left}))
        except Exception as e: L.append("    Amazon: check failed %s" % str(e)[:120]); ok = False
        sales.append({"pd": pd, "channel": "ebay", "price": p["price"], "qty": p["qty"], "date": p["date"], "left": left, "order": p["order"], "title": p["title"]})
        (closed if ok else problems).append(pd); lines += L
    if sales:
        txt, logged, skipped, bad = sold_log(sales)
        lines += ["", txt]; problems += [x for x in bad if x not in problems]
    lines.append("")
    lines.append(("*** CHECK: %s ***" % ", ".join(problems)) if problems else
                 ("CLOSED - every eBay sale is off AbeBooks / Etsy / Amazon and logged." if todo else "Nothing new to close."))
    done = _sold_done()
    EBAY_WAITING["orders"] = [x for x in EBAY_WAITING["orders"] if ("ebay:%s:%s" % (x.get("order"), x.get("pd"))) not in done]
    return "\n".join(lines), closed, problems

HEARTBEAT_FILE = os.path.join(BASE, "heartbeat_rec.txt")
def heartbeat():
    """v41: ONE Helper Runs row ("Dispatch heartbeat") rewritten after every eBay check - last check time and any error for
    eBay / AbeBooks / Etsy. Lets Claude see from anywhere whether the sales checks are running (Papa Duck 2026-10-06:
    a 12:30 sale did not close and nobody could tell why from the office)."""
    def one(name, W):
        la = W.get("last_auto") or {}
        return "%-8s checked %s  waiting %d  %s%s" % (name, W.get("checked") or "never", len(W.get("orders") or []),
               ("ERROR " + W["error"]) if W.get("error") else "ok",
               ("  last auto-close %s %s" % (la.get("when"), ", ".join(la.get("closed") or []))) if la.get("closed") else "")
    txt = "\n".join([one("eBay", EBAY_WAITING), one("AbeBooks", ABE_WAITING), one("Etsy", ETSY_WAITING)])
    bad = any(W.get("error") for W in (EBAY_WAITING, ABE_WAITING, ETSY_WAITING))
    fields = {"Run": "Dispatch heartbeat (live) v" + VERSION, "When": time.strftime("%Y-%m-%dT%H:%M:%S"), "Action": "heartbeat",
              "Result": "warning" if bad else "ok", "Output": txt, "Verify": txt}
    try:
        rid = open(HEARTBEAT_FILE, encoding="utf-8").read().strip()
    except Exception: rid = ""
    try:
        if rid:
            try:
                _at_req("PATCH", AT_RUNS, body={"typecast": True, "records": [{"id": rid, "fields": fields}]}); return
            except ValueError as e:
                if "404" not in str(e) and "422" not in str(e) and "NOT_FOUND" not in str(e): raise
        r = _at_req("POST", AT_RUNS, body={"typecast": True, "records": [{"fields": fields}]})
        open(HEARTBEAT_FILE, "w", encoding="utf-8").write(r["records"][0]["id"])
    except Exception as e: log("HEARTBEAT %s" % e)

def ebay_sales_loop():
    time.sleep(60)
    while True:
        try:
            if os.path.exists(EBAY_INI) and at_token() and not cloud_mode():
                _, plan = ebay_sales_plan(3)
                todo = [p for p in plan if p["state"] == "todo"]
                EBAY_WAITING.update(checked=time.strftime("%H:%M"), error="", orders=todo)
                if todo and AUTO_CLOSE: _auto_run("ebay-sold-auto", _ebaysold_lock, EBAY_WAITING, lambda: ebay_sales_close(3, [p["key"] for p in todo]))
        except Exception as e:
            EBAY_WAITING.update(checked=time.strftime("%H:%M"), error=str(e)[:200]); log("EBAY-SALES-LOOP %s" % e)
        if not cloud_mode(): heartbeat()
        time.sleep(EBAY_EVERY)

# ------------------------------------------------------------------ AUTO CLOSE-OUT (v40, 2026-10-05)
# Papa Duck: "why does ebay not automatically start the close out process as soon as it sees the sale" -> "yes".
# Every sales check (eBay 15 min, AbeBooks 15 min, Etsy 30 min) now closes out what it finds by itself: off the
# other stores + Sold Archive + Inventory. The full report goes to the Runs archive (action "...-sold-auto") and the
# pill shows what was closed. Only PAID orders are picked up; a sale already logged is never closed twice.
AUTO_CLOSE = True

def _auto_note(W, closed, problems):
    W["last_auto"] = {"when": time.strftime("%m-%d %H:%M"), "closed": closed, "problems": problems}

def etsy_sales_close(days=3, keys=None):
    """Etsy sale -> eBay END (last copy) or quantity, AbeBooks DELETE (last copy), Amazon off/quantity, Sold Archive + Inventory.
    Etsy lowers its own quantity. Same rules the Sold tab Run uses for an Etsy row."""
    done = _sold_done(); by = {}
    for o in etsy_orders(days):
        if not o["pd"] or ("etsy:%s:%s" % (o["order"], o["pd"])) in done: continue
        k = "%s:%s" % (o["order"], o["pd"])
        if keys and k not in keys: continue
        if k in by: by[k]["qty"] += o["qty"]; by[k]["price"] = round(by[k]["price"] + o["price"], 2)
        else: by[k] = dict(o)
    lines = ["ETSY SALES - %d to close" % len(by)]; closed, problems, sales = [], [], []
    for o in by.values():
        pd, q = o["pd"], o["qty"]; ok = True
        iid = re.sub(r"\D", "", str((at_lookup([pd]).get(pd) or {}).get("itemid") or ""))
        it = (ebay_items([iid]) or [{}])[0] if iid else {}
        active = it.get("status") == "Active"; rem = int(it.get("remaining") or 0) if active else 0
        left = max(0, rem - q) if active else 0
        L = ["%s  %s  sold $%.2f on Etsy  (eBay now: %s)" % (pd, o["title"][:50], o["price"], ("Active, %d left" % rem) if active else (it.get("status") or "no eBay listing"))]
        if active and left == 0:
            run([EBAY, "end", iid, "--force"]); v = fmt_verify_ebay(ebay_items([iid])); L.append("    eBay: " + v)
            if "Active" in v: ok = False
        elif active:
            run([EBAY, "revise", iid, str(it.get("price") or ""), "--qty", str(left)]); L.append("    eBay: " + fmt_verify_ebay(ebay_items([iid])))
        else:
            L.append("    eBay: nothing to end")
        if left == 0:
            if _abe_deleted(pd): L.append("    AbeBooks: already deleted earlier - nothing to do")
            else:
                rc, out = run([ABE, "delete", pd])
                L.append("    AbeBooks: " + next((l.strip() for l in out.splitlines() if pd in l), out.strip()[-160:] or "delete sent"))
        else:
            L.append("    AbeBooks: kept (%d still for sale)" % left)
        try: L.append("    Amazon: " + amz_sync({pd: left}))
        except Exception as e: L.append("    Amazon: check failed %s" % str(e)[:120]); ok = False
        sales.append({"pd": pd, "channel": "etsy", "price": o["price"], "qty": q, "date": o["date"], "left": left, "order": o["order"], "title": o["title"]})
        (closed if ok else problems).append(pd); lines += L
    if sales:
        txt, logged, skipped, bad = sold_log(sales); lines += ["", txt]; problems += [x for x in bad if x not in problems]
    lines += ["", ("*** CHECK: %s ***" % ", ".join(problems)) if problems else ("CLOSED - every Etsy sale is off eBay / AbeBooks / Amazon and logged." if by else "Nothing new to close.")]
    return "\n".join(lines), closed, problems

def _auto_run(name, lock, W, fn):
    """Run one close-out under its lock; archive it; note it on the pill."""
    if not lock.acquire(blocking=False): return
    _set_busy(1)
    try: txt, closed, problems = fn()
    finally: _set_busy(-1); lock.release()
    if closed or problems:
        archive(name, ", ".join(closed + problems)[:250], "warning" if problems else "ok", txt, txt, "(automatic)")
        _auto_note(W, closed, problems); log("AUTO %s closed=%s problems=%s" % (name, closed, problems))
    W["orders"] = []

# ------------------------------------------------------------------ CLOUD SALES (v42, 2026-10-06)
# Papa Duck: "better yet can we move it to supabase?" ... "yes store my keys in supabase".
# The Supabase function "sales-cloud" now checks eBay / AbeBooks / Etsy / Amazon every 5 minutes and closes out every
# sale itself - the home computer can sleep. "Send keys to cloud" (Settings) reads the key files on THIS computer and
# sends them straight to the Supabase vault over HTTPS; they never pass through chat. After that:
#   * this helper STOPS its own sales checks (no double close-outs) and shows the cloud's checks in the sales box
#   * Etsy access tokens come FROM the cloud - the cloud is the only place that rotates the Etsy refresh token
CLOUD_FN = SUPA_URL + "/functions/v1/sales-cloud"
CLOUD_INTAKE = "PASTE_FROM_WORKING_COPY"   # GitHub copy: redacted. Only lets this helper hand keys to the cloud
CLOUD_INI = os.path.join(BASE, "cloud.ini")
CLOUD_STATUS = {"checked": "", "error": "", "stores": {}}

def cloud_token():
    if not os.path.exists(CLOUD_INI): return ""
    c = configparser.ConfigParser(); c.read(CLOUD_INI, encoding="utf-8")
    try: return c["cloud"]["token"].strip()
    except KeyError: return ""

def cloud_mode(): return bool(cloud_token())

def _cloud_post(action, body=None, intake=False, timeout=90):
    h = {"Content-Type": "application/json", "User-Agent": UA}
    if intake: h["x-pd-intake"] = CLOUD_INTAKE
    t = cloud_token()
    if t: h["x-pd-token"] = t
    req = urllib.request.Request(CLOUD_FN + "?action=" + action, data=json.dumps(body or {}).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try: j = json.loads(e.read().decode() or "{}")
        except Exception: j = {}
        raise ValueError("cloud %s -> %d %s" % (action, e.code, j.get("error") or ""))

def _ini_section(path, names):
    if not os.path.exists(path): return {}
    c = configparser.ConfigParser(); c.read(path, encoding="utf-8-sig")
    for n in names:
        if n in c: return dict(c[n])
    return dict(c[c.sections()[0]]) if c.sections() else {}

def cloud_collect_keys():
    """Read every store's keys from the files on this computer. Returns (body, list of what was found)."""
    body, have = {}, []
    e = _ini_section(EBAY_INI, ["ebay"])
    if e.get("auth_token"): body["ebay"] = {k: e.get(k, "") for k in ("app_id", "dev_id", "cert_id", "auth_token")}; have.append("eBay")
    a = _ini_section(ABE_INI, ["abebooks", "abe"])
    if a.get("username") and a.get("password"):
        body["abe"] = {"username": a["username"], "password": a["password"]}
        try:
            ou, op = abe_order_creds()
            if (ou, op) != (a["username"], a["password"]): body["abe"].update(order_username=ou, order_password=op)
        except Exception: pass
        have.append("AbeBooks")
    tok = at_token()
    if tok: body["airtable"] = {"token": tok}; have.append("Airtable")
    m = amz_creds()
    if m: body["amazon"] = {k: m[k] for k in ("client_id", "client_secret", "refresh_token", "seller_id")}; have.append("Amazon")
    d = etsy_cred_dir()
    if d:
        try:
            secret = open(os.path.join(d, "etsy_shared_secret.txt"), encoding="utf-8-sig").read().strip()
            tp = os.path.join(d, "etsy_tokens.json"); tj = json.load(open(tp, encoding="utf-8-sig"))
            exp = int((os.path.getmtime(tp) + int(tj.get("expires_in") or 0)) * 1000)
            if tj.get("refresh_token") and secret:
                body["etsy"] = {"shared_secret": secret, "refresh_token": tj["refresh_token"], "access_token": tj.get("access_token", ""), "expires_at": exp}
                have.append("Etsy")
        except Exception as ex: log("CLOUD etsy keys unreadable %s" % ex)
    return body, have

def cloud_send_keys():
    body, have = cloud_collect_keys()
    if "airtable" not in body: raise ValueError("Airtable token not set on this computer - Settings > Airtable first")
    j = _cloud_post("keys", body, intake=True, timeout=120)
    if j.get("pc_token"):
        with open(CLOUD_INI, "w", encoding="utf-8") as f: f.write("[cloud]\ntoken = %s\n" % j["pc_token"])
        try: os.chmod(CLOUD_INI, 0o600)
        except Exception: pass
    if not cloud_token(): raise ValueError("the cloud did not hand back its token - nothing switched over")
    test = j.get("test") or {}
    lines = ["KEYS SENT TO THE CLOUD (Supabase vault): " + ", ".join(have), ""]
    lines += ["%-9s %s" % (k, v) for k, v in test.items()]
    bad = [k for k, v in test.items() if not str(v).startswith("OK") and v != "not sent"]
    lines += ["", ("*** CHECK: %s did not answer - tell Claude ***" % ", ".join(bad)) if bad else
              "CLOUD IS ON - sales on every store are checked and closed out every 5 minutes, even when this computer sleeps.",
              "This computer stopped its own sales checks (no double close-outs)."]
    return "\n".join(lines), bad

def cloud_etsy_token():
    j = _cloud_post("etsy-token", {}, timeout=60)
    if not j.get("access_token"): raise ValueError("the cloud gave no Etsy token: %s" % j.get("error", ""))
    return j["access_token"]

def _hm(iso):
    try: return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except Exception: return ""

def cloud_status_loop():
    """Cloud mode: mirror the cloud's last checks into the three sales pills every 2 minutes."""
    time.sleep(20)
    names = {"ebay": EBAY_WAITING, "abe": ABE_WAITING, "etsy": ETSY_WAITING}
    while True:
        if cloud_mode():
            try:
                j = _cloud_post("status", {}, timeout=30)
                CLOUD_STATUS.update(checked=time.strftime("%H:%M"), error="", stores=j.get("stores") or {})
                for k, W in names.items():
                    s = (j.get("stores") or {}).get(k) or {}
                    W.update(checked=(_hm(s.get("checked")) + " cloud") if s.get("checked") else "cloud", error=s.get("error") or "", orders=[])
                    if s.get("closed"): W["last_auto"] = {"when": _hm(s.get("closed_at")), "closed": s.get("closed"), "problems": s.get("problems") or []}
            except Exception as e:
                CLOUD_STATUS.update(checked=time.strftime("%H:%M"), error=str(e)[:200])
                for W in names.values(): W.update(error="cloud status: " + str(e)[:150])
        time.sleep(120)

# ------------------------------------------------------------------ FBA STICKERS (v44, 2026-10-07)
# Papa Duck: "When the book is clicked it needs to automatically go and get the sku label and print it so I can slap it
# on the book and put in the box." The cloud (fba-cloud) lists the book FBA-only and gets its FNSKU; this helper picks the
# sticker up and prints it SILENTLY on the sticker printer (JADENS, 2.25 x 1.25 in rolls) - no print dialog.
# Code 128 barcode of the FNSKU + the FNSKU in text + title + condition, the way Amazon's own labels read.
FBA_FN = SUPA_URL + "/functions/v1/fba-cloud"
FBA_PRINTER_TXT = os.path.join(BASE, "fba_printer.txt")
FBA_PS1 = os.path.join(BASE, "fba_print.ps1")
FBA_JOBDIR = os.path.join(BASE, "fba_jobs")
FBA_STATE = {"checked": "", "error": "", "printed": [], "waiting": 0}

FBA_PS1_TEXT = r'''# Papa Duck - prints one FBA sticker (2.25 x 1.25 in) silently. Written by papaduck_local.py v44.
param([string]$Job)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$j = Get-Content -Raw -Encoding UTF8 $Job | ConvertFrom-Json
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = $j.printer
if (-not $doc.PrinterSettings.IsValid) { Write-Output ("ERROR printer not found: " + $j.printer); exit 2 }
$doc.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize("PapaDuck FBA 2.25x1.25", 225, 125)
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$doc.DefaultPageSettings.Landscape = $false
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$doc.DocumentName = "PapaDuck FBA " + $j.fnsku
$doc.add_PrintPage({
  param($s, $e)
  $g = $e.Graphics
  $g.PageUnit = [System.Drawing.GraphicsUnit]::Pixel
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
  $dpi = $g.DpiX
  $g.TranslateTransform([single](-$e.PageSettings.HardMarginX * $dpi / 100), [single](-$e.PageSettings.HardMarginY * $dpi / 100))
  $W = [int](2.25 * $dpi); $bars = [string]$j.bars; $n = $bars.Length
  $dots = [Math]::Max(1, [Math]::Floor((2.05 * $dpi) / $n))
  $x0 = [int](($W - $n * $dots) / 2); $y0 = [int](0.07 * $dpi); $bh = [int](0.50 * $dpi)
  $black = [System.Drawing.Brushes]::Black
  $i = 0
  while ($i -lt $n) {
    if ($bars[$i] -eq '1') { $k = $i; while ($k -lt $n -and $bars[$k] -eq '1') { $k++ }
      $g.FillRectangle($black, $x0 + $i * $dots, $y0, ($k - $i) * $dots, $bh); $i = $k } else { $i++ }
  }
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
  $sf.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
  $f1 = New-Object System.Drawing.Font("Arial", 9, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $f2 = New-Object System.Drawing.Font("Arial", 6.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $g.DrawString([string]$j.fnsku, $f1, $black, (New-Object System.Drawing.RectangleF(0, [single](0.59 * $dpi), [single]$W, [single](0.19 * $dpi))), $sf)
  $g.DrawString([string]$j.title, $f2, $black, (New-Object System.Drawing.RectangleF([single](0.08 * $dpi), [single](0.80 * $dpi), [single]($W - 0.16 * $dpi), [single](0.16 * $dpi))), $sf)
  $g.DrawString([string]$j.cond, $f2, $black, (New-Object System.Drawing.RectangleF([single](0.08 * $dpi), [single](0.97 * $dpi), [single]($W - 0.16 * $dpi), [single](0.16 * $dpi))), $sf)
  $e.HasMorePages = $false
})
$doc.Print()
Write-Output "PRINTED"
'''

_C128 = ["212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232",
  "122132", "122231", "113222", "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122",
  "321221", "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311",
  "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", "231131", "213113",
  "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224", "111422",
  "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111",
  "241112", "134111", "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121",
  "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112"]

def code128b(text):
    """Code 128 set B -> module string ('1' = bar), with the 10-module quiet zone on each side."""
    vals = [104] + [ord(c) - 32 for c in text]
    if any(v < 0 or v > 95 for v in vals[1:]): raise ValueError("FNSKU has a character Code 128B can't print: %r" % text)
    chk = (vals[0] + sum(i * v for i, v in enumerate(vals[1:], 1))) % 103
    out = []
    for v in vals + [chk, 106]:
        for k, w in enumerate(_C128[v]): out.append(("1" if k % 2 == 0 else "0") * int(w))
    return "0" * 10 + "".join(out) + "0" * 10

def fba_printer():
    try: return open(FBA_PRINTER_TXT, encoding="utf-8-sig").read().strip()
    except Exception: return ""

def _ps(args, timeout=60):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"] + args,
                          capture_output=True, text=True, timeout=timeout, creationflags=flags)

def fba_printers():
    p = _ps(["-Command", "Add-Type -AssemblyName System.Drawing; [System.Drawing.Printing.PrinterSettings]::InstalledPrinters"], timeout=40)
    return [x.strip() for x in (p.stdout or "").splitlines() if x.strip()]

def fba_print(job, printer=None):
    printer = printer or fba_printer()
    if not printer: return False, "no sticker printer chosen yet (Dispatch > Settings > FBA sticker printer)"
    with open(FBA_PS1, "w", encoding="utf-8-sig") as f: f.write(FBA_PS1_TEXT)
    os.makedirs(FBA_JOBDIR, exist_ok=True)
    jp = os.path.join(FBA_JOBDIR, "job_%s.json" % re.sub(r"[^A-Za-z0-9_-]", "", str(job.get("id", "test"))))
    fn = str(job["fnsku"]).strip().upper()
    title = re.sub(r"\s+", " ", str(job.get("title") or ""))[:80]
    json.dump({"printer": printer, "fnsku": fn, "bars": code128b(fn), "title": title, "cond": job.get("cond") or "Used"},
              open(jp, "w", encoding="utf-8"))
    try:
        p = _ps(["-File", FBA_PS1, "-Job", jp], timeout=90)
    except subprocess.TimeoutExpired:
        return False, "the printer did not answer in 90 seconds - is it on and plugged in by USB?"
    out = ((p.stdout or "") + (p.stderr or "")).strip()
    log("FBA-PRINT %s %s -> %s" % (job.get("pd", ""), fn, out[:300]))
    return ("PRINTED" in out and p.returncode == 0), ("" if "PRINTED" in out else out[:300] or "print failed")

def _fba_post(action, body=None, timeout=60):
    h = {"Content-Type": "application/json", "User-Agent": UA, "x-pd-token": cloud_token()}
    req = urllib.request.Request(FBA_FN + "?action=" + action, data=json.dumps(body or {}).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raise ValueError("fba-cloud %s -> %d %s" % (action, e.code, e.read().decode(errors="replace")[:200]))

_fba_print_lock = threading.Lock()

def fba_print_ready(ids):
    """v45 (his ask 2026-10-07 21:17): Dispatch "Ready to print" - print all or one at a time; a book leaves the list once its sticker prints."""
    if not fba_printer(): raise ValueError("No sticker printer chosen yet - Settings > FBA sticker printer")
    with _fba_print_lock:
        ready = (_fba_post("holding", {}, timeout=30).get("ready") or [])
        want = ready if ids == "all" else [r for r in ready if r["id"] in set(int(i) for i in (ids or []))]
        out = []
        for r in want:
            job = {"id": r["id"], "pd": r["pd"], "fnsku": r["fnsku"], "title": r.get("title") or "", "cond": r.get("cond_label") or "Used"}
            ok, err = fba_print(job)
            try: _fba_post("printed", {"id": r["id"], "ok": ok, "error": err}, timeout=30)
            except Exception as e: err = (err + " / could not tell the cloud: " + str(e)[:120]).strip(" /")
            out.append({"pd": r["pd"], "fnsku": r["fnsku"], "ok": ok, "error": err})
            FBA_STATE["printed"] = ([{"pd": r["pd"], "fnsku": r["fnsku"], "ok": ok, "error": err, "at": time.strftime("%H:%M")}] + FBA_STATE["printed"])[:10]
        return out

def fba_print_loop():
    """Every 20 s (every 4 s while he is sending books to FBA) ask the cloud for stickers, print them, report back."""
    time.sleep(12)
    while True:
        wait = 60
        if cloud_mode():
            try:
                pr = fba_printer()
                j = _fba_post("print-next", {"printer": pr, "version": VERSION}, timeout=30)
                jobs = j.get("jobs") or []
                FBA_STATE.update(checked=time.strftime("%H:%M:%S"), error="", waiting=len(jobs) if not pr else 0)
                if pr:
                    for job in jobs:
                        ok, err = fba_print(job, pr)
                        _fba_post("printed", {"id": job["id"], "ok": ok, "error": err}, timeout=30)
                        FBA_STATE["printed"] = ([{"pd": job.get("pd"), "fnsku": job.get("fnsku"), "ok": ok, "error": err, "at": time.strftime("%H:%M")}] + FBA_STATE["printed"])[:10]
                elif jobs:
                    FBA_STATE["error"] = "%d sticker(s) waiting - choose the sticker printer in Settings" % len(jobs)
                wait = 4 if (j.get("busy") or jobs) else 20
            except Exception as e:
                FBA_STATE.update(checked=time.strftime("%H:%M:%S"), error=str(e)[:200]); wait = 30
        time.sleep(wait)

# ------------------------------------------------------------------ HTTP
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _cors(self):
        # v8: the page may be opened straight from Downloads (file://) like Book Station - a file page
        # sends Origin "null". Still 127.0.0.1-only, still needs the X-PapaDuck header on every POST.
        o = self.headers.get("Origin", "")
        self.send_header("Access-Control-Allow-Origin", "null" if o == "null" else ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-PapaDuck")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def _guard(self):
        o = self.headers.get("Origin", "")
        if o and o not in (ORIGIN, "null"): self._json(403, {"error": "origin not allowed"}); return False
        if self.headers.get("X-PapaDuck") != "1": self._json(403, {"error": "missing X-PapaDuck header"}); return False
        return True
    def do_OPTIONS(self): self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/", "/index.html", "/station", "/station/"):
            if not os.path.exists(PAGE): self._json(404, {"error": "page not found: %s" % PAGE}); return
            body = open(PAGE, "rb").read()
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if p == "/ping":
            self._json(200, {"ok": True, "version": VERSION, "ebay": os.path.exists(EBAY), "abe": os.path.exists(ABE), "auto": True, "busy": bool(_busy),
                             "idmap": os.path.exists(IDMAP), "airtable": bool(at_token()), "etsy": bool(etsy_cred_dir()), "amazon": bool(amz_creds()), "keepa": bool(keepa_key()),
                             "time": time.strftime("%Y-%m-%d %H:%M:%S")}); return
        if p == "/downloads": self._json(200, {"files": downloads_candidates(), "folder": DOWNLOADS}); return
        if p == "/idmap":
            try: self._json(200, json.load(open(IDMAP)))
            except Exception: self._json(200, {})
            return
        if p == "/rows/list":
            fs = sorted(glob.glob(os.path.join(EBAYDIR, "PapaDuck_eBay_Rows_*.json")), key=os.path.getmtime, reverse=True)
            self._json(200, {"files": [os.path.basename(f) for f in fs]}); return
        if p == "/abe/list":
            fs = sorted(glob.glob(os.path.join(ABEDIR, "PapaDuck_AbeBooks_*.txt")), key=os.path.getmtime, reverse=True)
            self._json(200, {"files": [os.path.basename(f) for f in fs]}); return
        if p == "/etsy/list":
            fs = sorted(glob.glob(os.path.join(ETSYDIR, "PapaDuck_Etsy_*.json")), key=os.path.getmtime, reverse=True)
            res = _etsy_results()
            self._json(200, {"files": [os.path.basename(f) for f in fs], "keys": bool(etsy_cred_dir()),
                             "listed": {k: v.get("listing_id") for k, v in res.items() if v.get("status") == "OK"}}); return
        if p == "/amazon/list":
            fs = sorted(glob.glob(os.path.join(AMZDIR, "PapaDuck_Amazon_*.json")), key=os.path.getmtime, reverse=True)
            res = _amz_results()
            self._json(200, {"files": [os.path.basename(f) for f in fs], "keys": bool(amz_creds()),
                             "listed": {k: v.get("asin") for k, v in res.items() if v.get("status") == "LISTED"}}); return
        if p == "/runs": self._json(200, {"runs": recent_runs()}); return
        if p == "/progress": self._json(200, prog_snapshot()); return
        if p == "/abe/waiting": self._json(200, ABE_WAITING); return
        if p == "/etsy/waiting": self._json(200, ETSY_WAITING); return
        if p == "/ebay/waiting": self._json(200, EBAY_WAITING); return
        if p == "/cloud/status": self._json(200, dict(CLOUD_STATUS, cloud=cloud_mode())); return
        if p == "/fba/status": self._json(200, dict(FBA_STATE, printer=fba_printer(), cloud=cloud_mode())); return   # v44
        if p == "/fba/holding":                 # v45: Ready to print
            try: self._json(200, dict(_fba_post("holding", {}, timeout=30), printer=fba_printer()) if cloud_mode() else {"ready": [], "working": [], "error": "cloud not on yet - Settings > Send keys to cloud"})
            except Exception as e: self._json(200, {"ready": [], "working": [], "error": str(e)[:200]})
            return
        if p == "/fba/printers":
            try: self._json(200, {"printers": fba_printers(), "chosen": fba_printer()})
            except Exception as e: self._json(200, {"printers": [], "chosen": fba_printer(), "error": str(e)[:200]})
            return
        if p == "/sold/recent":                 # v43: the Sold grid (cloud close-outs, one result per store)
            try: self._json(200, _cloud_post("recent", {}, timeout=30) if cloud_mode() else {"sales": [], "error": "cloud not on yet - Settings > Send keys to cloud"})
            except Exception as e: self._json(200, {"sales": [], "error": str(e)[:200]})
            return
        self._json(404, {"error": "no such path"})

    def do_POST(self):
        if not self._guard(): return
        n = int(self.headers.get("Content-Length") or 0)
        try: req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception: self._json(400, {"error": "bad json"}); return
        inp = json.dumps(req)[:20000]
        try:
            if self.path == "/settings/airtable":
                tok = str(req.get("token", "")).strip()
                if not tok.startswith("pat"): raise ValueError("that does not look like an Airtable personal access token (starts with 'pat')")
                with open(ATINI, "w", encoding="utf-8") as f: f.write("[airtable]\ntoken = %s\n" % tok)
                try: os.chmod(ATINI, 0o600)
                except Exception: pass
                rid = archive("install", "", "ok", "airtable token saved", inp="(token withheld)")
                self._json(200, {"ok": True, "airtable_reachable": bool(rid)})

            elif self.path == "/settings/amazon":
                old = amz_creds()       # v27: a blank box keeps the key already saved (so the Keepa key can be added alone)
                vals = {k: (str(req.get(k, "")).strip() or old.get(k, "")) for k in ("client_id", "client_secret", "refresh_token", "seller_id")}
                if not vals["client_id"].startswith("amzn1.application-oa2-client."): raise ValueError("Client ID should start with amzn1.application-oa2-client.")
                if not vals["refresh_token"].startswith("Atzr|"): raise ValueError("Refresh token should start with Atzr|")
                if not re.match(r"^A[0-9A-Z]{8,20}$", vals["seller_id"]): raise ValueError("Seller ID (Merchant Token) looks wrong - Seller Central > Settings > Account Info > Merchant Token")
                if not vals["client_secret"]: raise ValueError("Client Secret is blank")
                kk = str(req.get("keepa_key", "")).strip() or keepa_key()
                with open(AMZ_INI, "w", encoding="utf-8") as f:
                    f.write("[amazon]\n" + "".join("%s = %s\n" % kv for kv in vals.items()) + (("[keepa]\nkey = %s\n" % kk) if kk else ""))
                try: os.chmod(AMZ_INI, 0o600)
                except Exception: pass
                try: AmazonAPI(); ok, msg = True, "Amazon accepted the keys"
                except Exception as e: ok, msg = False, str(e)
                archive("install", "", "ok" if ok else "warning", "amazon keys saved - " + msg, inp="(keys withheld)")
                self._json(200, {"ok": True, "login": ok, "message": msg})

            elif self.path == "/amazon/check":
                api = AmazonAPI()
                r = amz_check(api, {"isbn": req.get("isbn"), "title": req.get("title"), "author": req.get("author"), "grade": req.get("grade") or "Very Good"})
                txt = json.dumps(r, indent=1)
                archive("amazon-check", str(req.get("isbn") or req.get("title") or "")[:250], "ok", txt, txt, inp)
                self._json(200, {"result": r, "verify": txt})

            elif self.path == "/amazon/get":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(AMZDIR, f)
                if not f.startswith("PapaDuck_Amazon_") or not os.path.exists(path): raise ValueError("no such Amazon file in %s" % AMZDIR)
                books = json.load(open(path, encoding="utf-8")); books = [books] if isinstance(books, dict) else books
                res = _amz_results()
                self._json(200, {"file": f, "problems": amz_preflight(books), "books": [dict({k: b.get(k) for k in ("sku", "title", "asin", "cond", "price", "quantity", "fit", "cover")},
                    listed=(res.get(b.get("sku")) or {}).get("asin", "") if (res.get(b.get("sku")) or {}).get("status") == "LISTED" else "") for b in books]})

            elif self.path == "/amazon/list-books":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(AMZDIR, f)
                if not f.startswith("PapaDuck_Amazon_") or not os.path.exists(path): raise ValueError("no such Amazon file in %s" % AMZDIR)
                only = [p for p in only_pds(req.get("ids") or []) if PD_RE.match(p)]
                if not _amzlist_lock.acquire(blocking=False): raise ValueError("an Amazon send is already running - wait for it to finish")
                _set_busy(1)
                try: txt, done, failed, res = amz_list_file(path, only or None, bool(req.get("preview")), bool(req.get("resend")))
                except Exception:
                    prog_end("FAILED - see the message"); raise
                finally: _set_busy(-1); _amzlist_lock.release()
                rid = archive("amazon-preview" if req.get("preview") else "amazon-list", ", ".join(done + failed)[:250] or f, res, txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "done": done, "failed": failed, "result": res, "archived": rid})

            elif self.path == "/amazon/fix-offer":
                f = os.path.basename(str(req.get("file") or "")); path = os.path.join(AMZDIR, f)
                if not f.startswith("PapaDuck_Amazon_") or not os.path.exists(path): raise ValueError("no such Amazon file in %s" % AMZDIR)
                only = [p for p in only_pds(req.get("ids") or []) if PD_RE.match(p)]
                if not _amzlist_lock.acquire(blocking=False): raise ValueError("an Amazon send is already running - wait for it to finish")
                _set_busy(1)
                try: txt, done, failed, res = amz_fix_offer(path, only or None)
                except Exception:
                    prog_end("FAILED - see the message"); raise
                finally: _set_busy(-1); _amzlist_lock.release()
                rid = archive("amazon-fix-offer", ", ".join(done + failed)[:250] or f, res, txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "done": done, "failed": failed, "result": res, "archived": rid})

            elif self.path == "/cloud/send-keys":
                txt, bad = cloud_send_keys()
                rid = archive("cloud-keys", "", "warning" if bad else "ok", txt, txt, "(keys withheld)")
                self._json(200, {"out": txt, "verify": txt, "bad": bad, "cloud": cloud_mode(), "archived": rid})

            elif self.path == "/fba/printer":            # v44: which printer gets the FBA stickers
                name = str(req.get("name", "")).strip()
                if name and name not in fba_printers(): raise ValueError("Windows has no printer called %s" % name)
                with open(FBA_PRINTER_TXT, "w", encoding="utf-8") as f: f.write(name)
                self._json(200, {"ok": True, "chosen": name})

            elif self.path == "/fba/print":              # v45: Print all / Print one from Ready to print
                res = fba_print_ready("all" if req.get("all") else req.get("ids") or [])
                bad = [r for r in res if not r["ok"]]
                txt = "\n".join("%s %s %s" % (r["pd"], r["fnsku"], "PRINTED" if r["ok"] else "NOT PRINTED: " + r["error"]) for r in res) or "nothing to print"
                rid = archive("fba-print", ",".join(r["pd"] for r in res), "warning" if bad else "ok", txt, txt, inp=json.dumps(req))
                self._json(200, {"ok": not bad, "results": res, "archived": rid})

            elif self.path == "/fba/test-print":
                ok, err = fba_print({"id": "test", "pd": "TEST", "fnsku": "X00TEST123", "title": "Papa Duck test sticker - Saxon Math 5/4 Student Edition",
                                     "cond": "Used - Very Good"}, str(req.get("name", "")).strip() or None)
                rid = archive("fba-test-print", "", "ok" if ok else "failed", "printed" if ok else err, "printed" if ok else err, inp=json.dumps(req))
                self._json(200, {"ok": ok, "error": err, "archived": rid})

            elif self.path == "/ebay/sales":
                orders, plan = ebay_sales_plan(int(req.get("days") or 3))
                todo = [x for x in plan if x["state"] == "todo"]
                EBAY_WAITING.update(checked=time.strftime("%H:%M"), error="", orders=todo)
                self._json(200, {"orders": len(plan), "plan": plan})

            elif self.path == "/ebay/sales-close":
                if not _ebaysold_lock.acquire(blocking=False): raise ValueError("an eBay close-out is already running")
                _set_busy(1)
                try: txt, closed, problems = ebay_sales_close(int(req.get("days") or 3), req.get("keys") or None)
                finally: _set_busy(-1); _ebaysold_lock.release()
                rid = archive("ebay-sold", ", ".join(closed + problems)[:250], "warning" if problems else "ok", txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "closed": closed, "problems": problems, "archived": rid})

            elif self.path == "/sold/log":
                sales = req.get("sales") or []
                if not sales: raise ValueError("no sales given")
                if not _soldlog_lock.acquire(blocking=False): raise ValueError("a Sold Archive write is already running")
                try: txt, logged, skipped, problems = sold_log(sales)
                finally: _soldlog_lock.release()
                rid = archive("sold-log", ", ".join(logged + skipped + problems)[:250], "warning" if problems else "ok", txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "logged": logged, "skipped": skipped, "problems": problems, "archived": rid})

            elif self.path == "/etsy/orders":
                O = etsy_orders(int(req.get("days") or 7)); done = _sold_done()
                for o in O: o["logged"] = ("etsy:%s:%s" % (o["order"], o["pd"])) in done
                self._json(200, {"orders": O})

            elif self.path == "/abe/sales":
                orders, plan = abe_sales_plan(req.get("po") or None)
                todo = [x for x in plan if x["state"] == "todo"]
                if not req.get("po"): ABE_WAITING.update(checked=time.strftime("%H:%M"), error="", orders=todo)
                self._json(200, {"orders": len(orders), "plan": plan})

            elif self.path == "/abe/sales-close":
                if not _abesold_lock.acquire(blocking=False): raise ValueError("an AbeBooks close-out is already running")
                _set_busy(1)
                try: txt, closed, problems = abe_sales_close(req.get("po") or None, req.get("keys") or None)
                finally: _set_busy(-1); _abesold_lock.release()
                rid = archive("abe-sold", ", ".join(closed + problems)[:250], "warning" if problems else "ok", txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "closed": closed, "problems": problems, "archived": rid})

            elif self.path == "/amazon/check-live":
                skus = [p for p in only_pds(req.get("ids") or []) if PD_RE.match(p)]
                if not skus: raise ValueError("no PD numbers given")
                txt = amz_check_live(skus)
                rid = archive("amazon-check-live", ", ".join(skus)[:250], "ok", txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "archived": rid})

            elif self.path == "/amazon/close":
                raw = req.get("targets") or {}
                targets = {str(k): int(v) for k, v in raw.items() if PD_RE.match(str(k))}
                if not targets: raise ValueError("no PD numbers given")
                _set_busy(1)
                try: txt = amz_sync(targets)
                finally: _set_busy(-1)
                res = "warning" if ("FAILED" in txt or "NOT " in txt) else "ok"
                rid = archive("amazon-close", ", ".join(targets)[:250], res, txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "result": res, "archived": rid})

            elif self.path == "/amazon/orders":
                _set_busy(1)
                try: orders = amz_orders(int(req.get("days") or 7))
                finally: _set_busy(-1)
                self._json(200, {"orders": orders})

            elif self.path == "/amazon/sweep":
                txt = amz_sweep(int(req.get("limit") or 20))
                self._json(200, {"verify": txt})

            elif self.path == "/idlookup":
                pds = [p for p in only_pds(req.get("ids")) if PD_RE.match(p)]
                found = at_lookup(pds)
                self._json(200, {"found": found, "airtable": bool(at_token())})

            elif self.path == "/ebay/item":
                items = ebay_items(only_pds(req.get("ids")))
                self._json(200, {"items": items})

            elif self.path == "/ebay/end":
                ids = only_pds(req.get("ids")); args = ids + (["--force"] if req.get("force") else [])
                rc, out = run([EBAY, "end"] + args)
                ver = fmt_verify_ebay(ebay_items(ids))                       # VERIFY: read the listings back
                rid = archive("ebay-end", ", ".join(ids), result_of(rc, out), out, ver, inp)
                self._json(200, {"rc": rc, "out": out, "verify": ver, "archived": rid})

            elif self.path == "/ebay/revise":
                pd = only_pds([req.get("id")])[0]; price = "%.2f" % float(req["price"])
                args = [EBAY, "revise", pd, price]
                if req.get("qty") is not None: args += ["--qty", str(int(req["qty"]))]
                rc, out = run(args)
                ver = fmt_verify_ebay(ebay_items([pd]))
                rid = archive("ebay-revise", pd, result_of(rc, out), out, ver, inp)
                self._json(200, {"rc": rc, "out": out, "verify": ver, "archived": rid})

            elif self.path == "/ebay/comps":
                q = str(req.get("q", "")).strip()[:120]
                if not q: raise ValueError("empty query")
                rc, out = run([EBAY, "comps", q, "--sold"])
                rid = archive("ebay-comps", q, result_of(rc, out), out, "", inp)
                self._json(200, {"rc": rc, "out": out, "archived": rid})

            elif self.path == "/abe/delete":
                pds = only_pds(req.get("ids")); titles = req.get("titles") or {}
                outs, vers, rcs = [], [], 0
                for pd in pds:
                    if not PD_RE.match(pd): raise ValueError("AbeBooks delete needs a PD number, got %s" % pd)
                    rc, out = run([ABE, "delete", pd]); rcs += rc; outs.append(out)
                    t = titles.get(pd) or ""
                    if not t:
                        its = ebay_items([pd]) if pd in (json.load(open(IDMAP)) if os.path.exists(IDMAP) else {}) else []
                        t = its[0].get("title", "") if its else ""
                    if not t:                                                   # v20: Airtable title fallback
                        t = at_lookup([pd]).get(pd, {}).get("title", "")
                    vers.append("%s: %s" % (pd, fmt_verify_abe(abe_verify(t)) if t else "no title known - cannot check public site"))
                out = "\n".join(outs); ver = "\n".join(vers)
                rid = archive("abe-delete", ", ".join(pds), result_of(rcs, out), out, ver, inp)
                self._json(200, {"rc": rcs, "out": out, "verify": ver, "archived": rid})

            elif self.path == "/abe/verify":
                pds = req.get("ids") or []; titles = req.get("titles") or {}
                vers = ["%s: %s" % (pd, fmt_verify_abe(abe_verify(titles.get(pd, "")))) for pd in pds]
                ver = "\n".join(vers); rid = archive("abe-verify", ", ".join(pds), "ok", "", ver, inp)
                self._json(200, {"verify": ver, "archived": rid})

            elif self.path == "/rows/get":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(EBAYDIR, f)
                if not f.startswith("PapaDuck_eBay_Rows_") or not os.path.exists(path): raise ValueError("no such rows file")
                self._json(200, {"file": f, "rows": json.load(open(path, encoding="utf-8"))})

            elif self.path == "/rows/save":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(EBAYDIR, f)
                if not f.startswith("PapaDuck_eBay_Rows_"): raise ValueError("bad rows file name")
                rows = req.get("rows") or {}
                if os.path.exists(path): shutil.copy2(path, path + ".prev")
                json.dump(rows, open(path, "w", encoding="utf-8"), indent=1)
                changes = req.get("changes") or ""
                rid = archive("review-save", ", ".join(rows.keys())[:250], "ok", "saved %s" % f, "", changes)
                self._json(200, {"ok": True, "archived": rid})

            elif self.path == "/ebay/add":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(EBAYDIR, f)
                if not f.startswith("PapaDuck_eBay_Rows_") or not os.path.exists(path): raise ValueError("no such rows file")
                ids = only_pds(req.get("ids") or [])
                rc, out = run([EBAY, "add", path] + ids, timeout=1800)
                listed = re.findall(r"RESULT\s+(PD-\d{4}[A-Z]?)\s+Ack=\w+\s+ItemID=(\d+)", out)
                try: rowsj = json.load(open(path, encoding="utf-8"))
                except Exception: rowsj = {}
                items = ebay_items([i for _, i in listed]) if listed else []
                ver = fmt_verify_ebay(items) if listed else "no ItemIDs returned"
                blocked = []
                checks = []
                for pd_, iid in listed:
                    b = rowsj.get(pd_, {}) if isinstance(rowsj, dict) else {}
                    exp = len(b.get("pics") or []) or None
                    it = next((x for x in items if str(x.get("itemid")) == str(iid)), {})
                    actual = None
                    for k in ("pictures", "photos", "pics", "picture_count", "PictureURL"):
                        v = it.get(k)
                        if isinstance(v, list): actual = len(v); break
                        if isinstance(v, int): actual = v; break
                    if exp is None:
                        checks.append("%s  photos: expected count unknown (no pics in rows file) - BLOCKED" % pd_); blocked.append(pd_)
                    elif actual is None:
                        checks.append("%s  photos: %d sent in the add; eBay item read-back does not expose a picture count - accounted for by the Ack=Success on all %d" % (pd_, exp, exp))
                    elif actual == exp:
                        checks.append("%s  photos: PASS %d/%d on eBay" % (pd_, actual, exp))
                    else:
                        checks.append("%s  photos: BLOCKED %d/%d on eBay (expected %d)" % (pd_, actual, exp, exp)); blocked.append(pd_)
                missing = [p for p in ids if p not in [x for x, _ in listed]]
                for p in missing: checks.append("%s  NOT LISTED - see output" % p); blocked.append(p)
                if checks: ver += "\n" + "\n".join(checks)
                ver += ("\n\n*** BLOCKED - not closed: " + ", ".join(sorted(set(blocked))) + " ***") if blocked else "\n\nCLOSED - every book listed and every photo accounted for."
                res = result_of(rc, out)
                if blocked and res == "ok": res = "warning"
                rid = archive("ebay-add", ", ".join(p for p, _ in listed) or ", ".join(ids), res, out, ver, "file=%s ids=%s" % (f, ids))
                self._json(200, {"rc": rc, "out": out, "verify": ver, "listed": listed, "blocked": sorted(set(blocked)), "archived": rid})

            elif self.path in ("/abe/blast", "/abe/push", "/abe/images"):
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(ABEDIR, f)
                if not f.startswith("PapaDuck_AbeBooks_") or not f.endswith(".txt") or not os.path.exists(path):
                    raise ValueError("no such AbeBooks file in %s" % ABEDIR)
                cmd = {"/abe/blast": "blast", "/abe/push": "push-ftps", "/abe/images": "push-images"}[self.path]
                pds = []
                try:
                    with open(path, encoding="utf-8") as fh:
                        for i, line in enumerate(fh):
                            if i == 0: continue
                            c = line.split("\t")[0].strip()
                            if PD_RE.match(c): pds.append(c)
                except Exception: pass
                pre, pre_ok, ptot, pok = abe_photo_report(path)
                if cmd == "blast" and not pre_ok and not req.get("force"):
                    rid = archive("abe-blast", ", ".join(pds)[:250], "refused", pre, pre, inp)
                    self._json(200, {"rc": 1, "out": pre, "verify": "REFUSED - dead source images, nothing was sent.\n" + pre,
                                     "pds": pds, "archived": rid}); return
                # v15: never let papaduck_abe.py spawn the photo script as a GRANDCHILD - under pythonw
                # (no console) a grandchild inherits no output handles and every print is lost. The
                # helper runs each stage itself, output captured. (Root cause of the silent photo stage.)
                if not os.path.exists(ABEIMG): raise ValueError("papaduck_abe_images.py is missing from %s" % ABEDIR)
                prog_start("abebooks-" + cmd, f, pds, {p: len(u) for p, u in abe_rows_photos(path).items()})
                if cmd == "blast":
                    prog_set(stage="1/3 sending the data file"); prog_all("data")
                    rc1, out1 = run([ABE, "push-ftps", path], timeout=600)
                    if rc1 != 0:
                        rc, out = rc1, "=== 1/2  DATA FILE ===\n" + out1 + "\n(data push failed - photos not attempted)"
                    else:
                        prog_set(stage="2/3 getting the photos ready"); prog_all("waiting", ("data",))
                        rc2, out2 = run_stream([ABEIMG, "--file", path], timeout=1800, on_line=abe_photo_line)
                        rc, out = rc2, "=== 1/2  DATA FILE ===\n" + out1 + "\n=== 2/2  PHOTOS (as files) ===\n" + out2
                elif cmd == "push-images":
                    prog_set(stage="sending photos")
                    rc, out = run_stream([ABEIMG, "--file", path], timeout=1800, on_line=abe_photo_line)
                else:
                    prog_set(stage="sending the data file"); prog_all("data")
                    rc, out = run([ABE, "push-ftps", path], timeout=600)
                    prog_all("done", ("data",))
                sent = re.findall(r"(PD-\d{4}[A-Z]?).{0,40}?SENT\s+(\d+)\s*/\s*(\d+)", out)
                expect = {p: len(u) for p, u in abe_rows_photos(path).items()}
                got = {t[0]: (int(t[1]), int(t[2])) for t in sent}
                lines, short = [], []
                for p in pds:
                    e = expect.get(p, 0)
                    if p in got:
                        a, b = got[p]
                        lines.append("%s  photos %d/%d sent  (file says %d)" % (p, a, b, e))
                        if a < b or a < e: short.append(p)
                    else:
                        lines.append("%s  NO SENT LINE IN OUTPUT  (file says %d photos)" % (p, e))
                        short.append(p)
                miss = short
                closed = (cmd == "push-ftps") or (not short and bool(pds))
                if cmd == "push-images" and not sent:
                    lines.append("push-images printed no per-PD SENT lines - raw output below is the evidence")
                ver = ("AbeBooks %s of %s\n" % (cmd, f) + pre + "\n"
                       + ("\n".join(lines) if lines else "no per-PD SENT lines in the output - read the raw output below")
                       + ("\n\n*** NOT CLOSED - photos unaccounted for on: " + ", ".join(miss)
                          + ". Re-run the push; it caches downloads and retries only the failures. ***"
                          if miss else ("\n\nCLOSED - every photo accounted for." if cmd in ("blast", "push-images") else ""))
                       + "\nRows in file: %d (%s)" % (len(pds), ", ".join(pds))
                       + "\nAbeBooks' search index refreshes about hourly - a low Count Report total is a QUEUE, not a failure. Never re-upload on a stale count.")
                res = result_of(rc, out)
                if not closed and res == "ok": res = "warning"          # never 'ok' with photos unaccounted for
                for p in miss: prog_set(p, state="short")
                prog_end("CLOSED" if closed else "NOT CLOSED")
                rid = archive("abe-" + {"blast": "blast", "push-ftps": "push", "push-images": "images"}[cmd], ", ".join(pds)[:250],
                              res, out, ver, inp)
                self._json(200, {"rc": rc, "out": out, "verify": ver, "pds": pds,
                                 "closed": closed, "short": miss, "archived": rid})

            elif self.path == "/etsy/get":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(ETSYDIR, f)
                if not f.startswith("PapaDuck_Etsy_") or not os.path.exists(path): raise ValueError("no such Etsy file in %s" % ETSYDIR)
                books = json.load(open(path, encoding="utf-8")); books = [books] if isinstance(books, dict) else books
                res = _etsy_results()
                self._json(200, {"file": f, "problems": etsy_preflight(books), "books": [{
                    "sku": b.get("sku"), "title": b.get("title"), "price": b.get("price"), "quantity": b.get("quantity"),
                    "year": b.get("pub_year"), "photos": len(b.get("image_urls") or []), "cover": (b.get("image_urls") or [""])[0],
                    "profile": ETSY_PROFILES.get(str(b.get("shipping_profile_id")), "?"), "section": b.get("section") or "",
                    "listed": (res.get(b.get("sku")) or {}).get("listing_id") if (res.get(b.get("sku")) or {}).get("status") == "OK" else ""} for b in books]})

            elif self.path == "/etsy/list-books":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(ETSYDIR, f)
                if not f.startswith("PapaDuck_Etsy_") or not os.path.exists(path): raise ValueError("no such Etsy file in %s" % ETSYDIR)
                only = [p for p in only_pds(req.get("ids") or []) if PD_RE.match(p)]
                if not _etsy_lock.acquire(blocking=False): raise ValueError("an Etsy send is already running - wait for it to finish")
                _set_busy(1)
                try: txt, done, failed, res = etsy_list_file(path, only or None)
                except Exception:
                    prog_end("FAILED - see the message"); raise
                finally: _set_busy(-1); _etsy_lock.release()
                rid = archive("etsy-list", ", ".join(done + failed)[:250] or f, res, txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "done": done, "failed": failed, "result": res, "archived": rid})

            elif self.path == "/etsy/update":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(ETSYDIR, f)
                if not f.startswith("PapaDuck_Etsy_") or not os.path.exists(path): raise ValueError("no such Etsy file in %s" % ETSYDIR)
                only = [p for p in only_pds(req.get("ids") or []) if PD_RE.match(p)]
                if not _etsy_lock.acquire(blocking=False): raise ValueError("an Etsy job is already running - wait for it to finish")
                _set_busy(1)
                try: txt, done, failed, res = etsy_update_file(path, only or None)
                except Exception:
                    prog_end("FAILED - see the message"); raise
                finally: _set_busy(-1); _etsy_lock.release()
                rid = archive("etsy-update", ", ".join(done + failed)[:250] or f, res, txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "done": done, "failed": failed, "result": res, "archived": rid})

            elif self.path == "/etsy/close":
                raw = req.get("targets") or {}
                targets = {str(k): int(v) for k, v in raw.items() if PD_RE.match(str(k))}
                if not targets: raise ValueError("no PD numbers given")
                _set_busy(1)
                try: txt = etsy_sync(targets)
                finally: _set_busy(-1)
                res = "warning" if ("FAILED" in txt or "STILL ACTIVE" in txt or "DID NOT CHANGE" in txt) else "ok"
                rid = archive("etsy-close", ", ".join(targets)[:250], res, txt, txt, inp)
                self._json(200, {"out": txt, "verify": txt, "result": res, "archived": rid})

            elif self.path == "/abe/photos":
                f = os.path.basename(str(req.get("file", ""))); path = os.path.join(ABEDIR, f)
                if not f.startswith("PapaDuck_AbeBooks_") or not os.path.exists(path):
                    raise ValueError("no such AbeBooks file in %s" % ABEDIR)
                rep, allok, tot, ok = abe_photo_report(path)
                rid = archive("abe-photos", f, "ok" if allok else "warning", rep, rep, inp)
                self._json(200, {"verify": rep, "ok": allok, "total": tot, "alive": ok, "archived": rid})

            elif self.path == "/install":
                res, restart = install_from_downloads(req.get("files") or [])
                rid = archive("install", "", "ok", "\n".join("%s: %s" % r for r in res), inp=inp)
                self._json(200, {"results": res, "restart": restart, "archived": rid})
                if restart:
                    def _later():
                        while _busy: time.sleep(2)
                        restart_self()
                    threading.Thread(target=_later, daemon=True).start()
            else:
                self._json(404, {"error": "no such action"})
        except Exception as e:
            log("ERROR %s" % e); self._json(400, {"error": str(e)})

if __name__ == "__main__":
    os.makedirs(RUNS, exist_ok=True)
    print("Papa Duck Station helper v" + VERSION + "\n  page   : %s\n  ebay   : %s\n  abe    : %s\n  airtable archive: %s\n  Ctrl+C to stop."
          % (ORIGIN, "ok" if os.path.exists(EBAY) else "MISSING", "ok" if os.path.exists(ABE) else "MISSING",
             "configured" if at_token() else "NOT configured - use Settings in the app"))
    # v21: never run twice. A copy already answering (same or newer) means this one is a duplicate
    # launch (watchdog / restart-on-failure after a self-restart) - leave quietly.
    for attempt in range(40):
        rv = running_version()
        if rv is not None and rv >= int(VERSION):
            if attempt: log("START v%s - v%d already answering, this copy exits" % (VERSION, rv))
            sys.exit(0)
        try:
            HTTPServer.allow_reuse_address = (os.name != "nt")   # Windows reuse would let two copies share the port
            ThreadingHTTPServer.allow_reuse_address = (os.name != "nt")
            ThreadingHTTPServer.daemon_threads = True
            _server = ThreadingHTTPServer((HOST, PORT), H); break
        except OSError as e:
            if attempt == 39: log("START v%s - port %d still busy after 40 s: %s" % (VERSION, PORT, e)); sys.exit(4)
            time.sleep(1)
    log("START v" + VERSION)
    for line in undo_regressions(): print("  regression guard: " + line)
    threading.Thread(target=auto_install_loop, daemon=True).start()
    threading.Thread(target=amazon_loop, daemon=True).start()
    threading.Thread(target=fba_print_loop, daemon=True).start()      # v44: FBA stickers from the cloud, printed silently
    threading.Thread(target=cloud_status_loop, daemon=True).start()   # v42: the cloud's checks shown in the sales box
    threading.Thread(target=ebay_sales_loop, daemon=True).start()    # v37: eBay sales, every 15 minutes
    threading.Thread(target=etsy_sales_loop, daemon=True).start()   # v36: Etsy sales, every 30 minutes
    threading.Thread(target=abe_sales_loop, daemon=True).start()   # v35: AbeBooks sales, every 15 minutes     # v26: Amazon eligibility for Drafts, every 2 minutes
    print("  auto-install: ON - files you download install themselves within ~15 seconds")
    try:
        _server.serve_forever()
    except KeyboardInterrupt: log("STOP"); print("\nstopped.")
    while _restarting.is_set(): time.sleep(1)     # restart_self finishes the hand-off and exits
