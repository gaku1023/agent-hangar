import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { MemoEditor } from './MemoEditor.tsx';
import { SessionRows } from './SessionRows.tsx';
import { TodoList } from './TodoList.tsx';
import { Icon } from './primitives/Icon.tsx';
import { StatusSelect } from './primitives/StatusSelect.tsx';

/**
 * プロジェクト詳細画面。
 * 右レールは TODO とメモとアーティファクトで、折りたためる。
 * スクラッチの擬似プロジェクトは実体のパスを持たないので、ステータスと外部で開く操作を出さない。
 */
export function ProjectScreen(props: ProjectProps) {
  const emit = useEmit();
  const [railOpen, setRailOpen] = useState(true);
  if (props.notFound) return <div className="screen"><div className="empty">プロジェクトが見つかりません</div></div>;
  return (
    <div className="screen project-screen" data-rail={railOpen ? 'open' : 'closed'}>
      <div className="project-main">
        <div className="project-head">
          <h1 className="h1" style={{ margin: 0 }}>{props.name}</h1>
          {!props.isScratch && <StatusSelect label="ステータス" value={props.status} onChange={(status) => emit({ type: 'project.setStatus', id: props.id, status })} />}
          <span className="spacer" />
          {props.isScratch
            ? <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="add" />スクラッチで始める</button>
            : <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', projectId: props.id })}><Icon name="add" />新規セッション</button>}
          {!props.isScratch && <button className="btn" onClick={() => emit({ type: 'project.openEditor', id: props.id })}><Icon name="openEditor" />VS Code で開く</button>}
          {!props.isScratch && <button className="btn" onClick={() => emit({ type: 'project.openTerminalApp', id: props.id })}><Icon name="openTerminal" />ターミナルで開く</button>}
          <button className="btn" aria-label={railOpen ? '右レールを隠す' : '右レールを出す'} onClick={() => setRailOpen(!railOpen)}><Icon name={railOpen ? 'paneClose' : 'paneOpen'} /></button>
        </div>
        <div className="mono faint project-path">{props.path ?? 'この端末にパスがありません'}{!props.resolved && props.path ? '（見つかりません）' : ''}</div>
        <SessionRows rows={props.sessions} height="calc(100vh - 200px)" showProject={false} />
      </div>
      {railOpen && (
        <aside className="rail">
          <section><h2 className="h2" style={{ marginTop: 0 }}>TODO</h2><TodoList projectId={props.id} todos={props.todos} /></section>
          <section><h2 className="h2">メモ</h2><MemoEditor projectId={props.id} markdown={props.memo?.markdown ?? ''} updatedAt={props.memo?.updatedAt ?? 0} /></section>
          <section><h2 className="h2">アーティファクト</h2><ArtifactCards projectId={props.id} artifacts={props.artifacts} canAdd /></section>
        </aside>
      )}
    </div>
  );
}
