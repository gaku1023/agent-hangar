import { useId, useState, type ReactNode } from 'react';
import type { ProjectRailSection } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { InstructionsPanel } from './InstructionsPanel.tsx';
import { PageHeading } from './PageHeading.tsx';
import { ProjectInfo } from './ProjectInfo.tsx';
import { FoldBox } from './primitives/FoldBox.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { StatusSelect } from './primitives/StatusSelect.tsx';
import { SessionList } from './SessionList.tsx';
import { TodoList } from './TodoList.tsx';
import { RollingNumber } from './primitives/RollingNumber.tsx';

/**
 * 1 つのプロジェクトの画面（Q3、左右に割る）。
 * 左は、ホームと同じ部品（ステータスのタブ、検索の欄、平らな行、ページ送り）で、このプロジェクトのセッションだけを出す。
 * 右パネルは TODO（見出しに確認待ちの数）、指示とメモリ、アーティファクトで、パネルごと閉じられ、節ごとにも折りたためる。
 * 画面は窓の高さに収め、左の一覧が残りの高さを受け取り、右パネルは 1 本でスクロールする（workbench.css）。
 * 見出しの (i) に、場所、セッションの数、最後の活動と、場所や名前を直す操作を置く。
 * スクラッチの擬似プロジェクトは実体のパスを持たないので、状態と外部で開く操作を出さない。
 */
/** アーティファクトの節で、はじめに出す件数（新しい方から）。残りは「すべて表示」で広げる。 */
const ARTIFACT_LIMIT = 3;

/**
 * 右パネルの 1 つの節（A1）。見出しの左のシェブロンを押すと中身を折りたたみ、見出しだけの札になる。件数と確認待ちの札は見出しに残る。
 * 折りたたんだ節はプロジェクトごとに覚える（project.railFold、mediator/projectRail.ts）。
 * 中身は FoldBox で growIn と collapseOut で出入りし、折りたたみの間も外さない（TODO の欄の書きかけを残す）。
 * 見出しは右パネルのスクロールの間も節の上に留まる（workbench.css の .rail-h）。
 */
function RailSection(props: { section: ProjectRailSection; title: string; aside?: ReactNode; folded: readonly ProjectRailSection[]; projectId: string; children: ReactNode }) {
  const emit = useEmit();
  const bodyId = useId();
  const open = !props.folded.includes(props.section);
  return (
    <section className="rail-panel" data-open={open ? 'true' : undefined}>
      <h2 className="rail-h">
        <button type="button" className="rail-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => emit({ type: 'project.railFold', id: props.projectId, section: props.section, open: !open })}>
          <Icon name="chevron" /><span className="rail-title">{props.title}</span>{props.aside}
        </button>
      </h2>
      <FoldBox open={open} keep id={bodyId} className="rail-body">{props.children}</FoldBox>
    </section>
  );
}

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
          <RailSection section="todo" title={t('projectScreen.rail.todo')} folded={props.railFolded} projectId={props.id}
            aside={<><span className="rail-n num"><RollingNumber value={props.todos.length} /></span>{props.pendingTodos > 0 && <span className="sessions-tab-n" data-hot="true">{t('projectScreen.rail.pending', { n: props.pendingTodos })}</span>}</>}>
            <TodoList projectId={props.id} todos={props.todos} done={props.doneTodos} suggestions={props.suggestions} />
          </RailSection>
          <RailSection section="instructions" title={t('projectScreen.rail.instructions')} folded={props.railFolded} projectId={props.id}>
            <InstructionsPanel projectId={props.id} instructions={props.instructions} />
          </RailSection>
          <RailSection section="artifacts" title={t('projectScreen.rail.artifacts')} folded={props.railFolded} projectId={props.id} aside={<span className="rail-n num">{props.artifacts.length}</span>}>
            {/* 広げた「すべて表示」は覚えないので、プロジェクトが替わったら作り直して 3 件に戻す。 */}
            <ArtifactCards key={props.id} projectId={props.id} artifacts={props.artifacts} canAdd addError={props.artifactAddError} limit={ARTIFACT_LIMIT} />
          </RailSection>
        </aside>
      )}
    </div>
  );
}
