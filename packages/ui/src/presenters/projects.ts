import { isReturnOn, isReturnTime, overdueDays, returnPastMinutes, type ProjectStatus, type SessionDto } from '@agent-hangar/shared';
import { isUnder } from '../lib/paths.ts';
import type { State } from '../mediator/types.ts';
import { liveFilterOfSession, runningSessionIds, type Store } from '../store/store.ts';
import { relativeTime, STATUS_LABEL } from './format.ts';
import { translatorOf } from './i18n.ts';
import { returnOnLabel } from './row.ts';

/** 「いま」の列に並べる 1 つ。kind は色の決め手で、text は数を含む見える文字である。 */
export type ProjectNowItem = { kind: 'waiting' | 'running' | 'pending' | 'todo' | 'reminder'; text: string };

/**
 * 名前の下に出す場所。
 * outside は親フォルダの外にあるときのパス、missing はこの PC でパスが見つからないとき（赤い札から場所の再指定へ進む）である。
 * 親フォルダの下にあるなら null で、何も出さない。
 */
export type ProjectPlace = { kind: 'outside'; path: string } | { kind: 'missing' };

/**
 * 表の 1 行。
 * label は行の読み上げの名前で、名前、ステータス、「いま」の数を含む。
 * sessionsText はセッションの数の欄の文字、lastActivity は最後の活動の相対の時刻である。
 */
export type ProjectRowProps = { id: string; name: string; status: ProjectStatus; place: ProjectPlace | null; now: ProjectNowItem[]; sessionCount: number; sessionsText: string; lastActivity: string; label: string };
export type ProjectsSection = { status: 'active' | 'paused' | 'done'; label: string; rows: ProjectRowProps[] };

/**
 * sections は Active、Paused、Done の順で、行の無い節は含めない。
 * archived は末尾の 1 行で、Archived が無ければ null。開いているときだけ rows を持つ。
 * total は絞り込みの前の、Archived を含むプロジェクトの数（見出しの横に出す）。
 * empty は none（プロジェクトがひとつも無い）か noMatch（絞り込みで 0 件）で、どちらでもなければ null。
 * promoteSessionId は、none のときに昇格の入口が相手にするクイックセッション（最後に動いたもの）。無ければ null。
 */
export type ProjectsProps = {
  sections: ProjectsSection[];
  archived: { count: number; open: boolean; rows: ProjectRowProps[] } | null;
  total: number;
  empty: 'none' | 'noMatch' | null;
  promoteSessionId: string | null;
};

const SHOWN_STATUSES = ['active', 'paused', 'done'] as const;

/**
 * プロジェクトの実行中と入力待ちの数。
 * ホームと同じ数え方にするため、サーバの runningCount（入力待ちを含み、起動中を含まない）は使わず、手元のセッションから数える。
 */
export function liveCountsOf(store: Store, projectId: string, alive: Set<string> = runningSessionIds(store)): { running: number; waiting: number } {
  let running = 0;
  let waiting = 0;
  for (const s of Object.values(store.sessions)) {
    if (s.projectId !== projectId) continue;
    const f = liveFilterOfSession(store, s, alive);
    if (f === 'running') running++;
    else if (f === 'waiting') waiting++;
  }
  return { running, waiting };
}

/**
 * 親フォルダの外にあるときのパス。下にあるものは null（直下でも深くても、場所は出さない）。
 * 親フォルダがまだ分からないとき（設定が届く前）は、下にあるかを言えないので、パスをそのまま返す。
 * フォルダ名は NFD で届くことがあるので、比べるときは NFC にそろえる。
 * Windows のパスは、区切りの違いと大文字小文字を同じとみなす（lib/paths.ts の isUnder）。
 */
export function placeOutside(path: string | null, workspaceRoot: string): string | null {
  if (path === null) return null;
  if (workspaceRoot === '') return path;
  return isUnder(path.normalize('NFC'), workspaceRoot.normalize('NFC')) ? null : path;
}

/**
 * そのプロジェクトのセッションに付いたリマインダーのうち、いちばん近いものの札の文。無ければ null。
 * プロジェクト自身はリマインダーを持たない。見るのは、Paused で日付のあるセッションだけである。
 * 「近い」は日付の早いもの（同じ日は時刻の早いもの、時刻なしは「その日のうち」として時刻つきの後）で、過ぎたものも数える。
 * 見落としたものが、先の予定より前に出る。
 */
