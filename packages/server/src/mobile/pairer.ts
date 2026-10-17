import {
  fromBase64UrlLen,
  openPhoneJoinRequest,
  PHONE_KEY_LEN,
  phoneTicketHash,
  sealPhoneKeybox,
  toBase64Url,
  type KeyboxesPutOut,
  type KeyboxIn,
  type MobilePairingRequest,
  type MobilePairingsMine,
  type PhoneJoinBody,
  type RosterEntry,
} from '@agent-hangar/shared';
import { CloudError, type CloudClient } from '../sync/client.ts';
import type { PhoneKeySource } from '../sync/phoneKeys.ts';
import type { RosterStore } from '../sync/roster.ts';

/**
 * スマホ向けの部品が同期から引くもの（boot/sync.ts の mobileLink）。
 * client は今の同期の client、url は Worker の URL（QR に入れる）、phoneKeys はスマホ用の鍵 M の引き口、pairer はスマホの接続の PC 側である。
 * cloud.json を後から拾って組み直すと、別のものを返す。鍵そのものは含まず、ログにも画面にも出さない。
 */
export type MobileLink = { client: CloudClient; url: string; phoneKeys: PhoneKeySource; pairer: Pick<PhonePairer, 'watch' | 'pairedFor'> };

/** QR を出している間に、接続してきたスマホの参加リクエストを問い合わせる間隔。券は 5 分なので 1 枚で最大 100 回。 */
export const PAIR_POLL_MS = 3_000;
/**
 * 発行した券を手元に覚えておく長さ（期限から）。
 * スマホは keybox を 60 秒待って届かなければ「もう一度待つ」を出す。その後に PC で QR を出し直したとき、前の券の参加リクエストも開けるようにする。
 */
export const PAIR_TICKET_KEEP_MS = 60 * 60_000;
/** 手元に覚える券の数の上限。券は 1 台の PC から 10 分に 5 枚までなので、ふつうは数枚である。 */
export const PAIR_TICKETS_MAX = 20;
/**
 * 扱いが失敗した参加リクエストを、問い合わせごとに試し直す回数。
 * これを超えたら PAIR_RETRY_MS おきにだけ試す（1 回の試しごとに GET /roster を読むので、失敗が続くと名簿の読みが 3 秒おきに増えるため）。
 */
export const PAIR_RETRIES_EACH_POLL = 3;
export const PAIR_RETRY_MS = 30_000;
/** 名簿に書くスマホの名前の字数の上限。 */
export const PHONE_NAME_MAX = 64;

/** スマホの接続が使う線の口（互換の版 9）。 */
export type PairerWire = {
  getPairingsMine(): Promise<MobilePairingsMine>;
  putPhoneKeyboxes(boxes: KeyboxIn[]): Promise<KeyboxesPutOut>;
};

export type PairerTimers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

const realTimers: PairerTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type PhonePairerDeps = {
  wire: PairerWire;
  roster: Pick<RosterStore, 'read' | 'update' | 'invalidate'>;
  timers?: PairerTimers;
  now?: () => number;
  /** スマホを接続し終えた（名簿に足し、keybox を置いた）。投げても問い合わせは続ける。 */
  onPaired?: (phone: { id: string; name: string }) => void;
  /** 名簿に phoneKey が無いときに作る M[1]。既定は 32 バイトの乱数。 */
  newPhoneKey?: () => Uint8Array;
};

type Ticket = { code: string; hash: string; keepUntil: number };

/** 名前から制御文字を除き、前後の空白を落とし、PHONE_NAME_MAX 字で切る。空になったら null。 */
function cleanName(s: string): string | null {
  // eslint-disable-next-line no-control-regex
  const t = [...s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()].slice(0, PHONE_NAME_MAX).join('').trim();
  return t === '' ? null : t;
}

const kindOf = (e: unknown): string => {
  const status = (e as { status?: unknown } | null)?.status;
  return `${e instanceof Error ? e.constructor.name : typeof e}${typeof status === 'number' ? ` ${status}` : ''}`;
};

