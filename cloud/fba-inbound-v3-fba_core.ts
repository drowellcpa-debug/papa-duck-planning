// Papa Duck — the small shared pieces fba-cloud needs (same Amazon + Airtable calls as sales-cloud's core.ts).
export type Keys = {
  airtable?: { token: string };
  amazon?: { client_id: string; client_secret: string; refresh_token: string; seller_id: string };
};
export type Ctx = {
  fetch: (url: string, init?: any) => Promise<{ status: number; text: () => Promise<string> }>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
};
const AMZ_HOST = "https://sellingpartnerapi-na.amazon.com";
const J = (b: string) => { try { return JSON.parse(b || "{}"); } catch { return {}; } };
async function call(ctx: Ctx, url: string, init: any = {}, tries = 3): Promise<{ status: number; body: string }> {
  for (let a = 0; ; a++) {
    const r = await ctx.fetch(url, init);
    const body = await r.text();
    if ((r.status === 429 || r.status >= 500) && a < tries - 1) { await ctx.sleep(2000 * (a + 1)); continue; }
    return { status: r.status, body };
  }
}
export class Amazon {
  private tok = "";
  constructor(private ctx: Ctx, private k: NonNullable<Keys["amazon"]>) {}
  async token() {
    if (this.tok) return this.tok;
    const r = await call(this.ctx, "https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.k.refresh_token, client_id: this.k.client_id, client_secret: this.k.client_secret }).toString() });
    const j = J(r.body);
    if (!j.access_token) throw new Error(`Amazon login failed (${r.status}): ${r.body.slice(0, 160)}`);
    return (this.tok = j.access_token);
  }
  async api(method: string, path: string, params: Record<string, string>, body?: unknown) {
    const tok = await this.token();
    const qs = new URLSearchParams(params).toString();
    const r = await call(this.ctx, AMZ_HOST + path + (qs ? "?" + qs : ""), { method, body: body ? JSON.stringify(body) : undefined,
      headers: { "x-amz-access-token": tok, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "PapaDuckFBA/1 (Language=TypeScript)" } }, 5);
    return { status: r.status, j: J(r.body), raw: r.body };
  }
}
