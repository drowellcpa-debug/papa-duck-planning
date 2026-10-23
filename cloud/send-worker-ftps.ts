// Minimal explicit-FTPS client for Deno (AUTH TLS, PROT P, PASV). Papa Duck 2026-10-15.
const enc = new TextEncoder(), dec = new TextDecoder();
export class FTPS {
  ctl!: Deno.TlsConn; host: string; buf = ""; log: string[] = [];
  constructor(host: string) { this.host = host; }
  private async readReply(ms = 30000): Promise<{ code: number; text: string }> {
    const chunk = new Uint8Array(8192); const t0 = Date.now();
    for (;;) {
      const m = this.buf.match(/(^|\n)(\d{3}) [^\n]*\r?\n/);
      if (m) { const end = (m.index ?? 0) + m[0].length; const text = this.buf.slice(0, end).trim(); this.buf = this.buf.slice(end); return { code: +m[2], text }; }
      if (Date.now() - t0 > ms) throw new Error("FTP reply timeout");
      const n = await (this.ctl as Deno.Conn).read(chunk);
      if (n === null) throw new Error("FTP control connection closed");
      this.buf += dec.decode(chunk.subarray(0, n));
    }
  }
  async cmd(c: string, ok: number[] = [], ms = 30000) {
    await this.ctl.write(enc.encode(c + "\r\n"));
    const r = await this.readReply(ms);
    this.log.push((c.startsWith("PASS") ? "PASS ****" : c) + " -> " + r.text.split("\n").pop());
    if (ok.length && !ok.includes(r.code)) throw new Error(`${c.startsWith("PASS") ? "PASS" : c} failed: ${r.text}`);
    return r;
  }
  async connect(user: string, pass: string) {
    const raw = await Deno.connect({ hostname: this.host, port: 21 });
    const chunk = new Uint8Array(4096); let b = "";
    while (!/(^|\n)\d{3} /.test(b)) { const n = await raw.read(chunk); if (n === null) throw new Error("closed"); b += dec.decode(chunk.subarray(0, n)); }
    await raw.write(enc.encode("AUTH TLS\r\n"));
    b = ""; while (!/(^|\n)\d{3} [^\n]*\n/.test(b)) { const n = await raw.read(chunk); if (n === null) throw new Error("closed"); b += dec.decode(chunk.subarray(0, n)); }
    if (!b.startsWith("234")) throw new Error("AUTH TLS refused: " + b);
    this.ctl = await Deno.startTls(raw, { hostname: this.host });
    await this.cmd("USER " + user, [331, 230]);
    await this.cmd("PASS " + pass, [230]);
    await this.cmd("PBSZ 0", [200]);
    await this.cmd("PROT P", [200]);
    await this.cmd("TYPE I", [200]);
  }
  private async pasv(): Promise<Deno.TlsConn> {
    const r = await this.cmd("PASV", [227]);
    const m = r.text.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/); if (!m) throw new Error("bad PASV " + r.text);
    const port = (+m[5]) * 256 + (+m[6]);
    const ip = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
    const host = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip) ? this.host : ip;
    const raw = await Deno.connect({ hostname: host, port });
    return raw as unknown as Deno.TlsConn;
  }
  async stor(name: string, data: Uint8Array) {
    const raw = await this.pasv();
    await this.ctl.write(enc.encode("STOR " + name + "\r\n"));
    const pre = await this.readReply();
    if (![125, 150].includes(pre.code)) { try { (raw as any).close(); } catch {} throw new Error("STOR " + name + ": " + pre.text); }
    const tls = await Deno.startTls(raw as unknown as Deno.Conn, { hostname: this.host });
    let off = 0; while (off < data.length) off += await tls.write(data.subarray(off, off + 65536));
    try { await tls.closeWrite(); } catch {} try { tls.close(); } catch {}
    const fin = await this.readReply(120000);
    this.log.push(`STOR ${name} ${data.length}B -> ${fin.text}`);
    if (fin.code !== 226 && fin.code !== 250) throw new Error("STOR " + name + " not confirmed: " + fin.text);
  }
  async list(): Promise<string> {
    const raw = await this.pasv();
    await this.ctl.write(enc.encode("NLST\r\n"));
    const pre = await this.readReply(); this.log.push("NLST -> " + pre.text);
    const tls = await Deno.startTls(raw as unknown as Deno.Conn, { hostname: this.host });
    let out = ""; const chunk = new Uint8Array(8192);
    if ([125, 150].includes(pre.code)) { for (;;) { let n: number | null = null; try { n = await tls.read(chunk); } catch { break; } if (n === null) break; out += dec.decode(chunk.subarray(0, n)); } }
    try { tls.close(); } catch {}
    const fin = await this.readReply(); this.log.push("NLST done -> " + fin.text);
    return out;
  }
  async quit() { try { await this.cmd("QUIT"); } catch {} try { this.ctl.close(); } catch {} }
}
