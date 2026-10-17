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
 * setup と参加が叩く口だけを持つ（/health、/bootstrap、/roster、/keyboxes、/join/*、発行した PC の /join-codes/*）。
 * サーバの試験（packages/server/src/sync/joinApprover.test.ts）も、発行した PC と新しい PC を通すのに使う。
 * 応答の形と状態の移り方は packages/cloud/src/join.ts と keys.ts に合わせる。
 */

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

type Code = {
  status: 'open' | 'requested' | 'approved' | 'rejected' | 'expired';
  deviceId: string | null;
  sealed: string | null;
  expiresAt: number;
  usedAt: number | null;
  /** 発行した PC（/join-codes で発行したときだけ）。issue で直に置いたコードは null。 */
  createdBy?: string | null;
  /** 発行の順。mine がいちばん新しいものを選ぶのに使う。 */
  order?: number;
};

const TTL_MS = 5 * 60_000;

export class FakeWorker {
  cloudId = 'cloud-test-1';
  /** wrangler secret put で入れた BOOTSTRAP_TOKEN_HASH。 */
  bootstrapHash: string | null = null;
  bootstrapUsed: string | null = null;
  /**
   * recovery 宛ての keybox を読む道を閉じた端末トークンのハッシュ（meta の recovery_done）。
   * bootstrap で入った端末が名簿か keybox を書くと閉じる（packages/cloud/src/keys.ts と同じ）。
   */
  recoveryDone: string | null = null;
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
  private issued = 0;

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
      // 解除済みの同じ ID は通す（再参加）。解除されていない同じ ID は断る。
      if (!c || c.status !== 'open' || c.expiresAt <= this.now() || c.sealed !== null || this.devices.get(deviceId)?.revoked === false) return this.json({ error: 'not found' }, 404);
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
      if (c.status === 'requested') {
        if (c.expiresAt > this.now()) return out({ status: 'waiting' });
        c.status = 'expired';
        c.sealed = null;
        return out({ status: 'expired' });
      }
      if (c.status !== 'approved') return out({ status: 'expired' });
      if (c.usedAt !== null) return out({ status: 'approved' });
      if (this.now() >= c.expiresAt + TTL_MS) return out({ status: 'expired' });
      if (this.devices.get(deviceId!)?.revoked === false) {
        c.status = 'rejected';
        return out({ status: 'rejected' });
      }
      const token = randomBytes(32).toString('base64url');
      this.devices.set(deviceId!, { tokenHash: sha(token), revoked: false });
      c.usedAt = this.now();
      return out({ status: 'approved', deviceToken: token });
    }
    const me = this.who(headers);
    if (!me) return this.json({ error: 'unauthorized' }, 401);
    const myHash = this.devices.get(me)!.tokenHash;
    const closeRecovery = (): void => {
      if (this.bootstrapUsed === myHash) this.recoveryDone = myHash;
    };
    if (p === '/roster' && method === 'GET') return this.roster ? this.json(this.roster) : this.json({ error: 'not found' }, 404);
    if (p === '/roster' && method === 'PUT') {
      const cur = this.roster?.version ?? 0;
      if (body?.ifVersion !== cur) return this.json({ version: cur }, 409);
      this.roster = { version: cur + 1, sealed: String(body.sealed) };
      closeRecovery();
      return this.json({ version: cur + 1 });
    }
    if (p === '/keyboxes' && method === 'GET') {
      const recipient = u.searchParams.get('recipient') ?? me;
      if (recipient !== me && recipient !== RECOVERY_RECIPIENT) return this.json({ error: 'forbidden' }, 403);
      // recovery 宛ては、bootstrap で入ったばかりで、まだ名簿も keybox も書いていない端末だけが読める。
      if (recipient === RECOVERY_RECIPIENT && (this.bootstrapUsed !== myHash || this.recoveryDone === myHash)) return this.json({ error: 'forbidden' }, 403);
      const mine = [...this.keyboxes.entries()].filter(([k]) => k.startsWith(`${recipient}:`)).map(([, v]) => v);
      const newest = mine.sort((a, b) => b.epoch - a.epoch)[0];
      return this.json({ boxes: newest ? [newest] : [] });
    }
    if (p === '/keyboxes' && method === 'PUT') {
      const boxes = (body?.boxes ?? []) as KeyboxIn[];
      // 受け手は解除されていない PC か recovery か、自分のコードにリクエストを置いた PC（packages/cloud/src/keys.ts と同じ）。
      const now = this.now();
      const pending = (id: string): boolean =>
        [...this.codes.values()].some((c) => c.createdBy === me && c.deviceId === id && ((c.status === 'requested' && c.expiresAt > now) || (c.status === 'approved' && c.usedAt === null && c.expiresAt + TTL_MS > now)));
      if (!boxes.every((b) => b.recipient === RECOVERY_RECIPIENT || this.devices.get(b.recipient)?.revoked === false || pending(b.recipient))) return this.json({ error: 'unknown recipient' }, 400);
      for (const b of boxes) this.putBox(b);
      closeRecovery();
      return this.json({ written: boxes.length });
    }
    if (p === '/join-codes' && method === 'POST') {
      const codeHash = String(body?.codeHash ?? '');
      if (this.codes.has(codeHash)) return this.json({ error: 'conflict' }, 409);
      for (const c of this.codes.values()) {
        if (c.createdBy === me && (c.status === 'open' || c.status === 'requested')) {
          c.status = 'expired';
          c.sealed = null;
        }
      }
      const expiresAt = this.now() + TTL_MS;
      this.codes.set(codeHash, { status: 'open', deviceId: null, sealed: null, expiresAt, usedAt: null, createdBy: me, order: ++this.issued });
      return this.json({ codeHash, expiresAt }, 201);
    }
    if (p === '/join-codes/mine' && method === 'GET') {
      const mine = [...this.codes.entries()].filter(([, c]) => c.createdBy === me).sort((a, b) => (b[1].order ?? 0) - (a[1].order ?? 0))[0];
      if (!mine) return this.json({ error: 'not found' }, 404);
      const [codeHash, c] = mine;
      if ((c.status === 'open' || c.status === 'requested') && c.expiresAt <= this.now()) {
        c.status = 'expired';
        c.sealed = null;
      }
      return this.json({ codeHash, status: c.status, sealed: c.status === 'requested' ? c.sealed : null, deviceId: c.deviceId });
    }
    const m = /^\/join-codes\/([0-9a-f]{64})\/(approve|reject)$/.exec(p);
    if (m && method === 'POST') {
      const c = this.codes.get(m[1]!);
      if (!c) return this.json({ error: 'not found' }, 404);
      if (c.createdBy !== me) return this.json({ error: 'forbidden' }, 403);
      const live = c.expiresAt > this.now();
      const ok = m[2] === 'approve' ? live && c.status === 'requested' && c.deviceId === body?.deviceId : live && (c.status === 'open' || c.status === 'requested');
      if (!ok) {
        if (!live && (c.status === 'open' || c.status === 'requested')) c.status = 'expired';
        c.sealed = c.status === 'requested' ? c.sealed : null;
        return this.json({ error: 'conflict' }, 409);
      }
      c.status = m[2] === 'approve' ? 'approved' : 'rejected';
      c.sealed = null;
      return this.json({ ok: true });
    }
    return this.json({ error: 'not found' }, 404);
  }
}
