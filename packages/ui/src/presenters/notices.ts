import { compatState, type Intent, type Language, type SyncStatusBody, type Translate } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import type { IconName } from '../views/primitives/Icon.tsx';
import { readinessCompat } from './compat.ts';
import { returningCards, type ReturnCard } from './home.ts';
import { storeLanguage, translatorOf } from './i18n.ts';
import { countExpiring } from './retention.ts';
import { limitedWord } from './syncLabel.ts';

/**
 * ベルの一覧の種類。並びは 2.11.2 の決めたとおり、リマインダー、同期、互換、保持期間、設定の同期で送らなかった項目で、最後に通知の誘いを置く。
 * 通知の誘い（notify）は、右下の積みの上に添えていたものを、ここへ移した（PR 29）。
 * 更新の案内は、事実の出どころがまだ無いので、いまは行を作らない。
 * 足すときは、種類をここに足し、BUILDERS に事実から行を組む関数を 1 つ足すだけで済む。
 */
export type NoticeKind = 'reminder' | 'sync' | 'compat' | 'retention' | 'config' | 'notify';
/** 行の色の意味。err は赤（失敗）、warn は黄（気づいてほしい）、info は青（案内）。 */
export type NoticeTone = 'err' | 'warn' | 'info';

/**
 * 一覧の 1 行。
 * key は既読の印で、`種類|対象|事実の版` の形である。事実の版が変われば鍵が変わり、また未読になる。
 * when は時の欄（無ければ null）、detail は題の下の 1 行（無ければ null）。
 * action は行の操作 1 つで、押すと行を既読にして intent を送る（views/Bell.tsx）。
 */
export type NoticeRow = {
  key: string; kind: NoticeKind; tone: NoticeTone; icon: IconName; kindLabel: string;
  title: string; detail: string | null; when: string | null; unread: boolean;
  action: { label: string; intent: Intent };
};
/**
 * ベルの props。rows は事実から組んだ行（既読も含む。閉じても残る）、keys はその鍵の全部で、「すべて既読にする」が送る。
 * label はベルの名前で、未読があれば数を添える。
 */
export type NoticesProps = { rows: NoticeRow[]; unread: number; keys: string[]; label: string };

