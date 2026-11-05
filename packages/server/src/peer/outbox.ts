import {
  E2eOpenError, openPeerAnswer, openPeerResult, PEER_OUTBOX_LIMIT, PeerUnknownEpochError,
  type LiveSessionDto, type PeerKeyring, type PeerLaunchApi, type PeerLaunchRefusal, type PeerLaunchResult, type PeerRoute,
} from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { defaultLanguage, type GetLanguage } from '../i18n/language.ts';
import { turnRunning } from '../live/unreadHold.ts';
import { acceptsResultFrom, closeSpawn, recordSpawn } from '../sessions/spawns.ts';
import type { Timers } from '../sync/engine.ts';
import { expiredText, goneNotice, heldNotice, PEER_TEXT_MAX, refusalText, resultText, stopReasonText } from './text.ts';

/**
 * 呼ぶ側（T7）。別の PC へ置いた頼みの答えと結果を受け取り、呼び出し元の会話へ送り込む。
 *
 * 取り方は 2 つで、どちらも同じ道（sync）を通る。
 * - 呼び鈴（`{t:'peer', kind:'answer'|'result'}`）が鳴ったら、すぐ sync を呼ぶ。
 * - 呼び鈴が切れていても、tick が 30 秒ごとに sync と flush を回す。
 * 取得の口は PeerLaunchApi の形で受け取る。クラウドでも、SSH のトンネルでも、同じ記録（peer_outbox の received_seq）で二重に入れない。
 *
 * 流れは、答え（started なら結び付きを残す、断りと期限切れは文にする）、結果（開いて、受けてよいものだけを預かりに積む）、
 * 送り込み（flush）の順である。送り込みは、呼び出し元の状態で分ける（D14）。
 * - 消されている：入力にせず、利用者への通知だけを出す。
 * - ターンの最中（作業中、許可待ち）：預かる。止まったら渡す。notify_user の預かり（live/unreadHold.ts）と同じ見方である。
 * - 止められている（実行中の一覧に居ない）：預かったまま、未読と通知で 1 度だけ知らせる。再開して入力を待つようになったら渡す。
 * - 入力を待っている：預かっている分を 1 通にまとめて入れる。
 */

/** 取得の間隔。呼び鈴が無くても、頼みと結果はこの間隔で届く。 */
export const PEER_TICK_MS = 30_000;
/** 呼び出し元の取得で、起点から戻して読み直す長さ。読み直しは冪等で、時計の食い違いと取りこぼしを埋める。 */
export const PEER_OUTBOX_OVERLAP_MS = 5_000;
/** 1 回の取得で outbox を続けて読む回数の上限。 */
const OUTBOX_PAGES = 10;
/** 1 件の頼みで、1 回の取得に続けて読む結果の頁の上限。 */
const RESULT_PAGES = 50;
const CURSOR_KEY = 'peerOutboxSince';

export type PeerRequestState = 'requested' | 'started' | 'refused' | 'expired' | 'done';

/** 頼みの種類。launch は起動、send と stop は起こした会話への入力と停止（D16）。 */
export type PeerRequestOp = 'launch' | 'send' | 'stop';

export type PeerRequestRow = {
  op: PeerRequestOp;
  request_id: string; to_device: string; caller_session_id: string; state: PeerRequestState;
  child_session_id: string | null; title: string | null; reason: string | null;
  received_seq: number; seen_seq: number; created_at: number; updated_at: number;
};

/**
 * 頼みを置いたら、手元に記録する（T8 の create_session が、POST /launches の後に呼ぶ）。
 * 記録が無い頼みの答えと結果は読まない。同じ ID なら何もしない。
 */
export function recordPeerRequest(db: Db, o: { requestId: string; to: string; callerSessionId: string; now: number; op?: PeerRequestOp; childSessionId?: string }): void {
  // send と stop は、対象の会話（相手の PC で起こした子）の ID も残す。結果は最初の launch の request_id の下に届くので、ここには答えだけが来る。
  db.prepare('insert into peer_outbox (request_id, to_device, caller_session_id, op, child_session_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(request_id) do nothing')
    .run(o.requestId, o.to, o.callerSessionId, o.op ?? 'launch', o.childSessionId ?? null, o.now, o.now);
}

export function getPeerRequest(db: Db, requestId: string): PeerRequestRow | null {
  return (db.prepare('select * from peer_outbox where request_id = ?').get(requestId) as PeerRequestRow | undefined) ?? null;
}

