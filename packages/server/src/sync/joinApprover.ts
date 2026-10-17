import {
  deriveSas,
  E2eOpenError,
  encodeEpochList,
  generateJoinCode,
  JOIN_NOTICE_ID,
  joinCodeHash,
  openJoinRequest,
  sealKeybox,
  toBase64Url,
  type JoinApproverState,
  type JoinRequestView,
  type MessageKey,
  type OsNoticeDto,
  type ServerEvent,
} from '@agent-hangar/shared';
import type { GetLanguage } from '../i18n/language.ts';
import { errorText, MessageError, msg, translatorOf } from '../i18n/message.ts';
import { CloudError, type HttpCloudClient } from './client.ts';
import type { Keyring } from './keyring.ts';
import type { RosterStore } from './roster.ts';

/**
 * 参加コードを発行した PC の側（設計書「参加（PC）」の手順 1、5、6）。
 *
 * 参加コードの平文はこの PC のメモリにだけ置く（Worker に送るのは SHA-256 だけ）。
 * アプリが落ちて作り直されると平文は消え、承認はできなくなる。
 * 新しい PC は承認を待ったまま、Worker の期限（5 分）で expired を受け取る。
 *
 * コードが生きている間だけ、JOIN_POLL_MS ごとに `GET /join-codes/mine` を問い合わせる。
 * リクエストを見たら参加コードで開き、確認コードを導き、そのリクエストにつき 1 回だけ onRequest を呼ぶ（右下の通知と OS の通知）。
 * 承認は、名簿に新しい PC を足し、世代鍵の全部の一覧を新しい PC の公開鍵に封じた keybox を置き、Worker に承認を伝える、の順に行う。
 * 箱を置く前と後に自分宛ての keybox を読み直し、解除で回った世代と重なっても新しい PC が新しい世代の鍵を受け取れるようにする。
 */

/** 発行した PC の問い合わせの間隔。コードの 5 分の間に最大 100 回である。 */
export const JOIN_POLL_MS = 3000;

/** 線の上の口のうち、参加の承認が使うもの。 */
export type JoinWire = Pick<HttpCloudClient, 'createJoinCode' | 'joinCodeMine' | 'approveJoinCode' | 'rejectJoinCode' | 'putKeyboxes'>;

/** 周期の差し替え口。試験は手で回す。 */
export type JoinTimers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

const realTimers: JoinTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type JoinApproverDeps = {
  wire: JoinWire;
  roster: Pick<RosterStore, 'update' | 'refreshKeyboxes'>;
  keyring: Keyring | Promise<Keyring>;
  language: GetLanguage;
  /** 承認の途中で keybox を読み直し、他の PC が配った世代鍵が増えたときに呼ぶ（飛ばした行と本文の取り直し）。 */
  onGained?: () => void;
  now?: () => number;
  timers?: JoinTimers;
  /** 状態が変わるたびに呼ぶ。 */
  onState?: (s: JoinApproverState) => void;
  /** 新しい参加リクエストを受信したときに、1 つのリクエストにつき 1 回だけ呼ぶ。 */
  onRequest?: (request: JoinRequestView, expiresAt: number) => void;
};

/** 承認や拒否を、そのときの状態ではできない（リクエストが無い、コードが無い）。経路は 409 にする。 */
export class JoinStateError extends MessageError {
  constructor(key: Extract<MessageKey, 'sync.join.noRequest' | 'sync.join.noCode'>) {
    super(msg(key));
    this.name = 'JoinStateError';
  }
}

type Live = { code: string; hash: string; expiresAt: number };
type Pending = { deviceId: string; sealed: string; pub: string; name: string; os: string; sas: string };

export class JoinApprover {
  private st: JoinApproverState = { kind: 'idle' };
  private live: Live | null = null;
  private pending: Pending | null = null;
  private timer: unknown = null;
  /** 発行、取り消し、承認、拒否、止めるたびに進める。古い問い合わせの答えを捨てるのに使う。 */
  private gen = 0;
  private inflight: Promise<void> = Promise.resolve();
  private readonly timers: JoinTimers;
  private readonly now: () => number;

