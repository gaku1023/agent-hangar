import { PRIMARY_ACCOUNT_ID, type InterruptedItemDto, type LiveStatus, type SessionDto, type SessionInterruptDto, type Translate, type UiAction } from '@agent-hangar/shared';
import { clientPlatform } from '../keys.ts';
import type { State } from '../mediator/types.ts';
import { hasMultipleAccounts, runningSessionIds, type Store } from '../store/store.ts';
import { isPickableAccount, presentAccounts, type AccountView } from './accounts.ts';
import { resetsLabel } from './format.ts';
import type { BandAction, BandGroup, BandRow, BandSection } from './home.ts';
import { translatorOf } from './i18n.ts';
import { projectDisplayName } from './projectName.ts';
import { muxName } from './readiness.ts';

/** 朝に開く群にするのは、中断を記録してからこの長さまで。古い群は錠剤だけ残し、開かない。 */
const MORNING_MS = 24 * 3_600_000;
/** 止まる前の状態の並び。作業中だったものほど先に再開する。分からないものは最後。 */
const WAS_ORDER: Record<string, number> = { busy: 0, waiting: 1, idle: 2 };
const WAS: Record<LiveStatus, { key: 'interrupted.row.was.busy' | 'interrupted.row.was.waiting' | 'interrupted.row.was.idle'; tone: 'busy' | 'wait' | 'faint' }> = {
  busy: { key: 'interrupted.row.was.busy', tone: 'busy' },
  waiting: { key: 'interrupted.row.was.waiting', tone: 'wait' },
  idle: { key: 'interrupted.row.was.idle', tone: 'faint' },
};

const clock = (ts: number, now: number): string => resetsLabel(ts, now) ?? '';

/**
 * 中断の印（一覧の行の右端の「中断」と、冒頭の 1 枚の 1 行目）。title は原因と時刻。
 * 原因が分からない（他の PC の run など）ときは「中断」と時刻だけを言う。
 */
export function interruptMark(t: Translate, i: SessionInterruptDto, now: number): { label: string; title: string } {
  const time = clock(i.at, now);
  const title = i.cause === 'restart' ? t('interrupted.mark.restart', { time })
    : i.cause === 'mux' ? t('interrupted.mark.mux', { mux: muxName(clientPlatform()), time })
      : t('interrupted.mark.unknown', { time });
  return { label: t('interrupted.mark.label'), title };
}

function action(t: Translate, id: string, label: string, name: string, send: UiAction, o: { kind?: 'primary' | 'ghost' | 'plain'; disabled?: boolean; icon?: BandAction['icon'] } = {}): BandAction {
  const kind = o.kind ?? 'plain';
  return { id, label, ariaLabel: t('home.band.actionFor', { action: label, name }), primary: kind === 'primary', ghost: kind === 'ghost', send, ...(o.disabled ? { disabled: true } : {}), ...(o.icon ? { icon: o.icon } : {}) };
}

/** アカウントの小見出し。5 時間の使用率と、制限に近いことか未ログインを添える。 */
function sectionOf(t: Translate, a: AccountView): BandSection {
  const out = !isPickableAccount(a);
  const meter = a.fiveHour ? { percent: a.fiveHour.percent, label: t('accountSwitcher.face.fiveHour', { percent: Math.round(a.fiveHour.percent) }), high: a.fiveHour.high } : null;
  const note = out ? { text: t('interrupted.account.loggedOut'), tone: 'faint' as const } : a.fiveHour?.high ? { text: t('interrupted.account.nearLimit'), tone: 'warn' as const } : null;
  return { key: a.id, name: a.name, color: a.color, meter, note, action: out ? action(t, 'login', t('interrupted.account.login'), a.name, { type: 'account.login', accountId: a.id }) : null };
}

/**
 * ホームの帯の「前回実行中」の群（錠剤と引き出し）。出す行が無ければ null で、足さない。
 *
 * 行に出すのは、群（store.interrupted）のうち、いまもステータスが無く、中断の印が残っていて（その後に起こし直していない）、実行中でないものである。
 * 並びは止まる前の状態（作業中だった、入力待ちだった、アイドルだった）の順で、同じなら最後に動いた新しい順にする。
 * アカウントが 2 件以上なら、アカウントごとに小見出し（色、名前、5 時間の使用率）を置き、未ログインのアカウントの行は押せない形にする。
 * 「すべて再開」はその行を飛ばす。再開を頼んでいる行は輪が回り「再開中」、待っている行は「順番待ち」、断られた行は「失敗」と理由と「再試行」になる。
 * 順番待ちが残っている間は、「すべて再開」の代わりに「残りをキャンセル」を置く。「閉じる」は残りの行を全部「再開しない」にする。
 * 朝に開く群になるのは、中断を記録してから 24 時間までである。
 */