export type PeerOutboxDeps = {
  db: Db;
  /** この PC の ID（頼んだ側）。 */
  deviceId: string;
  /** 取得の口。クラウドに入っていなければ null（取得は何もしない）。 */
  api: () => PeerLaunchApi | null;
  /** 封を開く鍵の束。読めなければ null。 */
  ring: () => PeerKeyring | null;
  /** いまの実行中の一覧（agent/liveHub.ts の LiveHub.current）。 */
  live: () => LiveSessionDto[];
  /**
   * 呼び出し元の会話へ、1 つの入力として貼り、Enter で確定する。届けられなければ false を返すか投げる（預かったまま次に渡す）。
   * 貼る前に noteTurnStart を残すのは、この口の側である（mcp/screenTools.ts の sendToSessionTool と同じ）。
   */
  inject: (sessionId: string, text: string) => Promise<boolean>;
  /**
   * 利用者への知らせ。sessionId があれば、その会話の未読と OS・スマホの通知（ターンの終わりを待たない ask）にする。
   * null なら、会話が消えているので、OS とスマホの通知だけにする。そのとき anchorSessionId は、通知が開く先（起こした相手の会話）で、無ければ null である。
   */
  notify: (sessionId: string | null, text: string, anchorSessionId?: string | null) => void;
  /** PC の名前。分からなければ null で、ID をそのまま出す。既定は devices 表。 */
  deviceName?: (deviceId: string) => string | null;
  language?: GetLanguage;
  now?: () => number;
  timers?: Timers;
  intervalMs?: number;
};

type Delivery = { id: number; request_id: string; seq: number; caller_session_id: string; text: string; notice_held: string; notice_gone: string; notified: number };

export class PeerOutbox {
  private readonly language: GetLanguage;
  private readonly now: () => number;
  private readonly timers: Timers;
  private chain: Promise<void> = Promise.resolve();
  private queuedSync: Promise<void> | null = null;

  constructor(private readonly deps: PeerOutboxDeps) {
    this.language = deps.language ?? defaultLanguage;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  }