  constructor(private readonly deps: JoinApproverDeps) {
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? Date.now;
    Promise.resolve(deps.keyring).catch(() => {});
  }

  state(): JoinApproverState {
    return structuredClone(this.st);
  }

  /**
   * 参加コードを発行する。前のコードがあれば捨てる（Worker も同じ PC の前のコードを expired にする）。
   * 発行の上限（429）や通信の失敗は投げ、状態は変えない。
   */
  async issue(): Promise<{ code: string; expiresAt: number }> {
    const code = generateJoinCode();
    const hash = await joinCodeHash(code);
    const created = await this.deps.wire.createJoinCode(hash);
    this.halt();
    this.live = { code, hash, expiresAt: created.expiresAt };
    this.set({ kind: 'open', code, expiresAt: created.expiresAt });
    this.schedule();
    return { code, expiresAt: created.expiresAt };
  }

  /**
   * 1 回だけ問い合わせる（周期の 1 回）。
   * 期限を過ぎていれば Worker に問い合わせずに expired にする。
   * 通信の失敗では状態を変えず、次の周期でまた問い合わせる。
   */
  private async tick(): Promise<void> {
    const cur = this.live;
    if (!cur) return;
    const gen = this.gen;
    if (this.now() >= cur.expiresAt) {
      this.expire();
      return;
    }
    let mine;
    try {
      mine = await this.deps.wire.joinCodeMine();
    } catch (e) {
      if (gen !== this.gen) return;
      console.warn('[join] could not check the join code', e instanceof Error ? e.constructor.name : typeof e);
      this.schedule();
      return;
    }
    if (gen !== this.gen) return;
    // 自分のいちばん新しいコードが別のもの（ほかの道で発行し直した）なら、このコードはもう使えない。
    if (!mine || mine.codeHash !== cur.hash || mine.status === 'expired') {
      this.expire();
      return;
    }
    if (mine.status === 'approved' || mine.status === 'rejected') {
      this.clear();
      this.set({ kind: 'idle' });
      return;
    }
    if (mine.status === 'requested' && mine.sealed && mine.deviceId) {
      const p = this.pending;
      if (!p || p.deviceId !== mine.deviceId || p.sealed !== mine.sealed) {
        try {
          await this.received(cur, mine.deviceId, mine.sealed, gen);
        } catch (e) {
          // 開けないリクエスト（received が failed にする）のほかの失敗は、コードが生きている間は次の周期で問い合わせ直す。
          console.error('[join] could not handle the join request', e instanceof Error ? e.constructor.name : typeof e);
        }
        if (gen !== this.gen || this.live !== cur) return;
      }
    }
    this.schedule();
  }

  /** リクエストを開き、確認コードを導いて requested にし、通知を 1 回出す。開けなければ拒否で閉じて failed にする。 */
  private async received(cur: Live, deviceId: string, sealed: string, gen: number): Promise<void> {
    let body;
    let sas;
    try {
      body = await openJoinRequest(cur.code, cur.hash, sealed);
      sas = await deriveSas(cur.code, body.pub);
    } catch (e) {
      if (!(e instanceof E2eOpenError) && !(e instanceof TypeError)) throw e;
      if (gen !== this.gen) return;
      this.clear();
      this.set({ kind: 'failed', message: translatorOf(this.deps.language)('sync.join.unreadable') });
      await this.deps.wire.rejectJoinCode(cur.hash).catch(() => {});
      return;
    }
    if (gen !== this.gen) return;
    this.pending = { deviceId, sealed, pub: body.pub, name: body.name, os: body.os, sas };
    const request: JoinRequestView = { name: body.name, os: body.os, sas };
    this.set({ kind: 'requested', code: cur.code, expiresAt: cur.expiresAt, request });
    this.deps.onRequest?.(structuredClone(request), cur.expiresAt);
  }