export function presentInterrupted(state: State, store: Store, now: number): BandGroup | null {
  const g = store.interrupted;
  if (!g) return null;
  const t = translatorOf(store);
  const alive = runningSessionIds(store);
  const q = state.resumeQueue;
  const shown = g.items.filter((it) => {
    const s = store.sessions[it.sessionId];
    return !!s && !s.state?.status && s.interrupted !== null && s.live === null && !alive.has(s.id);
  });
  if (shown.length === 0) return null;
  const multi = hasMultipleAccounts(store);
  const views = multi ? presentAccounts(store, now) : [];
  const accountOf = (it: InterruptedItemDto): AccountView | null => (multi ? views.find((a) => a.id === (it.account ?? PRIMARY_ACCOUNT_ID)) ?? views.find((a) => a.primary) ?? null : null);
  const order = (it: InterruptedItemDto) => (it.lastLive ? WAS_ORDER[it.lastLive] ?? 3 : 3);
  const last = (it: InterruptedItemDto) => store.sessions[it.sessionId]!.lastActivityAt ?? 0;
  const accountRank = (it: InterruptedItemDto) => { const a = accountOf(it); return a ? views.indexOf(a) : 0; };
  const items = [...shown].sort((a, b) => accountRank(a) - accountRank(b) || order(a) - order(b) || last(b) - last(a));
  const sections = new Map(views.map((a) => [a.id, sectionOf(t, a)]));

  const queued = new Set(q.queued);
  const active = new Set(q.active);
  const blocked = (it: InterruptedItemDto) => { const a = accountOf(it); return a !== null && !isPickableAccount(a); };
  const row = (it: InterruptedItemDto): BandRow => {
    const s: SessionDto = store.sessions[it.sessionId]!;
    const name = s.name ?? t('common.label.noName');
    const failed = q.failed[s.id];
    const resuming = active.has(s.id);
    const waiting = queued.has(s.id);
    const was = it.lastLive ? WAS[it.lastLive] : null;
    const textHead = failed !== undefined ? { text: t('interrupted.row.failed'), tone: 'error' as const }
      : resuming ? { text: t('interrupted.row.resuming'), tone: 'busy' as const }
        : waiting ? { text: t('interrupted.row.queued'), tone: 'faint' as const }
          : was ? { text: t(was.key), tone: was.tone } : undefined;
    const label = failed !== undefined ? t('interrupted.row.retry') : t('interrupted.row.resume');
    const a = accountOf(it);
    return {
      key: `int:${it.runId}`,
      lead: { kind: 'ring', spin: resuming, label: t('interrupted.mark.label') },
      name,
      context: s.projectId && store.projects[s.projectId] ? projectDisplayName(store.projects[s.projectId]!, t) : t('common.label.uncategorized'),
      ...(textHead ? { textHead } : {}),
      text: failed ?? s.summary?.oneLiner ?? s.firstPrompt ?? '',
      detail: null, tone: null,
      trail: [{ text: clock(s.lastActivityAt ?? it.endedAt, now) }],
      open: { type: 'session.open', id: s.id },
      actions: [
        action(t, 'resume', label, name, { type: 'interrupted.resume', ids: [s.id] }, { disabled: resuming || waiting || blocked(it) }),
        action(t, 'skip', t('interrupted.row.skip'), name, { type: 'interrupted.dismiss', runIds: [it.runId], dismissed: true, name }, { kind: 'ghost', icon: 'close', disabled: resuming }),
      ],
      ...(a ? { section: sections.get(a.id)! } : {}),
    };
  };
  const rows = items.map(row);
  const startable = items.filter((it) => !active.has(it.sessionId) && !queued.has(it.sessionId) && !blocked(it)).map((it) => it.sessionId);
  const groupName = t('interrupted.band.label');
  const lead = q.queued.length > 0
    ? action(t, 'cancelRest', t('interrupted.band.cancelRest'), groupName, { type: 'interrupted.cancel' })
    : action(t, 'resumeAll', t('interrupted.band.resumeAll'), groupName, { type: 'interrupted.resume', ids: startable }, { kind: 'primary', disabled: startable.length === 0 });
  const close = action(t, 'close', t('interrupted.band.close'), groupName, { type: 'interrupted.dismiss', runIds: items.map((it) => it.runId), dismissed: true }, { kind: 'ghost' });
  const time = clock(g.at, now);
  const summary = g.cause === 'mux' ? t('interrupted.band.summary.mux', { mux: muxName(clientPlatform()), time }) : t('interrupted.band.summary.restart', { time });
  return { id: 'interrupted', label: groupName, icon: 'restart', tone: 'default', count: rows.length, summary, morning: now - g.at < MORNING_MS, rows, headActions: [lead, close] };
}
