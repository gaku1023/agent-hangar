import { quietLive, type LiveStatus, type UiAction } from '@agent-hangar/shared';
import { asideOf } from '../lib/aside.ts';
import { baseName, relPath } from '../lib/paths.ts';
import type { Store } from '../store/store.ts';
import type { BandGroup } from './home.ts';
import { resetsLabel } from './format.ts';
import { translatorOf } from './i18n.ts';
import { projectDisplayName } from './projectName.ts';

/** 同じファイルを編集している相手。context はプロジェクトと状態の語、open はそのセッションを開く操作。 */
export type OverlapPartner = { id: string; name: string; context: string; live: LiveStatus | null; aside: boolean; open: UiAction };
/** 重なったファイル 1 つ。path は作業ディレクトリからの相対（外なら絶対）、mine と theirs は最後に編集した時刻。 */
export type OverlapFileRow = { key: string; path: string; mine: string; theirs: string; alternating: boolean };
/**
 * 同じファイルの編集の警告（止めない。OS の通知も右下の札も出さない）。
 * ホームの実行中の行の札、セッション画面の現在の札の 1 節、サイドバーの行の印が、同じこの形を読む。
 * chip は札の文（「同じファイル 2」）、summary は現在の札の 1 節で相手の名前に続ける文、sidebarTitle はサイドバーの印に乗せたときの文である。
 * dismiss は「このファイルでは表示しない」で、相手ごとに 1 つ出す。worktree は「worktree で新しいセッション」である。
 */
export type OverlapProps = {
  sessionId: string; count: number; chip: string; title: string; summary: string; sidebarTitle: string;
  partners: OverlapPartner[]; files: OverlapFileRow[]; dismiss: UiAction[]; worktree: UiAction;
};

const LIVE_KEY = { busy: 'row.dot.busy', idle: 'row.dot.idle', waiting: 'row.dot.waiting' } as const;

/** そのセッションの、同じファイルの編集の警告。重なりが無いか、実行中でなければ null。 */
export function presentOverlap(store: Store, sessionId: string, now: number): OverlapProps | null {
  const s = store.sessions[sessionId];
  const o = s?.overlap;
  if (!s || !o || o.files.length === 0 || s.live === null) return null;
  const t = translatorOf(store);
  const clock = (ts: number) => resetsLabel(ts, now) ?? '';
  const partners = o.with.map((id): OverlapPartner => {
    const p = store.sessions[id];
    const live = p ? quietLive(p.live, p.state?.status, p.woke) : null;
    const project = p?.projectId && store.projects[p.projectId] ? projectDisplayName(store.projects[p.projectId]!, t) : t('common.label.uncategorized');
    const state = live ? t(LIVE_KEY[live]) : t('row.dot.ended');
    return { id, name: p?.name ?? t('common.label.noName'), context: `${project} · ${state}`, live, aside: p ? asideOf(p.live, p.liveAside) !== null : false, open: { type: 'session.open', id } };
  });
  const files = o.files.map((f): OverlapFileRow => ({ key: `${f.with}:${f.path}`, path: relPath(f.path, s.cwd), mine: clock(f.mineAt), theirs: clock(f.theirsAt), alternating: f.alternating }));
  const sep = t('common.list.separator');
  const names = [...new Set(o.files.map((f) => baseName(f.path)))].join(sep);
  return {
    sessionId, count: o.files.length,
    chip: t('overlap.band.chip', { n: o.files.length }),
    title: t('overlap.pop.title'),
    summary: t('overlap.card.summary', { files: names }),
    sidebarTitle: t('overlap.sidebar.title', { names: partners.map((p) => p.name).join(sep) }),
    partners, files,
    dismiss: o.with.map((w): UiAction => ({ type: 'overlap.dismiss', sessionId, with: w, paths: o.files.filter((f) => f.with === w).map((f) => f.path) })),
    worktree: { type: 'overlap.worktree', sessionId },
  };
}

/**
 * 帯の「実行中」の群の行に、同じファイルの編集の札を足す。足す行があれば、錠剤に琥珀の点（mark）を付ける。件数は変えない。
 * 行の組み立て（presenters/home.ts の runningRow）は触らず、組んだ後に行の鍵（run:<id>）で引いて重ねる。
 */
export function withOverlaps(group: BandGroup, store: Store, now: number): BandGroup {
  if (group.id !== 'running') return group;
  let any = false;
  const rows = group.rows.map((r) => {
    const id = r.key.startsWith('run:') ? r.key.slice(4) : null;
    const overlap = id ? presentOverlap(store, id, now) : null;
    if (!overlap) return r;
    any = true;
    return { ...r, overlap };
  });
  return any ? { ...group, rows, mark: translatorOf(store)('overlap.pop.title') } : group;
}
