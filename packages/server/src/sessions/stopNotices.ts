import { limitKindText, limitReset, newId, permissionNoticeText, quietLive, resetAtText, stopReasonOf, type LimitKind, type LiveSessionDto, type OsNoticeDto, type OsNoticeFeedDto, type SessionDto, type Translate } from '@agent-hangar/shared';
import { touchRow } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { getSession } from '../db/queries.ts';
import type { GetLanguage } from '../i18n/language.ts';
import { translatorOf } from '../i18n/message.ts';

/**
 * デスクトップ通知のきっかけをサーバに置く（2026-10-12、0.5.0）。
 *
 * これまでは頁（UI の mediator/live.ts の liveStep）が入力待ちの出入りを見て、殻の notify_waiting を呼んでいた。
 * 0.3.0-rc.4 の VM の確かめで、Hangar を別のアプリの裏に置いたまま問いを約 7 秒おきに出すと、4 分のあいだ頁が入力待ちの出入りに反応せず、通知が 3 回出なかった。
 * 前に出すと追いついたので、背面の WebView の JS が止まっていたとみる（macOS の backgroundThrottling を throttle にしても、窓が隠れると WebKit は頁を止めうる）。
 * そこで、通知にする出来事はサーバが決めて並べ（OsNoticeFeed）、殻が `GET /api/notify/feed` で読みに来て OS へ渡す。
 * サーバも殻も背面で止まらないので、頁が止まっていても、入力待ちになったら通知が 1 回出る。
 * 頁は、デスクトップでは入力待ちの通知を呼ばない（呼ぶと 2 回出る）。ブラウザでは今までどおり頁が出す。
 */

/** 並べておく件数の上限。殻は 1 秒もかけずに読み終えるので、少しあれば足りる。 */
const FEED_MAX = 100;

/** 通知の並び。サーバの起動ごとに boot を変える。 */
export class OsNoticeFeed {
  readonly boot = newId();
  private seq = 0;
  private items: OsNoticeDto[] = [];
  private waiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly max = FEED_MAX) {}

  /** 待っている読み手を全部返す。サーバを閉じるときに呼ぶ。開いたままの要求が、待ち受けを閉じるのを遅らせないためである。 */
  close(): void {
    this.closed = true;
    for (const w of [...this.waiters]) w();
  }

  push(n: Omit<OsNoticeDto, 'seq'>): void {
    this.seq += 1;
    this.items.push({ ...n, seq: this.seq });
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    for (const w of [...this.waiters]) w();
  }

  /**
   * after より後の通知。boot が違う（サーバが起こし直された）か、after が今の番号の外なら、今の番号だけを返す。
   * 殻は返った seq を覚えて、次からその続きを読む。起動の前に並んだものは出さない。
   */
  read(after: number, boot: string | null): OsNoticeFeedDto {
    if (boot !== this.boot || after < 0 || after > this.seq) return { boot: this.boot, seq: this.seq, items: [] };
    return { boot: this.boot, seq: this.seq, items: this.items.filter((i) => i.seq > after) };
  }

  /** read と同じだが、続きがまだ無ければ、届くか ms が過ぎるまで待つ（長いポーリング）。 */
  async wait(after: number, boot: string | null, ms: number): Promise<OsNoticeFeedDto> {
    const first = this.read(after, boot);
    if (this.closed || ms <= 0 || first.items.length > 0 || boot !== this.boot || after < 0 || after > this.seq) return first;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.waiters.add(done);
    });
    return this.read(after, boot);
  }
}

export type StopNoticeDeps = {
  db: Db;
  deviceId: string;
  /** いまの登録（RegistryWatcher.current、許可の中身を足したもの）。 */
  live: () => LiveSessionDto[];
  language: GetLanguage;
  feed: Pick<OsNoticeFeed, 'push'>;
  /** Claude のセッションの id から、使用量を数えるアカウントの id（usage/accountOf.ts）。 */
  accountOf: (providerSessionId: string) => string;
  now?: () => number;
  /** 許可待ちになってから、許可の中身（hook）を待つ長さ。 */
  permissionWaitMs?: number;
  /** 問いの文の無いまま知らせてから、問いの文を待つ長さ。殻の預け（notify::hold の 2 秒）より長くする。 */
  bareSettleMs?: number;
};