/**
 * スマホの接続の PC 側（互換の版 9）。
 *
 * QR を出すたびに watch で券を覚え、券の期限まで PAIR_POLL_MS ごとに `GET /m/pairings/mine` を問い合わせる。
 * 期限の後にも 1 回だけ問い合わせる（期限の直前に接続したスマホを拾う）。端末の一覧（GET /devices）は読まない。
 * QR を出し直したときは、覚えている前の券の参加リクエストも同じ問い合わせで開く（スマホの「もう一度待つ」のため）。
 *
 * 1 件の扱いの順は、参加リクエストを券で開く、名簿にスマホを足す（kind 'phone'）、
 * 名簿に phoneKey が無ければ M[1] を作って同じ書き換えで名簿に入れる、M をスマホの公開鍵に封じて `PUT /phone-keyboxes` に置く、である。
 * 名簿は扱うたびに Worker から読み直す（手元の写しが古いと、他の PC が回す前の世代の M を新しいスマホに封じうる）。
 * keybox を置くと Worker は参加リクエストを消すので、名簿を先に書く（落ちても次の問い合わせでやり直せる）。
 * `PUT /phone-keyboxes` が 400 の unknown recipient（接続の直後に解除されたスマホ）なら、その券を捨て、名簿に足した行も外す。
 * keybox を置き終えたスマホは、watch が返した券の印で pairedFor から引ける（設定の画面が QR を出している間に見る軽い口）。
 * 開けないリクエスト（券か ID が違う、壊れている）は、その組を覚えて二度と試さない。
 * どの失敗も投げない（ログは英語で種類だけ）。通信の失敗は次の問い合わせでやり直す。
 * 続けて PAIR_RETRIES_EACH_POLL 回失敗した参加リクエストは、PAIR_RETRY_MS おきにだけ試す。
 * 問い合わせは 1 本ずつ順に走らせる。
 */