  /** 30 秒ごとの取得を始める。戻り値を呼ぶと止める。 */
  start(): () => void {
    const h = this.timers.setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? PEER_TICK_MS);
    return () => { this.timers.clearInterval(h); };
  }

  /** 取得と送り込みを 1 回。どの道も投げない。 */
  async tick(): Promise<void> {
    await this.sync();
    await this.flush();
  }

  /**
   * 呼び鈴が鳴ったときと、tick から呼ぶ。答えと結果を取って預かりに積み、渡せるものを渡す。
   * 待っている取得があれば、それに相乗りする（続けて鳴っても 1 回分で済む）。投げない。
   */
  sync(): Promise<void> {
    if (this.queuedSync) return this.queuedSync;
    const p = this.serial(async () => {
      this.queuedSync = null;
      try { await this.syncOnce(); } catch (e) { console.error('[peer] could not read the outbox', e instanceof Error ? e.constructor.name : typeof e); }
      await this.flushOnce();
    });
    this.queuedSync = p;
    return p;
  }

  /** 預かっている入力を、呼び出し元の状態に合わせて渡す。実行中の一覧が変わったときにも呼ぶ。投げない。 */
  flush(): Promise<void> {
    return this.serial(() => this.flushOnce());
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---- 取得 ----

  private cursor(): number {
    const r = this.deps.db.prepare('select value from sync_state where key = ?').get(CURSOR_KEY) as { value: string } | undefined;
    const n = r ? Number(r.value) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private setCursor(n: number): void {
    this.deps.db.prepare('insert into sync_state (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(CURSOR_KEY, String(n));
  }

  private async syncOnce(): Promise<void> {
    const api = this.deps.api();
    const ring = this.deps.ring();
    if (!api || !ring) return;
    const db = this.deps.db;
    let since = Math.max(0, this.cursor() - PEER_OUTBOX_OVERLAP_MS);
    let next = this.cursor();
    let clean = true;
    for (let page = 0; page < OUTBOX_PAGES; page++) {
      const res = await api.outbox(since);
      for (const l of res.launches) {
        const row = getPeerRequest(db, l.id);
        if (!row) continue;
        if (l.resultSeq > row.seen_seq) db.prepare('update peer_outbox set seen_seq = ? where request_id = ?').run(l.resultSeq, l.id);
        if (row.state !== 'requested') continue;
        if (l.status === 'expired') this.refuse(row, 'expired', undefined, true);
        else if ((l.status === 'started' || l.status === 'failed') && l.sealedAnswer) {
          if (!(await this.takeAnswer(ring, row, l.sealedAnswer))) clean = false;
        }
      }
      const full = res.launches.length >= PEER_OUTBOX_LIMIT;
      next = full ? Math.max(next, res.launches[res.launches.length - 1]!.updatedAt) : Math.max(next, res.now);
      if (!full) break;
      since = next;
    }
    // 取りこぼしを残さないため、読めないものがあった回は起点を進めない（次の回で読み直す）。
    if (clean) this.setCursor(next);
    const rows = db.prepare("select * from peer_outbox where state = 'started' and seen_seq > received_seq").all() as PeerRequestRow[];
    for (const row of rows) await this.fetchResults(api, ring, row);
  }

  /** 答えを開いて、started なら結び付きを残し、断りなら文にする。世代の鍵が足りずに開けなければ false（起点を進めずに、あとで読み直す）。 */
  private async takeAnswer(ring: PeerKeyring, row: PeerRequestRow, sealed: string): Promise<boolean> {
    const db = this.deps.db;
    let ans;
    try {
      ans = await openPeerAnswer(ring, this.routeOf(row), sealed);
    } catch (e) {
      if (e instanceof PeerUnknownEpochError) return false;
      if (!(e instanceof E2eOpenError)) throw e;
      this.refuse(row, 'bad-payload');
      return true;
    }
    if (!ans.ok) {
      this.refuse(row, ans.reason, ans.detail);
      return true;
    }
    // send と stop の答えは、受け取られたというだけで、結び付きも預かりも作らない。
    if (row.op !== 'launch') {
      db.prepare("update peer_outbox set state = 'done', title = ?, updated_at = ? where request_id = ?").run(ans.title, this.now(), row.request_id);
      return true;
    }
    db.prepare("update peer_outbox set state = 'started', child_session_id = ?, title = ?, updated_at = ? where request_id = ?").run(ans.sessionId, ans.title, this.now(), row.request_id);
    // 呼び出し元がもう消えていれば、結び付きは作らない（相手の PC の側は、結果の行が受け取られないまま切れる）。
    if (this.callerState(row.caller_session_id) !== 'gone') {
      recordSpawn(db, this.deps.deviceId, ans.sessionId, row.caller_session_id, this.now(), { childDeviceId: row.to_device });
    }
    return true;
  }

  private refuse(row: PeerRequestRow, reason: PeerLaunchRefusal, detail?: string, expired = false): void {
    const lang = this.language();
    const device = this.nameOf(row.to_device);
    const text = expired ? expiredText(lang, { device }) : refusalText(lang, { device, reason, op: row.op, ...(detail ? { detail } : {}) });
    this.deps.db.prepare('update peer_outbox set state = ?, reason = ?, updated_at = ? where request_id = ?').run(expired ? 'expired' : 'refused', expired ? 'expired' : reason, this.now(), row.request_id);
    this.enqueue(row, 0, text, heldNotice(lang, { device, title: null }), text);
  }

  private async fetchResults(api: PeerLaunchApi, ring: PeerKeyring, row: PeerRequestRow): Promise<void> {
    const db = this.deps.db;
    let after = row.received_seq;
    for (let page = 0; page < RESULT_PAGES; page++) {
      const res = await api.results(row.request_id, after);
      for (const item of [...res.results].sort((x, y) => x.seq - y.seq)) {
        // 口が after を無視して古い行を返し直しても、受け取り済みの連番は入れない。
        if (item.seq <= after) continue;
        const cur = getPeerRequest(db, row.request_id)!;
        if (!(await this.takeResult(ring, cur, item.seq, item.sealed))) return;
        after = item.seq;
      }
      if (!res.more || res.results.length === 0) return;
    }
  }

  /**
   * 結果 1 件を開いて、受けてよければ預かりに積み、連番を進める。世代の鍵が足りずに開けなければ false（進めない）。
   * 開けない封、答えと違う会話の結果、結び付きが切れた後の結果は、捨てて連番だけ進める。
   */
  private async takeResult(ring: PeerKeyring, row: PeerRequestRow, seq: number, sealed: string): Promise<boolean> {
    const db = this.deps.db;
    let res: PeerLaunchResult;
    try {
      res = await openPeerResult(ring, this.routeOf(row), seq, sealed);
    } catch (e) {
      if (e instanceof PeerUnknownEpochError) return false;
      if (!(e instanceof E2eOpenError)) throw e;
      db.prepare('update peer_outbox set received_seq = ? where request_id = ?').run(seq, row.request_id);
      return true;
    }
    const child = row.child_session_id;
    // 呼び出し元が消されると、会話を消す側が結び付きも切る。それでも利用者へは、最初の報告だけ通知で知らせる（D14）。
    const gone = this.callerState(row.caller_session_id) === 'gone';
    const accept = row.state === 'started' && child !== null && res.sessionId === child && (gone || acceptsResultFrom(db, this.deps.deviceId, child, row.to_device));
    db.transaction(() => {
      if (accept && gone) db.prepare("update peer_outbox set state = 'done' where request_id = ?").run(row.request_id);
      if (accept) {
        const lang = this.language();
        const device = this.nameOf(row.to_device);
        this.enqueue(row, seq, resultText(lang, { device, result: res }), heldNotice(lang, { device, title: res.title }), goneNotice(lang, { device, title: res.title, reason: stopReasonText(lang, res.reason) }));
        // 「終わった」は 1 度だけ。結び付きを切り、以後の結果は acceptsResultFrom が断る。
        if (res.reason === 'ended') {
          closeSpawn(db, this.deps.deviceId, child, this.now());
          db.prepare("update peer_outbox set state = 'done' where request_id = ?").run(row.request_id);
        }
      }
      db.prepare('update peer_outbox set received_seq = max(received_seq, ?), updated_at = ? where request_id = ?').run(seq, this.now(), row.request_id);
    })();
    return true;
  }

  private routeOf(row: PeerRequestRow): PeerRoute {
    return { requestId: row.request_id, from: this.deps.deviceId, to: row.to_device };
  }

  private nameOf(deviceId: string): string {
    if (this.deps.deviceName) return this.deps.deviceName(deviceId) ?? deviceId;
    const r = this.deps.db.prepare('select name from devices where id = ?').get(deviceId) as { name: string | null } | undefined;
    return r?.name ?? deviceId;
  }

  private enqueue(row: PeerRequestRow, seq: number, text: string, held: string, gone: string): void {
    this.deps.db.prepare('insert into peer_deliveries (request_id, seq, caller_session_id, text, notice_held, notice_gone, created_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(request_id, seq) do nothing')
      .run(row.request_id, seq, row.caller_session_id, text, held, gone, this.now());
  }

  // ---- 送り込み ----

  /** 呼び出し元の会話の状態。gone は消されている、running はターンの途中、stopped は実行中の一覧に居ない、ready は入力を待っている。 */
  private callerState(sessionId: string): 'gone' | 'running' | 'stopped' | 'ready' {
    const r = this.deps.db.prepare('select provider, provider_session_id, deleted_at from sessions where id = ?').get(sessionId) as { provider: string; provider_session_id: string; deleted_at: number | null } | undefined;
    if (!r || r.deleted_at !== null) return 'gone';
    const l = this.deps.live().find((x) => x.sessionId === r.provider_session_id && (x.agent ?? 'claude-code') === r.provider);
    if (!l) return 'stopped';
    return turnRunning(l) ? 'running' : 'ready';
  }

  private async flushOnce(): Promise<void> {
    const db = this.deps.db;
    const open = db.prepare('select id, request_id, seq, caller_session_id, text, notice_held, notice_gone, notified from peer_deliveries where delivered_at is null order by id').all() as Delivery[];
    if (open.length === 0) return;
    const by = new Map<string, Delivery[]>();
    for (const d of open) by.set(d.caller_session_id, [...(by.get(d.caller_session_id) ?? []), d]);
    const done = db.prepare('update peer_deliveries set delivered_at = ? where id = ?');
    for (const [caller, rows] of by) {
      const state = this.callerState(caller);
      if (state === 'gone') {
        for (const d of rows) {
          done.run(this.now(), d.id);
          this.safeNotify(null, d.notice_gone, this.anchorOf(d.request_id));
        }
      } else if (state === 'stopped') {
        for (const d of rows) {
          if (d.notified) continue;
          db.prepare('update peer_deliveries set notified = 1 where id = ?').run(d.id);
          this.safeNotify(caller, d.notice_held);
        }
      } else if (state === 'ready') {
        // 1 通に収まる分だけまとめる。残りは次の入力待ちで渡す。
        const batch: Delivery[] = [];
        let len = 0;
        for (const d of rows) {
          if (batch.length > 0 && len + d.text.length + 2 > PEER_TEXT_MAX) break;
          batch.push(d);
          len += d.text.length + 2;
        }
        let ok = false;
        try { ok = await this.deps.inject(caller, batch.map((d) => d.text).join('\n\n')); } catch (e) { console.error('[peer] could not inject the report', e instanceof Error ? e.constructor.name : typeof e); }
        if (ok) for (const d of batch) done.run(this.now(), d.id);
      }
    }
  }

  /** 呼び出し元が消えているときの通知が開く先。頼みで起こした会話が、この PC にまだあれば、その ID。 */
  private anchorOf(requestId: string): string | null {
    const r = this.deps.db.prepare('select s.id from peer_outbox o join sessions s on s.id = o.child_session_id and s.deleted_at is null where o.request_id = ?').get(requestId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  private safeNotify(sessionId: string | null, text: string, anchor: string | null = null): void {
    try { this.deps.notify(sessionId, text, anchor); } catch (e) { console.error('[peer] could not notify', e instanceof Error ? e.constructor.name : typeof e); }
  }
}