/**
 * hook と登録のどちらが先に届くかは決まらない。hook を持つ run では、ふつう 0.5 秒の読み直しの間に届く。
 * 待つのは中身の無い許可待ちだけで、その分だけ通知が遅れる（hook を持たない外部ターミナルの run）。
 */
export const PERMISSION_WAIT_MS = 800;
const BARE_SETTLE_MS = 5000;

/**
 * 入力待ちの 1 回。new は知らせる前、bare は問いの文の無いまま知らせて問いの文を待っている、done は知らせ終えた。
 * 入力待ちを抜けたら消す。
 */
type Episode = { since: number; phase: 'new' | 'bare' | 'done' };

type LimitRow = { session_id: string; provider_session_id: string; kind: LimitKind; resets_at: number };

/** 使用制限の覚えを捨てるまでの長さ。リセットから 1 日経ったものは、もう同じ時刻では当たらない。 */
const LIMIT_KEY_TTL_MS = 86_400_000;

/**
 * 通知にする出来事を見張る。登録が変わったときと、短い周期で tick を呼ぶ。
 * - 入力待ちになった：1 回だけ知らせる。問いの文があればそれを、無ければ印（bare）を付けて代わりの文を出し、問いの文が届いたらもう 1 回知らせる（殻が 1 回にまとめる）。
 * - 許可待ちになった：殻に預けさせず（bare を付けず）、許可の中身（道具と命令）で知らせる。
 * - 使用制限に当たった：アカウントとリセットの時刻ごとに 1 通。同じアカウントの会話はまとめて止まるからである。
 * - リセットから猶予を過ぎても続かない：SessionDto の limit.reset が変わるので行を配り直し、Active のものはリセット済みとして知らせる。
 * 最初の tick は、そのとき既にある入力待ちと使用制限を覚えるだけで知らせない。サーバを起こし直す前に知らせ終えているからである。
 * Done と Archived にしたものは、入力待ちでも知らせない（shared の quietLive）。
 */
export class StopNoticeWatch {
  private episodes = new Map<string, Episode>();
  private limitKeys = new Map<string, number>();
  private resetKeys = new Map<string, number>();
  private primed = false;
  private readonly tr: Translate;

  constructor(private readonly deps: StopNoticeDeps) {
    this.tr = translatorOf(deps.language);
  }

  tick(): void {
    const now = this.deps.now?.() ?? Date.now();
    const live = this.deps.live();
    const primed = this.primed;
    this.primed = true;
    this.watchWaiting(live, now, primed);
    this.watchLimits(live, now, primed);
  }

