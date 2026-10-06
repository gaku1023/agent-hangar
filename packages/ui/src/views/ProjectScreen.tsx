import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { projectPageKey } from '../mediator/paging.ts';
import type { ProjectProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { MemoEditor } from './MemoEditor.tsx';
import { PageHeading } from './PageHeading.tsx';
import { Pager } from './Pager.tsx';
import { SessionRows } from './SessionRows.tsx';
import { TodoList } from './TodoList.tsx';
import { Icon } from './primitives/Icon.tsx';
import { StatusSelect } from './primitives/StatusSelect.tsx';

/**
 * プロジェクト詳細画面。
 * 右レールは TODO とメモとアーティファクトで、折りたためる。
 * スクラッチの擬似プロジェクトは実体のパスを持たないので、状態と外部で開く操作を出さない。
 */
export function ProjectScreen(props: ProjectProps) {
  const emit = useEmit();
  const [railOpen, setRailOpen] = useState(true);
  if (props.notFound) return <div className="screen"><div className="empty">プロジェクトが見つかりません</div></div>;
  return (
    <div className="screen project-screen screen-fill" data-rail={railOpen ? 'open' : 'closed'}>
      <div className="project-main">
        <PageHeading title={props.name} parent={props.parent}>
          {!props.isScratch && <StatusSelect label="状態" value={props.status} onChange={(status) => emit({ type: 'project.setStatus', id: props.id, status })} />}
          <span className="spacer" />
          {/* 新しいセッションの主ボタンはヘッダーにあり、この画面ではこのプロジェクトを最初から選ぶ（presenters/newSession.ts）。同じ主ボタンを見出しの行にも並べない。
              スクラッチは別の入口なので残す。 */}
          {props.isScratch && <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="add" /><span className="btn-label">スクラッチで始める</span></button>}
          {!props.isScratch && <button className="btn" onClick={() => emit({ type: 'project.openEditor', id: props.id })}><Icon name="openEditor" /><span className="btn-label">VS Code で開く</span></button>}
          {!props.isScratch && <button className="btn" onClick={() => emit({ type: 'project.openTerminalApp', id: props.id })}><Icon name="openTerminal" /><span className="btn-label">ターミナルで開く</span></button>}
          <button className="btn" aria-label={railOpen ? '右の欄を閉じる' : '右の欄を開く'} onClick={() => setRailOpen(!railOpen)}><Icon name={railOpen ? 'paneClose' : 'paneOpen'} /></button>
        </PageHeading>
        <div className="mono faint project-path">{props.path ?? 'この PC にパスがありません'}{!props.resolved && props.path ? '（見つかりません）' : ''}</div>
        {/* 見出しの「ほか N 件」と Archived の「表示」は、このプロジェクトの節をその場で広げる。 */}
        <SessionRows items={props.items} variant="project" page={props.pager?.page} moreIntent={(target) => (target === 'archived' ? { type: 'project.section.toggle', projectId: props.id, section: target } : null)} />
        {/* 広げた節が長いときだけ、その行をページに分ける。 */}
        {props.pager && <Pager label="セッション" pager={props.pager} onPage={(page) => emit({ type: 'list.page', key: projectPageKey(props.id), page })} onSize={(size) => emit({ type: 'list.pageSize', size })} />}
      </div>
      {railOpen && (
        <aside className="rail">
          <section className="rail-panel"><h2 className="h2" style={{ marginTop: 0 }}>TODO</h2><TodoList projectId={props.id} todos={props.todos} /></section>
          <section className="rail-panel"><h2 className="h2">メモ</h2><MemoEditor projectId={props.id} markdown={props.memo?.markdown ?? ''} updatedAt={props.memo?.updatedAt ?? 0} /></section>
          <section className="rail-panel"><h2 className="h2">アーティファクト</h2><ArtifactCards projectId={props.id} artifacts={props.artifacts} canAdd /></section>
        </aside>
      )}
    </div>
  );
}
