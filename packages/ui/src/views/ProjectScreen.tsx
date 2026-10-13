import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ProjectRailSection } from '@agent-hangar/shared';
import { useBackgroundEmit, useEmit } from '../action/chain.tsx';
import type { ProjectProps } from '../presenters/project.ts';
import { ArtifactCards } from './ArtifactCards.tsx';
import { InstructionsPanel } from './InstructionsPanel.tsx';
import { PageHeading } from './PageHeading.tsx';
import { ProjectInfo } from './ProjectInfo.tsx';
import { FoldBox } from './primitives/FoldBox.tsx';
import { PANE_SHAPE, playPaneMotion } from './primitives/paneMotion.ts';
import { usePresence } from './primitives/usePresence.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { useEditorLabels } from './primitives/editorName.tsx';
import { StatusSelect } from './primitives/StatusSelect.tsx';
import { SessionList } from './SessionList.tsx';
import { TodoList } from './TodoList.tsx';
import { RollingNumber } from './primitives/RollingNumber.tsx';
import { GitChip } from './GitChip.tsx';
import { GitUnsafeNote } from './GitUnsafeNote.tsx';
import type { ProjectGitProps } from '../presenters/git.ts';

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

/**
 * 右パネルの「ブランチと worktree」（試作の 2-4 の B）。元の作業ツリーと、git worktree で足した作業ツリーを 1 行ずつ並べ、
 * 未コミットの件数、ブランチ、そこで実行中のセッションの数を出す。消すのは hangar ではしない。
 */
function GitRail(props: { git: ProjectGitProps }) {
  const t = useT();
  const g = props.git;
  if (g.state === 'loading') return <div className="faint">{t('gitUi.rail.loading')}</div>;
  if (g.state === 'nogit') return <div className="faint">{t('gitUi.rail.noGit')}</div>;
  if (g.state === 'noPath') return <div className="faint">{t('gitUi.rail.noPath')}</div>;
  if (g.state === 'missing') return <div className="faint">{t('gitUi.rail.missing')}</div>;
  if (g.state === 'unsafe') return g.fix ? <GitUnsafeNote command={g.fix} /> : <div className="faint">{t('gitUi.details.unsafe')}</div>;
  return (
    <div className="git-rail">
      <ul className="git-rail-list">
        {g.rows.map((r) => (
          <li key={r.key} className="git-rail-row" title={r.path}>
            <span className="git-rail-1"><Icon name={r.worktree ? 'worktree' : 'branch'} /><span className="mono git-rail-name">{r.name}</span><span className="spacer" />{r.value !== '' && <span className={r.dirty ? 'gitchip-val num' : 'gitchip-val gitchip-quiet num'}>{r.value}</span>}</span>
            <span className="git-rail-2 faint"><span className="mono">{r.branch}</span> · {r.sessions}</span>
          </li>
        ))}
      </ul>
      <div className="faint git-rail-note"><Icon name="info" />{t('gitUi.rail.note')}</div>
    </div>
  );
}

/**
 * 1 つのプロジェクトの画面（Q3、左右に割る）。
 * 左は、ホームと同じ部品（ステータスのタブ、検索の欄、平らな行、ページ送り）で、このプロジェクトのセッションだけを出す。
 * 右パネルは TODO（見出しに確認待ちの数）、指示とメモリ、アーティファクトで、パネルごと閉じられ、節ごとにも折りたためる。
 * 画面は窓の高さに収め、左の一覧が残りの高さを受け取り、右パネルは 1 本でスクロールする（workbench.css）。
 * 右パネルの開閉は、セッション画面の右の列と同じ動き（paneMotion）で、右の列の幅を縮め（広げ）て左の一覧を滑らかに広げる（戻す）。
 * 閉じる間は中身を描き続け、薄れてから外す。開閉の形は画面の中だけで持ち、覚えない。
 * 見出しの (i) に、場所、セッションの数、最後の活動と、場所や名前を直す操作を置く。
 * スクラッチの擬似プロジェクトは実体のパスを持たないので、状態と外部で開く操作を出さない。
 */