/** 組む前の行。既読かどうかは、全部の行がそろってから 1 か所で決める。 */
type Draft = Omit<NoticeRow, 'unread'>;
type Ctx = { state: State; store: Store; now: number; tz: string | undefined; t: Translate; language: Language };

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 「N 分前」の言い方。ヘッダーの relativeTime と同じ境（1 時間、1 日、2 日）で区切る。 */
function agoWord(t: Translate, ts: number, now: number): string {
  const min = Math.floor((now - ts) / MIN);
  if (min < 1) return t('notices.ago.now');
  if (min < 60) return t('notices.ago.min', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('notices.ago.hour', { n: hours });
  const days = Math.floor(hours / 24);
  return days < 2 ? t('notices.ago.yesterday') : t('notices.ago.day', { n: days });
}

function reminderWhen(t: Translate, c: ReturnCard): string {
  if (c.returnOn === null) return t('notices.reminder.whenNoDate');
  if (c.overdueDays !== null && c.overdueDays > 0) return t('notices.reminder.whenDaysPast', { n: c.overdueDays });
  if (c.pastMin !== null) {
    if (c.pastMin < 1) return t('notices.reminder.whenPastNow');
    return c.pastMin < 60 ? t('notices.reminder.whenPastMin', { n: c.pastMin }) : t('notices.reminder.whenPastHour', { n: Math.floor(c.pastMin / 60) });
  }
  return c.returnTime ? t('notices.reminder.whenTodayAt', { time: c.returnTime }) : t('notices.reminder.whenToday');
}

/** 今日のリマインダー。戻る日が今日か過ぎた Paused 1 件につき 1 行で、並びはホームの「今日戻る」と同じである。 */
function reminders({ store, now, t }: Ctx): Draft[] {
  return returningCards(store, now).map((c) => ({
    // 時刻を付け直したり、日を変えたりしたら別の鍵になり、また未読になる。
    key: `reminder|${c.id}|${c.returnOn === null ? 'none' : c.returnTime ? `${c.returnOn} ${c.returnTime}` : c.returnOn}`,
    kind: 'reminder', tone: 'warn', icon: 'reminder', kindLabel: t('notices.kind.reminder'),
    title: c.name, detail: store.sessions[c.id]?.state?.note || null, when: reminderWhen(t, c),
    action: { label: t('notices.reminder.open'), intent: { type: 'session.open', id: c.id } },
  }));
}

/**
 * 同期の失敗と一時停止。ヘッダーの同期の一行と同じ事実（Store の sync）から読む。
 * 同期を使っていない端末（off）と、動いている間は行を作らない。
 * エラーは赤、利用者が止めたものと無料枠で退いているものは黄にする。
 */
function syncFacts({ store, t, language, tz }: Ctx): Draft[] {
  const s = store.sync;
  if (!s) return [];
  const base = { kind: 'sync', icon: 'sync', kindLabel: t('notices.kind.sync'), when: null, action: { label: t('notices.sync.open'), intent: { type: 'nav.go', to: { name: 'settings', at: 'sync' } } } } as const;
  return [...syncState(s, base, t, language, tz), ...syncSkipped(s, base, t)];
}

type SyncBase = { kind: 'sync'; icon: 'sync'; kindLabel: string; when: null; action: NoticeRow['action'] };

function syncState(s: SyncStatusBody, base: SyncBase, t: Translate, language: Language, tz: string | undefined): Draft[] {
  if (s.state === 'error') {
    // 版で止まると state は error のまま paused の印だけが立つ。止まっていることも言う。
    const message = s.error ?? '';
    const detail = s.error ?? t('header.sync.failed');
    return [{ ...base, key: `sync|error|${message}${s.paused ? '|paused' : ''}`, tone: 'err', title: t('header.sync.error'), detail: s.paused ? `${detail}。${t('notices.sync.pausedToo')}` : detail }];
  }
  if (s.state !== 'paused') return [];
  if (s.limitedUntil !== null) return [{ ...base, key: `sync|paused|quota|${s.limitedUntil}`, tone: 'warn', title: limitedWord(t, language, s.limitedUntil, tz), detail: null }];
  return [{ ...base, key: 'sync|paused|user', tone: 'warn', title: t('header.sync.paused'), detail: null }];
}

/**
 * 本文を降ろせず、諦めた項目（同期の状態の skipped）。
 * 以前はサーバが、降ろせなかった 1 回目と諦めたときに error の toast を流していた。今は事実だけを出し、文は画面が組む（PR 29）。
 * 同期の状態の行とは別の行にする。止まってはいなくても、降ろせない本文が残るからである。
 * 理由は先頭の項目のものを添える。数が変われば鍵が変わり、また未読になる。
 */
function syncSkipped(s: SyncStatusBody, base: SyncBase, t: Translate): Draft[] {
  if (s.state === 'off' || s.skipped.length === 0) return [];
  return [{ ...base, key: `sync|skipped|${s.skipped.length}`, tone: 'err', title: t('notices.sync.skipped', { n: s.skipped.length }), detail: s.skipped[0]!.message }];
}

/**
 * Claude Code との互換の変更点。変更点が 1 件以上あるときだけ行にする（未検証の版は止めた機能が無いので行にしない）。
 * 件数は、中身（GET /api/compat）が届いていればその数にそろえる。要約より後に読んだ分だけ新しいからである。
 * 設定の互換の節へ移りたいが、設定の切り替え先（Route の at）にまだ無いので、いまは設定の頭へ移る。
 */
function compat({ store, now, t }: Ctx): Draft[] {
  const summary = store.readiness ? readinessCompat(store.readiness) : undefined;
  if (!summary) return [];
  const count = store.compat ? store.compat.drifts.length : summary.driftCount;
  if (compatState({ ...summary, driftCount: count }) !== 'drift') return [];
  const version = summary.localVersion;
  const detail = version === null ? t('notices.compat.detailUnknown', { n: count }) : count === 1 ? t('notices.compat.detailOne', { version }) : t('notices.compat.detailMany', { version, n: count });
  const seen = store.compat && store.compat.drifts.length > 0 ? Math.max(...store.compat.drifts.map((d) => d.lastSeenAt)) : null;
  return [{
    key: `compat|${version ?? 'unknown'}|${count} change`,
    kind: 'compat', tone: 'warn', icon: 'link', kindLabel: t('notices.kind.compat'),
    title: t('notices.compat.title'), detail, when: seen === null ? null : agoWord(t, seen, now),
    action: { label: t('notices.compat.open'), intent: { type: 'nav.go', to: { name: 'settings' } } },
  }];
}

/**
 * 保持期間。値を自分で入れた人と、組織の設定で決まっている人、書き換えられない人には出さない（ヘッダーの下の帯と同じ条件）。
 * 消えかけのトランスクリプトがあれば件数を、無ければ「消える」という決まりそのものを言う。
 * 鍵に件数は入れない。件数は日ごとに動くので、入れると毎日未読に戻る。「消えかけがある」と「決まりだけ」の切り替わりで未読に戻す。
 */
function retention({ store, now, t }: Ctx): Draft[] {
  const r = store.retention;
  if (!store.bootstrapped || !r || r.source !== 'default' || !r.writable) return [];
  const soon = countExpiring(Object.values(store.sessions), r.days, now);
  const base = { kind: 'retention', tone: 'warn', icon: 'retention', kindLabel: t('notices.kind.retention'), when: null, action: { label: t('notices.retention.open'), intent: { type: 'nav.go', to: { name: 'settings' } } } } as const;
  return [soon > 0
    ? { ...base, key: `retention|${r.days}|soon`, title: t('notices.retention.soon', { n: soon }), detail: t('notices.retention.soonDetail', { days: r.days }) }
    : { ...base, key: `retention|${r.days}|rule`, title: t('notices.retention.rule', { days: r.days }), detail: t('notices.retention.ruleDetail') }];
}

/**
 * 設定の同期で送らなかった項目（落とした権限の規則、秘密らしい文字列のあった項目）。
 * 事実は ConfigSyncDto の unsent（件数）で、件数が 0 に戻れば行も消える。同期を切っているとき、サーバがまだ知らない（古い）ときも作らない。
 * 鍵に件数を入れるので、件数が変わればまた未読になる。行からは、設定の同期の節の送らなかった項目の行（at=unsent）が開く。
 */
function configUnsent({ store, t }: Ctx): Draft[] {
  const c = store.configSync;
  if (!c || !c.enabled || c.unsent <= 0) return [];
  return [{
    key: `config|unsent|${c.unsent}`, kind: 'config', tone: 'warn', icon: 'settings', kindLabel: t('notices.kind.config'),
    title: t('notices.config.unsent', { n: c.unsent }), detail: t('notices.config.unsentDetail'), when: null,
    action: { label: t('notices.config.open'), intent: { type: 'nav.go', to: { name: 'settings', at: 'unsent' } } },
  }];
}

/**
 * 通知の誘い。通知を出せる環境なのに受け取っていないときだけ行にする。
 * OS で切られているときは勧めない（直し方は設定の通知の節に出す）。
 * 受け取りを入れると事実が無くなり、行も消える。
 */
function notifyOffer({ store, t }: Ctx): Draft[] {
  const n = store.notify;
  if (!n.available || n.on || n.blocked) return [];
  return [{
    key: 'notify|offer', kind: 'notify', tone: 'info', icon: 'bell', kindLabel: t('notices.kind.notify'),
    title: t('notices.notify.title'), detail: t('notices.notify.detail'), when: null,
    action: { label: t('notices.notify.open'), intent: { type: 'notify.set', on: true } },
  }];
}

/** 種類の並び。この順に行を並べる。 */
const BUILDERS: readonly ((c: Ctx) => Draft[])[] = [reminders, syncFacts, compat, retention, configUnsent, notifyOffer];

/**
 * ベルの一覧。行は事実から毎回組み、一覧そのものは保存しない。事実が無くなれば行も消える（閉じても残るのは、事実が残る間のことである）。
 * 既読は State の noticesRead（鍵の集合）だけで決まる。
 * tz は端末の時差で、試験でだけ決めて渡す。
 */
export function presentNotices(state: State, store: Store, now: number, tz?: string): NoticesProps {
  const t = translatorOf(store);
  const ctx: Ctx = { state, store, now, tz, t, language: storeLanguage(store) };
  const read = new Set(Array.isArray(state.noticesRead) ? state.noticesRead : []);
  const rows = BUILDERS.flatMap((build) => build(ctx)).map((d): NoticeRow => ({ ...d, unread: !read.has(d.key) }));
  const unread = rows.filter((r) => r.unread).length;
  return { rows, unread, keys: rows.map((r) => r.key), label: unread > 0 ? t('notices.bell.labelUnread', { n: unread }) : t('notices.bell.label') };
}