  /**
   * 承認する。名簿に新しい PC を足し、keybox を置き、Worker に承認を伝える。
   * リクエストが無ければ JoinStateError を投げる。
   * Worker が期限切れで断ったら（409）expired、ほかの失敗は failed にして、どちらも投げない。
   */
  async approve(): Promise<void> {
    const cur = this.live;
    const p = this.pending;
    if (this.st.kind !== 'requested' || !cur || !p) throw new JoinStateError('sync.join.noRequest');
    this.halt();
    this.set({ kind: 'approving' });
    const gen = this.gen;
    const job = (async () => {
      let added = false;
      try {
        const ring = await this.deps.keyring;
        // update は 409 のたびに当て直すので、同じ名簿には同じ結果を返すよう、時刻は先に決める。
        const joinedAt = this.now();
        // 名簿が新しい世代で封じ直してあれば、その鍵が無いと開けない。
        await this.refreshKeys();
        await this.deps.roster.update((r) => ({
          ...r,
          entries: [...r.entries.filter((e) => e.id !== p.deviceId), { id: p.deviceId, kind: 'pc', name: p.name, os: p.os, pub: p.pub, joinedAt }],
        }));
        added = true;
        // 他の PC が解除で世代を回していれば、その世代の鍵を先に受け取る（sync/rotate.ts）。
        // 回した PC が名簿を読んだのが足す前なら、その PC はこの新しい PC に箱を置かないからである。
        await this.refreshKeys();
        const placed = await this.placeBox(ring, p);
        // 置いている間に世代が回ったら、その世代の箱を置き直す。
        await this.refreshKeys();
        if (ring.current().epoch > placed) await this.placeBox(ring, p);
        await this.deps.wire.approveJoinCode(cur.hash, p.deviceId);
        if (gen === this.gen) this.set({ kind: 'done', name: p.name });
      } catch (e) {
        // 名簿に足した後で止まったら、足した項目を外す（新しい PC は端末トークンを受け取れず、参加しない）。
        // 外すのは同じ ID と公開鍵の項目だけで、外せなくても承認の結果は変えない。
        if (added) await this.undoEntry(p);
        if (gen !== this.gen) return;
        if (e instanceof CloudError && e.status === 409) {
          this.set({ kind: 'expired' });
          return;
        }
        console.warn('[join] could not approve the join request', e instanceof Error ? e.constructor.name : typeof e);
        this.set({ kind: 'failed', message: translatorOf(this.deps.language)('sync.join.failed', { detail: errorText(this.deps.language(), e) }) });
      }
    })();
    this.inflight = job;
    await job;
  }

  /** 自分宛ての keybox を読み直す。新しい世代の鍵が増えたら onGained を呼ぶ。 */
  private async refreshKeys(): Promise<void> {
    if (await this.deps.roster.refreshKeyboxes()) this.deps.onGained?.();
  }

  /**
   * 新しい PC 宛ての keybox を、今の世代で置く。置いた世代を返す。
   * 中身は今の世代までの世代鍵の一覧で、回しの途中でまだ配り終えていない世代（今の世代より先）の鍵は入れない。
   */
  private async placeBox(ring: Keyring, p: Pending): Promise<number> {
    const epoch = ring.current().epoch;
    const epochs = Object.fromEntries(Object.entries(ring.toConfigPatch().epochs).filter(([n]) => Number(n) <= epoch));
    const box = await sealKeybox(p.pub, { epoch, recipient: p.deviceId }, encodeEpochList({ epochs }));
    await this.deps.wire.putKeyboxes([{ epoch, recipient: p.deviceId, sealed: toBase64Url(box) }]);
    return epoch;
  }

  /** 承認の途中で足した名簿の項目を外す（できる範囲で）。失敗は英語のログだけにして投げない。 */
  private async undoEntry(p: Pending): Promise<void> {
    try {
      await this.deps.roster.update((r) => ({ ...r, entries: r.entries.filter((e) => !(e.id === p.deviceId && e.pub === p.pub)) }));
    } catch (e) {
      console.error('[join] could not remove the roster entry of an approval that failed', e instanceof Error ? e.constructor.name : typeof e);
    }
  }

