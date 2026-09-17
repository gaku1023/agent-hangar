import type { ProjectStatus } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import { SessionRows } from './SessionRows.tsx';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

/**
 * プロジェクト詳細画面。
 * 右レールは TODO とメモとアーティファクトの枠だけで、中身はフェーズ 3 で入る。
 * ヘッダーの操作ボタンはフェーズ 2 の Intent を出し、Mediator がトーストに変える。
 */
export function ProjectScreen(props: ProjectProps) {
  const emit = useEmit();
  if (props.notFound) return <div className="screen"><div className="empty">プロジェクトが見つかりません</div></div>;
  return (
    <div className="screen" style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <h1 className="h1" style={{ margin: 0 }}>{props.name}</h1>
          <select className="select" aria-label="ステータス" value={props.status} onChange={(e) => emit({ type: 'project.setStatus', id: props.id, status: e.target.value as ProjectStatus })}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', projectId: props.id })}>新規セッション</button>
          <button className="btn" onClick={() => emit({ type: 'session.openEditor', sessionId: '' })}>VS Code で開く</button>
          <button className="btn" onClick={() => emit({ type: 'session.openTerminalApp', runId: '' })}>ターミナルで開く</button>
        </div>
        <div className="mono faint" style={{ marginBottom: 12 }}>{props.path ?? 'この端末にパスがありません'}{!props.resolved && props.path ? '（見つかりません）' : ''}</div>
        <SessionRows rows={props.sessions} height="calc(100vh - 200px)" showProject={false} />
      </div>
      <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section><h2 className="h2" style={{ marginTop: 0 }}>TODO</h2><div className="faint">次のフェーズで使えるようになります</div></section>
        <section><h2 className="h2">メモ</h2><div className="faint">次のフェーズで使えるようになります</div></section>
        <section><h2 className="h2">アーティファクト</h2><div className="faint">次のフェーズで使えるようになります</div></section>
      </aside>
    </div>
  );
}
