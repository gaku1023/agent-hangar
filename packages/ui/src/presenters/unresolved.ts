import type { UiAction, ProjectDto, Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import type { BandAction, BandGroup, BandRow } from './home.ts';

/**
 * この PC で場所が無いプロジェクトの種類（設計書 2.11.5）。
 * missing はこの PC に場所を持っていたが消えたもの、elsewhere はこの PC に場所を持ったことが無い（他の PC から届いただけの）ものである。
 * スクラッチは、どちらでもない。
 * サーバが unresolved を付けない古い DTO は、path と resolved から同じ区分を読む。
 */
export type UnresolvedKind = 'missing' | 'elsewhere';

export function unresolvedKind(p: ProjectDto): UnresolvedKind | null {
  if (p.isScratch) return null;
  if (p.unresolved !== undefined) return p.unresolved === null ? null : p.unresolved.kind;
  if (p.resolved) return null;
  return p.path !== null ? 'missing' : 'elsewhere';
}

/** 帯や札に数えるプロジェクトか。Archived にしたものは、利用者が脇へ置いたので数えない。 */
const counted = (p: ProjectDto, kind: UnresolvedKind): boolean => p.status !== 'archived' && unresolvedKind(p) === kind;

function action(t: Translate, id: string, label: string, name: string, send: UiAction, kind: 'primary' | 'ghost' | 'plain' = 'plain'): BandAction {
  return { id, label, ariaLabel: t('home.band.actionFor', { action: label, name }), primary: kind === 'primary', ghost: kind === 'ghost', send };
}

/**
 * ホームの帯の 4 つ目の群（錠剤と引き出し）。0 件なら null で、足さない。
 * 件数に入れるのは、この PC で場所が消えたもの（missing）だけである。他の PC から届いただけのもの（elsewhere）は、数えない。
 * 数えると、2 台で使う人の帯が消えなくなる。届いただけのものは、プロジェクトの一覧の「この PC にパスがありません」の札から扱う。
 * 行は 1 件 1 行で、名前、セッションの数、前のパス、「場所を再指定」「Archived にする」「一覧から削除」を置く。
 * 「場所を再指定」だけがダイアログを開く。「Archived にする」はそのまま実行し、「一覧から削除」は取り消せないので Mediator が先に確認を出す。
 * 朝に開く群にはしない（morning は偽）。直すのを急がせる知らせではないからである。
 */
export function presentUnresolved(store: Store, t: Translate): BandGroup | null {
  const lost = Object.values(store.projects)
    .filter((p) => counted(p, 'missing'))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
  if (lost.length === 0) return null;
  const sessions = new Map<string, number>();
  for (const s of Object.values(store.sessions)) if (s.projectId !== null) sessions.set(s.projectId, (sessions.get(s.projectId) ?? 0) + 1);
  const row = (p: ProjectDto): BandRow => ({
    key: `unresolved:${p.id}`, lead: { kind: 'place' }, name: p.name, context: t('home.band.unresolvedSessions', { n: sessions.get(p.id) ?? 0 }), text: '', detail: p.unresolved ? p.unresolved.previousPath : p.path, tone: null, trail: [], open: { type: 'project.open', id: p.id },
    actions: [
      action(t, 'relocate', t('home.band.relocate'), p.name, { type: 'project.resolve.open', id: p.id }, 'primary'),
      action(t, 'archive', t('home.band.archive'), p.name, { type: 'project.resolve', id: p.id, action: { kind: 'archive' } }),
      action(t, 'unlink', t('home.band.unlink'), p.name, { type: 'project.resolve', id: p.id, action: { kind: 'unlink' } }, 'ghost'),
    ],
  });
  return { id: 'unresolved', label: t('home.band.unresolved'), icon: 'folder', tone: 'warn', count: lost.length, summary: t('home.band.unresolvedSummary'), morning: false, rows: lost.map(row) };
}

/**
 * 他の PC から届いたトースト（Mediator の arrivedProjects）の件数。
 * 覚えてある id のうち、いまも他の PC から届いたままのもの（決めたり消えたりしたものは外す）を数える。
 */
export function arrivedCount(store: Store, ids: string[]): number {
  return ids.filter((id) => {
    const p = store.projects[id];
    return p !== undefined && counted(p, 'elsewhere');
  }).length;
}

/**
 * 「場所を再指定」のダイアログに渡すもの。
 * previousPath と deviceName は、missing ではこの PC の前のパス（PC の名前は無し）、elsewhere では他の PC のパスとその PC の名前である。
 * プロジェクトが Store に無いときは、id を名前にし、パスは持たない。
 */
export type ResolveDialogProps = { projectId: string; name: string; previousPath: string | null; elsewhere: boolean; deviceName: string | null };

export function presentResolveDialog(store: Store, projectId: string): ResolveDialogProps {
  const p = store.projects[projectId];
  if (!p) return { projectId, name: projectId, previousPath: null, elsewhere: false, deviceName: null };
  const kind = unresolvedKind(p);
  return { projectId, name: p.name, previousPath: p.unresolved ? p.unresolved.previousPath : p.path, elsewhere: kind === 'elsewhere', deviceName: p.unresolved?.deviceName ?? null };
}
