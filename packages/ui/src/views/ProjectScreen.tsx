import { useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { EditableNote } from './EditableNote.tsx';
import { projectNoteTexts } from './NoteEditor.tsx';
import { PageHeading } from './PageHeading.tsx';
import { ProjectInfo } from './ProjectInfo.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { StatusSelect } from './primitives/StatusSelect.tsx';
import { SessionList } from './SessionList.tsx';
import { TodoList } from './TodoList.tsx';

/**
 * 1 つのプロジェクトの画面（Q3、左右に割る）。
 * 左は、ホームと同じ部品（ステータスのタブ、検索の欄、平らな行、ページ送り）で、このプロジェクトのセッションだけを出す。
 * 右パネルは TODO（見出しに確認待ちの数）、ノート、アーティファクトで、折りたためる。
 * 見出しの (i) に、場所、セッションの数、最後の活動と、場所や名前を直す操作を置く。
 * スクラッチの擬似プロジェクトは実体のパスを持たないので、状態と外部で開く操作を出さない。
 */
export function ProjectScreen(props: ProjectProps) {
  const emit = useEmit();
  const t = useT();
  const [railOpen, setRailOpen] = useState(true);
  if (props.notFound) return <div className="screen"><div className="empty">{t('projectScreen.page.notFound')}</div></div>;
  const loadMore = props.loadMore ? { ...props.loadMore, onLoad: () => emit({ type: 'search.more' }) } : undefined;
  return (
    <div className="screen project-screen screen-fill" data-rail={railOpen ? 'open' : 'closed'}>
      <div className="project-main">
        <PageHeading title={props.name} parent={props.parent}>
          {!props.isScratch && <StatusSelect label={t('projectScreen.status.label')} value={props.status} onChange={(status) => emit({ type: 'project.setStatus', id: props.id, status })} />}
          <span className="spacer" />
          {/* 新しいセッションの主ボタンはヘッダーにあり、この画面ではこのプロジェクトを最初から選ぶ（presenters/newSession.ts）。同じ主ボタンを見出しの行にも並べない。
              スクラッチは別の入口なので残す。 */}
          {props.isScratch && <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="add" /><span className="btn-label">{t('projectScreen.quick.start')}</span></button>}
          {!props.isScratch && <button className="btn" onClick={() => emit({ type: 'project.openEditor', id: props.id })}><Icon name="openEditor" /><span className="btn-label">{t('projectScreen.open.editor')}</span></button>}
          {!props.isScratch && <button className="btn" onClick={() => emit({ type: 'project.openTerminalApp', id: props.id })}><Icon name="openTerminal" /><span className="btn-label">{t('projectScreen.open.terminal')}</span></button>}
          <ProjectInfo id={props.id} name={props.name} path={props.path} isScratch={props.isScratch} info={props.info} />
          <button className="btn" aria-label={railOpen ? t('projectScreen.rail.close') : t('projectScreen.rail.open')} onClick={() => setRailOpen(!railOpen)}><Icon name={railOpen ? 'paneClose' : 'paneOpen'} /></button>
        </PageHeading>
        <div className="project-path">
          <span className="mono faint">{props.path ?? t('projectScreen.path.none')}</span>
          {/* パスはあるが、この PC で見つからない。押すと場所の再指定へ進む（プロジェクトの一覧の赤い札と同じ入口）。 */}
          {!props.resolved && props.path !== null && (
            <button type="button" className="project-path-warn" onClick={() => emit({ type: 'project.resolve.open', id: props.id })}><Icon name="warning" />{t('projectScreen.path.missing')}</button>
          )}
        </div>
        <SessionList {...props.list} projectFixed loadMore={loadMore} empty={props.list.allCount === 0 && props.list.total === 0 && props.list.mode === 'all' ? <div className="empty">{t('projectScreen.list.empty')}</div> : undefined} />
      </div>
      {railOpen && (
        <aside className="rail">
          <section className="rail-panel">
            <h2 className="rail-h"><span>{t('projectScreen.rail.todo')}</span><span className="rail-n num">{props.todos.length}</span>{props.pendingTodos > 0 && <span className="sessions-tab-n" data-hot="true">{t('projectScreen.rail.pending', { n: props.pendingTodos })}</span>}</h2>
            <TodoList projectId={props.id} todos={props.todos} />
          </section>
          <section className="rail-panel">
            <EditableNote text={props.note.text} onSave={(markdown) => emit({ type: 'memo.save', projectId: props.id, markdown })} texts={projectNoteTexts(t)} mono rows={6}
              head={(button) => <div className="rail-head"><h2 className="rail-h"><span>{t('projectScreen.rail.note')}</span></h2>{button}</div>} />
          </section>
          <section className="rail-panel">
            <h2 className="rail-h"><span>{t('projectScreen.rail.artifacts')}</span><span className="rail-n num">{props.artifacts.length}</span></h2>
            <ArtifactCards projectId={props.id} artifacts={props.artifacts} canAdd />
          </section>
        </aside>
      )}
    </div>
  );
}
