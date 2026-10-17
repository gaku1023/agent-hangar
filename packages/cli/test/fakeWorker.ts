import { createHash, randomBytes } from 'node:crypto';
import {
  COMPAT_HEADER,
  COMPAT_VERSION,
  RECOVERY_RECIPIENT,
  type JoinCodeHello,
  type JoinStatusOut,
  type KeyboxIn,
  type RosterOut,
} from '@agent-hangar/shared';

/**
 * CLI の試験に使う、メモリの上の偽の Worker（互換の版 9）。
 * setup と参加が叩く口だけを持つ（/health、/bootstrap、/roster、/keyboxes、/join/*）。
 * 応答の形と状態の移り方は packages/cloud/src/join.ts と keys.ts に合わせる。
 */

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

type Code = { status: 'open' | 'requested' | 'approved' | 'rejected' | 'expired'; deviceId: string | null; sealed: string | null; expiresAt: number; usedAt: number | null };

export class FakeWorker {
  cloudId = 'cloud-test-1';
  /** wrangler secret put で入れた BOOTSTRAP_TOKEN_HASH。 */
  bootstrapHash: string | null = null;
  bootstrapUsed: string | null = null;
  /** 端末 ID から端末トークンのハッシュ。 */
  devices = new Map<string, { tokenHash: string; revoked: boolean }>();
  roster: RosterOut | null = null;
  /** `${受け手}:${世代}` から封じた keybox。 */
  keyboxes = new Map<string, { epoch: number; sealed: string }>();
  codes = new Map<string, Code>();
  /** /health をはじめに何回 530 で返すか（反映待ちの真似）。 */
  healthFails = 0;
  /** 受けた要求（メソッドとパス）。 */
  calls: string[] = [];
  /** 時計。試験で進める。 */
  now = (): number => Date.now();

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    this.calls.push(`${method} ${u.pathname}`);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    return this.handle(method, u, headers, body);
  }) as typeof fetch;

  /** 発行した PC の代わりに参加コードを置く。 */
  issue(codeHash: string, ttlMs = 5 * 60_000): void {
    this.codes.set(codeHash, { status: 'open', deviceId: null, sealed: null, expiresAt: this.now() + ttlMs, usedAt: null });
  }

  approve(codeHash: string): void {
    const c = this.codes.get(codeHash)!;
    c.status = 'approved';
  }

  reject(codeHash: string): void {
    const c = this.codes.get(codeHash)!;
    c.status = 'rejected';
    c.sealed = null;
  }

  /** 試験から keybox と名簿を直に置く（発行した PC の書き込みの代わり）。 */
  putBox(b: KeyboxIn): void {
    this.keyboxes.set(`${b.recipient}:${b.epoch}`, { epoch: b.epoch, sealed: b.sealed });
  }

  private json(v: unknown, status = 200): Response {
    return new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', [COMPAT_HEADER]: String(COMPAT_VERSION) } });
  }

  private who(headers: Headers): string | null {
    const m = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '');
    if (!m) return null;
    const h = sha(m[1]!);
    for (const [id, d] of this.devices) if (d.tokenHash === h && !d.revoked) return id;
    return null;
  }

  private handle(method: string, u: URL, headers: Headers, body: Record<string, unknown> | null): Response {
    const p = u.pathname;
    if (p === '/health') {
      if (this.healthFails-- > 0) return new Response('error code: 1042', { status: 530 });
      return this.json({ ok: true, version: 'test', compat: COMPAT_VERSION, cloudId: this.cloudId });
    }
    if (p === '/bootstrap' && method === 'POST') {
      const token = String(body?.token ?? '');
      const deviceId = String(body?.deviceId ?? '');
      const h = sha(token);
      if (!this.bootstrapHash || h !== this.bootstrapHash || this.bootstrapUsed === h || this.devices.has(deviceId)) return this.json({ error: 'unauthorized' }, 401);
      this.devices.set(deviceId, { tokenHash: h, revoked: false });
      this.bootstrapUsed = h;
      return this.json({ deviceId }, 201);
    }
    if (p === '/join/hello') {
      const hello: JoinCodeHello = { hostLabel: u.hostname, pcCount: [...this.devices.values()].filter((d) => !d.revoked).length };
      return this.json(hello);
    }
    if (p === '/join/requests' && method === 'POST') {
      const c = this.codes.get(String(body?.codeHash));
      const deviceId = String(body?.deviceId);
      if (!c || c.status !== 'open' || c.expiresAt <= this.now() || c.sealed !== null || this.devices.has(deviceId)) return this.json({ error: 'not found' }, 404);
      c.status = 'requested';
      c.deviceId = deviceId;
      c.sealed = String(body?.sealed);
      return this.json({ ok: true }, 202);
    }
    if (p === '/join/status') {
      const c = this.codes.get(u.searchParams.get('code') ?? '');
      const deviceId = u.searchParams.get('device');
      const out = (s: JoinStatusOut): Response => this.json(s);
      if (!c || c.deviceId !== deviceId) return out({ status: 'expired' });
      if (c.status === 'rejected') return out({ status: 'rejected' });
      if (c.status === 'requested') return c.expiresAt > this.now() ? out({ status: 'waiting' }) : out({ status: 'expired' });
      if (c.status !== 'approved') return out({ status: 'expired' });
      if (c.usedAt !== null) return out({ status: 'approved' });
      const token = randomBytes(32).toString('base64url');
      this.devices.set(deviceId!, { tokenHash: sha(token), revoked: false });
      c.usedAt = this.now();
      return out({ status: 'approved', deviceToken: token });
    }
    const me = this.who(headers);
    if (!me) return this.json({ error: 'unauthorized' }, 401);
    if (p === '/roster' && method === 'GET') return this.roster ? this.json(this.roster) : this.json({ error: 'not found' }, 404);
    if (p === '/roster' && method === 'PUT') {
      const cur = this.roster?.version ?? 0;
      if (body?.ifVersion !== cur) return this.json({ version: cur }, 409);
      this.roster = { version: cur + 1, sealed: String(body.sealed) };
      return this.json({ version: cur + 1 });
    }
    if (p === '/keyboxes' && method === 'GET') {
      const recipient = u.searchParams.get('recipient') ?? me;
      if (recipient !== me && recipient !== RECOVERY_RECIPIENT) return this.json({ error: 'forbidden' }, 403);
      const mine = [...this.keyboxes.entries()].filter(([k]) => k.startsWith(`${recipient}:`)).map(([, v]) => v);
      const newest = mine.sort((a, b) => b.epoch - a.epoch)[0];
      return this.json({ boxes: newest ? [newest] : [] });
    }
    if (p === '/keyboxes' && method === 'PUT') {
      const boxes = (body?.boxes ?? []) as KeyboxIn[];
      for (const b of boxes) this.putBox(b);
      return this.json({ written: boxes.length });
    }
    return this.json({ error: 'not found' }, 404);
  }
}