function nearestReminder(sessions: SessionDto[]): { on: string; time: string | null } | null {
  let best: { on: string; time: string | null; key: string } | null = null;
  for (const s of sessions) {
    const st = s.state;
    if (st?.status !== 'paused' || typeof st.returnOn !== 'string' || !isReturnOn(st.returnOn)) continue;
    const time = typeof st.returnTime === 'string' && isReturnTime(st.returnTime) ? st.returnTime : null;
    const key = `${st.returnOn} ${time ?? '23:59'}`;
    if (best === null || key < best.key) best = { on: st.returnOn, time, key };
  }
  return best === null ? null : { on: best.on, time: best.time };
}

/** 確認待ちの数。完了済みでない TODO の完了の候補と、このプロジェクトのセッションに付いた状態の提案を数える（ホームの「確認待ち」と同じ）。 */
function pendingCount(store: Store, projectId: string, sessions: SessionDto[]): number {
  const todos = Object.values(store.todos).filter((t) => t.projectId === projectId && t.candidate !== null && !t.done).length;
  return todos + sessions.filter((s) => !!s.state?.candidate).length;
}

export function presentProjects(_state: State, store: Store, now: number, filter: string, showArchived: boolean): ProjectsProps {
  const t = translatorOf(store);
  const workspaceRoot = store.settings?.workspaceRoot ?? '';
  const alive = runningSessionIds(store);
  const sessionsOf = new Map<string, SessionDto[]>();
  for (const s of Object.values(store.sessions)) {
    if (s.projectId === null) continue;
    const list = sessionsOf.get(s.projectId);
    if (list) list.push(s);
    else sessionsOf.set(s.projectId, [s]);
  }

  const toRow = (p: (typeof store.projects)[string]): ProjectRowProps => {
    const mine = sessionsOf.get(p.id) ?? [];
    const counts = liveCountsOf(store, p.id, alive);
    const pending = pendingCount(store, p.id, mine);
    const reminder = nearestReminder(mine);
    const items: ProjectNowItem[] = [];
    if (counts.waiting > 0) items.push({ kind: 'waiting', text: t('projects.now.waiting', { n: counts.waiting }) });
    if (counts.running > 0) items.push({ kind: 'running', text: t('projects.now.running', { n: counts.running }) });
    if (pending > 0) items.push({ kind: 'pending', text: t('projects.now.pending', { n: pending }) });
    if (p.openTodoCount > 0) items.push({ kind: 'todo', text: t('projects.now.todo', { n: p.openTodoCount }) });
    if (reminder) items.push({ kind: 'reminder', text: t('projects.now.reminder', { date: returnOnLabel(t, reminder.on, overdueDays(reminder.on, now), reminder.time, returnPastMinutes(reminder.on, reminder.time, now)) }) });
    const status = STATUS_LABEL[p.status];
    const outside = placeOutside(p.path, workspaceRoot);
    const place: ProjectPlace | null = !p.resolved ? { kind: 'missing' } : outside !== null ? { kind: 'outside', path: outside } : null;
    return {
      id: p.id, name: p.name, status: p.status, place, now: items, sessionCount: mine.length, sessionsText: t('projects.row.sessions', { n: mine.length }), lastActivity: relativeTime(t, p.lastActivityAt, now),
      label: items.length === 0 ? t('projects.row.label', { name: p.name, status }) : t('projects.row.labelNow', { name: p.name, status, now: items.map((i) => i.text).join(t('projects.now.separator')) }),
    };
  };

  // スクラッチの擬似プロジェクトは出さない。ホームの一覧の絞り込みには残る。
  const real = Object.values(store.projects).filter((p) => !p.isScratch);
  const needle = filter.trim().toLowerCase();
  const matched = real.filter((p) => !needle || p.name.toLowerCase().includes(needle)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const sections: ProjectsSection[] = SHOWN_STATUSES
    .map((status) => ({ status, label: STATUS_LABEL[status], rows: matched.filter((p) => p.status === status).map(toRow) }))
    .filter((s) => s.rows.length > 0);
  const archivedProjects = matched.filter((p) => p.status === 'archived');
  const archived = archivedProjects.length === 0 ? null : { count: archivedProjects.length, open: showArchived, rows: showArchived ? archivedProjects.map(toRow) : [] };

  const empty = real.length === 0 ? 'none' : matched.length === 0 ? 'noMatch' : null;
  let promoteSessionId: string | null = null;
  if (empty === 'none') {
    let latest = -Infinity;
    for (const s of Object.values(store.sessions)) {
      if (!s.projectId || !store.projects[s.projectId]?.isScratch) continue;
      if ((s.lastActivityAt ?? 0) > latest) { latest = s.lastActivityAt ?? 0; promoteSessionId = s.id; }
    }
  }
  return { sections, archived, total: real.length, empty, promoteSessionId };
}