  /**
   * 拒否する。コードが無ければ JoinStateError を投げる。
   * Worker が既に閉じていた（409）ときも idle に戻す。通信の失敗は投げ、状態は変えない。
   */
  async reject(): Promise<void> {
    const cur = this.live;
    if (!cur || (this.st.kind !== 'open' && this.st.kind !== 'requested')) throw new JoinStateError('sync.join.noCode');
    try {
      await this.deps.wire.rejectJoinCode(cur.hash);
    } catch (e) {
      if (!(e instanceof CloudError && e.status === 409)) throw e;
    }
    if (this.live !== cur) return;
    this.halt();
    this.set({ kind: 'idle' });
  }

  /**
   * 取り消す（画面の「閉じる」）。状態を idle に戻す。
   * 生きているコードがあれば、待たずに Worker で拒否として閉じる（新しい PC は rejected を受け取る）。
   */
  cancel(): void {
    const cur = this.live;
    this.halt();
    if (cur) this.inflight = this.deps.wire.rejectJoinCode(cur.hash).catch(() => {});
    if (this.st.kind !== 'idle') this.set({ kind: 'idle' });
  }

  /** 止める（サーバを閉じる、同期の部品を組み直す）。Worker には何も送らず、状態も変えない。 */
  stop(): void {
    this.halt();
  }

  /** 走っている問い合わせ、承認、取り消しの終わりを待つ（試験と、止める前の片付けに使う）。 */
  async settled(): Promise<void> {
    await this.inflight;
  }

  private schedule(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    if (!this.live) {
      this.timer = null;
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.inflight = this.tick().catch((e: unknown) => {
        console.error('[join] the join code check failed', e instanceof Error ? e.constructor.name : typeof e);
      });
    }, JOIN_POLL_MS);
  }

  /** 周期を止め、コードとリクエストを捨て、走っている問い合わせの答えを捨てる。 */
  private halt(): void {
    this.gen += 1;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.live = null;
    this.pending = null;
  }

  private expire(): void {
    this.clear();
    this.set({ kind: 'expired' });
  }

  private set(s: JoinApproverState): void {
    this.st = s;
    this.deps.onState?.(structuredClone(s));
  }
}

/** OS の名前（process.platform の値）を画面の語にする。知らない値はそのまま出す。 */
function osLabel(language: GetLanguage, os: string): string {
  const tr = translatorOf(language);
  if (os === 'darwin') return tr('common.os.darwin');
  if (os === 'win32') return tr('common.os.win32');
  if (os === 'linux') return tr('common.os.linux');
  return os;
}

/**
 * JoinApprover の知らせを画面と OS へ渡す。
 * 状態は変わるたびに `join.update` で配る（設定のクラウド同期の節が切り替わる）。
 * 新しいリクエストは 1 回だけ、`join.request`（右下の通知）と OS の通知（種類 join）にする。
 */
export function joinNotifier(o: {
  broadcast(ev: Extract<ServerEvent, { type: 'join.update' | 'join.request' }>): void;
  osNotices?: { push(n: Omit<OsNoticeDto, 'seq'>): void };
  language: GetLanguage;
}): Required<Pick<JoinApproverDeps, 'onState' | 'onRequest'>> {
  return {
    onState: (s) => o.broadcast({ type: 'join.update', join: s }),
    onRequest: (request, expiresAt) => {
      o.broadcast({ type: 'join.request', request, expiresAt });
      const tr = translatorOf(o.language);
      const sas = `${request.sas.slice(0, 3)} ${request.sas.slice(3)}`;
      o.osNotices?.push({ kind: 'join', sessionId: JOIN_NOTICE_ID, title: tr('sync.join.notifyTitle'), body: tr('sync.join.notifyBody', { name: request.name, os: osLabel(o.language, request.os), sas }), bare: false });
    },
  };
}