export class PhonePairer {
  private readonly tickets = new Map<string, Ticket>();
  private readonly broken = new Set<string>();
  /** 扱いが失敗した参加リクエスト（券の印と ID の組）の、続けて失敗した回数と、次に試してよい時刻。 */
  private readonly failing = new Map<string, { n: number; next: number }>();
  /** keybox を置き終えた券の印から、接続したスマホへ。PAIR_TICKETS_MAX 枚まで覚える。 */
  private readonly done = new Map<string, { id: string; name: string }>();
  private readonly timers: PairerTimers;
  private readonly now: () => number;
  private pollUntil = 0;
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: PhonePairerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? Date.now;
  }

  /**
   * QR を出した。券を覚え、期限まで問い合わせる。券の平文はメモリにだけ置き、ログに出さない。
   * 返すのは券の印（券のハッシュ。Worker の D1 にもある値で、券の平文ではない）で、pairedFor に渡す。
   */
  async watch(ticket: { code: string; expiresAt: number }): Promise<string> {
    const hash = await phoneTicketHash(ticket.code);
    if (this.stopped) return hash;
    const now = this.now();
    for (const [h, t] of this.tickets) if (t.keepUntil < now) this.tickets.delete(h);
    this.tickets.delete(hash);
    this.tickets.set(hash, { code: ticket.code, hash, keepUntil: Math.max(ticket.expiresAt, now) + PAIR_TICKET_KEEP_MS });
    while (this.tickets.size > PAIR_TICKETS_MAX) this.tickets.delete(this.tickets.keys().next().value!);
    this.pollUntil = Math.max(this.pollUntil, ticket.expiresAt);
    this.schedule();
    return hash;
  }

  /** その券で接続し、keybox を置き終えたスマホ。まだなら（知らない券も）null。Worker には問い合わせない。 */
  pairedFor(pairId: string): { id: string; name: string } | null {
    const p = this.done.get(pairId);
    return p ? { ...p } : null;
  }

  /** 1 回だけ問い合わせて、届いた参加リクエストを扱う。走っている問い合わせの後に並ぶ。投げない。 */
  pollOnce(): Promise<void> {
    const run = this.chain.then(() => this.tick());
    this.chain = run.catch(() => undefined);
    return this.chain;
  }

  /** 走っている問い合わせの終わり。 */
  settled(): Promise<void> {
    return this.chain;
  }

  /** 以後は問い合わせない。覚えた券を捨てる。 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.tickets.clear();
  }

  private schedule(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.pollOnce().then(() => {
        if (this.now() <= this.pollUntil) this.schedule();
      });
    }, PAIR_POLL_MS);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tickets.size === 0) return;
    let mine: MobilePairingsMine;
    try {
      mine = await this.deps.wire.getPairingsMine();
    } catch (e) {
      console.error('[mobile] could not read the phone pairing requests', kindOf(e));
      return;
    }
    const now = this.now();
    for (const k of this.failing.keys()) if (!this.tickets.has(k.slice(0, k.indexOf(':')))) this.failing.delete(k);
    for (const p of mine.pairings) {
      const t = this.tickets.get(p.codeHash);
      const key = `${p.codeHash}:${p.deviceId}`;
      if (!t || this.broken.has(key) || this.stopped) continue;
      const f = this.failing.get(key);
      if (f && now < f.next) continue;
      try {
        await this.pair(t, p);
        this.failing.delete(key);
      } catch (e) {
        const n = (f?.n ?? 0) + 1;
        this.failing.set(key, { n, next: n >= PAIR_RETRIES_EACH_POLL ? now + PAIR_RETRY_MS : 0 });
        console.error('[mobile] could not finish connecting a phone; will retry', kindOf(e));
      }
    }
  }

  private async pair(t: Ticket, p: MobilePairingRequest): Promise<void> {
    let body: PhoneJoinBody;
    try {
      body = await openPhoneJoinRequest(t.code, p.deviceId, p.sealed);
    } catch {
      this.broken.add(`${p.codeHash}:${p.deviceId}`);
      console.warn('[mobile] a phone pairing request could not be opened with its ticket');
      return;
    }
    const name = cleanName(body.name) ?? p.deviceId;
    const entry: RosterEntry = { id: p.deviceId, kind: 'phone', name, os: '', pub: body.pub, joinedAt: p.joinedAt };
    this.deps.roster.invalidate();
    const base = await this.deps.roster.read();
    // 名簿の無いクラウド（setup の途中）では、リカバリーキーの公開鍵の無い名簿を作ってしまうので書かない。
    if (base.version === 0) {
      console.warn('[mobile] the roster does not exist yet; a phone cannot be connected');
      return;
    }
    const same = base.roster.entries.some((e) => e.id === entry.id && e.kind === 'phone' && e.pub === entry.pub && e.name === entry.name && e.joinedAt === entry.joinedAt);
    // same のときは名簿を書かずに、読み直した名簿の M を置く。
    // 読んでから置くまでの間に他の PC が M を回すと、1 世代前の M を置きうる。
    // それでも害は無い。回した PC は名簿にいるこのスマホにも新しい世代を置き、Worker は世代ごとに keybox を持ち、スマホはいちばん新しい世代を読むからである。
    let phoneKey = base.roster.phoneKey;
    if (!same || !phoneKey) {
      // fn は当て直しのたびに呼ばれるので、M[1] の候補は外で 1 回だけ作る。
      const fresh = { epoch: 1, key: toBase64Url(this.deps.newPhoneKey?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(PHONE_KEY_LEN))) };
      const done = await this.deps.roster.update((r) => ({
        ...r,
        entries: [...r.entries.filter((e) => e.id !== entry.id), entry],
        phoneKey: r.phoneKey ?? fresh,
      }));
      phoneKey = done.roster.phoneKey;
    }
    if (!phoneKey) return;
    const sealed = await sealPhoneKeybox(body.pub, p.deviceId, phoneKey.epoch, fromBase64UrlLen(phoneKey.key, PHONE_KEY_LEN, 'phone key'));
    try {
      await this.deps.wire.putPhoneKeyboxes([{ epoch: phoneKey.epoch, recipient: p.deviceId, sealed: toBase64Url(sealed) }]);
    } catch (e) {
      if (e instanceof CloudError && e.status === 400 && e.message.includes('unknown recipient')) {
        this.tickets.delete(t.hash);
        console.warn('[mobile] the phone was removed before its key could be placed; dropped the pairing');
        // 名簿に足した行も外す。このスマホは M を受け取っていないので、M は回さない。
        await this.deps.roster.update((r) => ({ ...r, entries: r.entries.filter((x) => !(x.id === entry.id && x.kind === 'phone')) }));
        return;
      }
      throw e;
    }
    this.tickets.delete(t.hash);
    this.done.delete(t.hash);
    this.done.set(t.hash, { id: p.deviceId, name });
    while (this.done.size > PAIR_TICKETS_MAX) this.done.delete(this.done.keys().next().value!);
    try {
      this.deps.onPaired?.({ id: p.deviceId, name });
    } catch (e) {
      console.error('[mobile] a paired listener failed', kindOf(e));
    }
  }
}