export function ProjectScreen(props: ProjectProps) {
  const emit = useEmit();
  const t = useT();
  const editorLabels = useEditorLabels();
  const [railOpen, setRailOpen] = useState(true);
  // ブランチと worktree は、画面を開いたときとプロジェクトを替えたときに読む（git の表示）。
  // 開いたままの間は、ランタイムが git の表示の周期と窓が前に戻ったときに読み直す（runtime の reloadProjectGit）。
  // この PC にパスの無いプロジェクト（他の PC から同期したもの）は読まない。読む先が無く、右パネルは presenter が「この PC にパスが無い」にする。
  const bg = useBackgroundEmit();
  const hasPath = props.path !== null;
  useEffect(() => { if (!props.isScratch && !props.notFound && hasPath) bg({ type: 'project.git.load', projectId: props.id }); }, [bg, props.id, props.isScratch, props.notFound, hasPath]);
  const boxRef = useRef<HTMLDivElement>(null);
  const pane = usePresence<HTMLElement>(railOpen, (inner) => (boxRef.current ? playPaneMotion(boxRef.current, PANE_SHAPE.rail.open, inner, false) : null));
  const paneFirst = useRef(true);
  useLayoutEffect(() => {
    if (paneFirst.current) { paneFirst.current = false; return; }
    if (railOpen && boxRef.current) void playPaneMotion(boxRef.current, PANE_SHAPE.rail.closed, pane.ref.current, true);
    // 開閉が替わったときだけ動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railOpen]);
  if (props.notFound) return <div className="screen"><div className="empty">{t('projectScreen.page.notFound')}</div></div>;
  const noPath = props.path === null ? { 'aria-disabled': true, title: t('projectScreen.open.noPath') } : null;
  const loadMore = props.loadMore ? { ...props.loadMore, onLoad: () => emit({ type: 'search.more' }) } : undefined;
  return (
    <div ref={boxRef} className="screen project-screen screen-fill" data-rail={railOpen ? 'open' : 'closed'}
      style={{ gridTemplateColumns: railOpen ? PANE_SHAPE.rail.open.cols : PANE_SHAPE.rail.closed.cols, columnGap: railOpen ? undefined : PANE_SHAPE.rail.closed.gap }}>
      {/* 見出しは左の列に入れず、1 行目で両方の列にかける（workbench.css）。右パネルの開閉のボタンは行の右端で、右パネルの右上の角に重なる。
          閉じて左の一覧が広がっても、ボタンは同じ場所に残り、そこで開き直せる（セッション画面の右の列と同じ考え方）。 */}
      <PageHeading title={props.name} parent={props.parent}>
        {!props.isScratch && <StatusSelect label={t('projectScreen.status.label')} value={props.status} onChange={(status) => emit({ type: 'project.setStatus', id: props.id, status })} />}
        <span className="spacer" />
        {/* 新しいセッションの主ボタンはヘッダーにあり、この画面ではこのプロジェクトを最初から選ぶ（presenters/newSession.ts）。同じ主ボタンを見出しの行にも並べない。
            スクラッチは別の入口なので残す。 */}
        {props.isScratch && <button className="btn btn-primary" onClick={() => emit({ type: 'session.new.open', scratch: true })}><Icon name="add" /><span className="btn-label">{t('projectScreen.quick.start')}</span></button>}
        {/* この PC にパスが無いと、開く先が無い（サーバも断る）。押せない形にして、乗せると理由が出るよう disabled ではなく aria-disabled にする。 */}
        {!props.isScratch && <button className="btn" {...noPath} onClick={() => { if (!noPath) emit({ type: 'project.openEditor', id: props.id }); }}><Icon name="openEditor" /><span className="btn-label">{editorLabels.open}</span></button>}
        {!props.isScratch && <button className="btn" {...noPath} onClick={() => { if (!noPath) emit({ type: 'project.openTerminalApp', id: props.id }); }}><Icon name="openTerminal" /><span className="btn-label">{t('projectScreen.open.terminal')}</span></button>}
        <ProjectInfo id={props.id} name={props.name} path={props.path} isScratch={props.isScratch} info={props.info} />
        <button className="btn" aria-label={railOpen ? t('projectScreen.rail.close') : t('projectScreen.rail.open')} onClick={() => setRailOpen(!railOpen)}><Icon name={railOpen ? 'paneClose' : 'paneOpen'} /></button>
      </PageHeading>
      <div className="project-main">
        <div className="project-path">
          <span className="mono faint">{props.path ?? t('projectScreen.path.none')}</span>
          {/* ルートのブランチと件数（試作の 2-4 の A）。場所の情報の隣に置き、見出しの行は増やさない。 */}
          {props.git?.root && <GitChip id={`proj:${props.id}`} chip={props.git.root} />}
          {/* パスはあるが、この PC で見つからない。押すと場所の再指定へ進む（プロジェクトの一覧の赤い札と同じ入口）。 */}
          {!props.resolved && props.path !== null && (
            <button type="button" className="project-path-warn" onClick={() => emit({ type: 'project.resolve.open', id: props.id })}><Icon name="warning" />{t('projectScreen.path.missing')}</button>
          )}
          {/* この PC で同じフォルダを場所にしている別のプロジェクトがある（直す前の版の残り）。同じパスで再指定を送ると、サーバの 409 からまとめる確認が開く。 */}
          {props.sameFolder && props.path !== null && (
            <button type="button" className="project-path-warn" onClick={() => emit({ type: 'project.resolve', id: props.id, action: { kind: 'repoint', path: props.path! } })}><Icon name="warning" />{t('projectScreen.path.sameFolder', { name: props.sameFolder.name })}</button>
          )}
        </div>
        <SessionList {...props.list} projectFixed loadMore={loadMore} empty={props.list.allCount === 0 && props.list.total === 0 && props.list.mode === 'all' ? <div className="empty">{t('projectScreen.list.empty')}</div> : undefined} />
      </div>
      {/* 右の列。閉じると幅 0 になり、中身（.rail）は閉じる動きが終わってから外す。 */}
      <div className="rail-slot" data-leaving={pane.leaving ? 'true' : undefined}>
      {pane.mounted && (
        // プロジェクトが替わったら作り直す。覚えた折りたたみの形でそのまま出し（開閉の動きを出さない）、スクロールも先頭から始める。
        <aside key={props.id} ref={(el) => { pane.ref.current = el; }} className="rail">
          <RailSection section="todo" title={t('projectScreen.rail.todo')} folded={props.railFolded} projectId={props.id}
            aside={<><span className="rail-n num"><RollingNumber value={props.todos.length} /></span>{props.pendingTodos > 0 && <span className="sessions-tab-n" data-hot="true">{t('projectScreen.rail.pending', { n: props.pendingTodos })}</span>}</>}>
            <TodoList projectId={props.id} todos={props.todos} done={props.doneTodos} suggestions={props.suggestions} />
          </RailSection>
          <RailSection section="instructions" title={t('projectScreen.rail.instructions')} folded={props.railFolded} projectId={props.id}>
            <InstructionsPanel projectId={props.id} instructions={props.instructions} />
          </RailSection>
          <RailSection section="artifacts" title={t('projectScreen.rail.artifacts')} folded={props.railFolded} projectId={props.id} aside={<span className="rail-n num">{props.artifacts.length}</span>}>
            {/* 広げた「すべて表示」は覚えないので、プロジェクトが替わると（パネルごと作り直して）3 件に戻る。 */}
            <ArtifactCards projectId={props.id} artifacts={props.artifacts} canAdd addError={props.artifactAddError} limit={ARTIFACT_LIMIT} />
          </RailSection>
          {!props.isScratch && props.git && (
            <RailSection section="git" title={t('gitUi.rail.title')} folded={props.railFolded} projectId={props.id}>
              <GitRail git={props.git} />
            </RailSection>
          )}
        </aside>
      )}
      </div>
    </div>
  );
}