  private idOf(providerSessionId: string): string | null {
    const r = this.deps.db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(providerSessionId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  private session(live: LiveSessionDto[], id: string, now: number): SessionDto | null {
    return getSession(this.deps.db, live, id, { deviceId: this.deps.deviceId, now: () => now });
  }

  private titleOf(s: SessionDto): string {
    return s.name ?? this.tr('common.label.noName');
  }

  private watchWaiting(live: LiveSessionDto[], now: number, primed: boolean): void {
    const waiting = new Set<string>();
    const permissionWait = this.deps.permissionWaitMs ?? PERMISSION_WAIT_MS;
    const settle = this.deps.bareSettleMs ?? BARE_SETTLE_MS;
    for (const l of live) {
      if (l.status !== 'waiting') continue;
      waiting.add(l.sessionId);
      let ep = this.episodes.get(l.sessionId);
      if (!ep) {
        ep = { since: now, phase: primed ? 'new' : 'done' };
        this.episodes.set(l.sessionId, ep);
      }
      if (ep.phase === 'done') continue;
      const id = this.idOf(l.sessionId);
      const s = id ? this.session(live, id, now) : null;
      if (!s || quietLive(s.live, s.state?.status) !== 'waiting') { ep.phase = 'done'; continue; }
      const question = s.activity?.question ?? null;
      const push = (body: string, bare: boolean) => this.deps.feed.push({ kind: 'waiting', sessionId: s.id, title: this.titleOf(s), body, bare });
      if (ep.phase === 'bare') {
        if (question) { push(question, false); ep.phase = 'done'; } else if (now - ep.since >= settle) ep.phase = 'done';
        continue;
      }
      if (stopReasonOf(s) === 'permission') {
        if (!s.permission && now - ep.since < permissionWait) continue;
        push(permissionNoticeText(this.tr, s.permission ?? null), false);
        ep.phase = 'done';
        continue;
      }
      if (question) { push(question, false); ep.phase = 'done'; } else { push(this.tr('home.card.noQuestion'), true); ep.phase = 'bare'; }
    }
    for (const id of [...this.episodes.keys()]) if (!waiting.has(id)) this.episodes.delete(id);
  }

  private watchLimits(live: LiveSessionDto[], now: number, primed: boolean): void {
    for (const m of [this.limitKeys, this.resetKeys]) for (const [k, at] of m) if (now - at > LIMIT_KEY_TTL_MS) m.delete(k);
    const liveOf = new Map(live.map((l) => [l.sessionId, l]));
    const rows = this.deps.db.prepare(`select l.session_id, s.provider_session_id, l.kind, l.resets_at from session_limits l
      join sessions s on s.id = l.session_id and s.deleted_at is null order by l.hit_at, l.session_id`).all() as LimitRow[];
    const hits = new Map<string, LimitRow[]>();
    for (const r of rows) {
      const l = liveOf.get(r.provider_session_id);
      if (!l) continue;
      const key = `${this.deps.accountOf(r.provider_session_id)}|${r.resets_at}`;
      if (!this.limitKeys.has(key)) hits.set(key, [...(hits.get(key) ?? []), r]);
      const resetKey = `${r.session_id}|${r.resets_at}`;
      if (!limitReset(r.resets_at, now) || this.resetKeys.has(resetKey)) continue;
      this.resetKeys.set(resetKey, r.resets_at);
      if (!primed) continue;
      // 猶予を過ぎたので、limit.reset を真にして配り直す（要対応に上がる）。
      touchRow(this.deps.db, 'sessions', r.session_id);
      if (l.status !== 'idle') continue;
      const s = this.session(live, r.session_id, now);
      // 区切りを付けたものは、この後に自動の停止が止める。知らせるのは Active のものだけである。
      if (s && s.state?.status == null) this.deps.feed.push({ kind: 'waiting', sessionId: s.id, title: this.titleOf(s), body: this.tr('stop.notify.reset'), bare: false });
    }
    for (const [key, rs] of hits) {
      this.limitKeys.set(key, rs[0]!.resets_at);
      if (!primed) continue;
      const sessions = rs.map((r) => this.session(live, r.session_id, now)).filter((s): s is SessionDto => s !== null && s.state?.status !== 'done' && s.state?.status !== 'archived');
      const first = sessions[0];
      if (!first) continue;
      const r = rs[0]!;
      const time = resetAtText(this.tr, r.resets_at, now);
      const title = r.kind === 'other' ? this.tr('stop.state.limit') : this.tr('stop.notify.limitTitle', { kind: limitKindText(this.tr, r.kind) });
      const body = sessions.length === 1 ? this.tr('stop.notify.limitOne', { name: this.titleOf(first), time }) : this.tr('stop.notify.limitMany', { n: sessions.length, time });
      this.deps.feed.push({ kind: 'limit', sessionId: first.id, title, body, bare: false });
    }
  }
}
