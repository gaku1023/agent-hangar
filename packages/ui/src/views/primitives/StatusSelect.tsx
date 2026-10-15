import type { ProjectStatus } from '@agent-hangar/shared';
import { STATUS_LABEL } from '../../presenters/format.ts';
import { Icon } from './Icon.tsx';
import { useT } from './language.tsx';
import { Listbox } from './Listbox.tsx';
import type { ListboxOption } from './listboxModel.ts';

/** 札の語（Active、Paused、Done、Archived）は定数で、ひとことの意味だけを辞書から引く。 */
const HINT_KEY = { active: 'projectScreen.status.activeHint', paused: 'projectScreen.status.pausedHint', done: 'projectScreen.status.doneHint', archived: 'projectScreen.status.archivedHint' } as const;
const STATUSES = ['active', 'paused', 'done', 'archived'] as const;

/**
 * 状態を選ぶ部品。プロジェクト画面の見出しと、セッション画面の見出し（4A、状態の無い会話は active で渡す）で使う。
 * 札（文字、その右の丸、矢印）を Listbox の顔にし、開くと色の点とひとことの意味を並べる。色は札の data-status から CSS が引く。
 * カードの中に置かれるので、クリックとキー入力は親へ伝えない。一覧は portal に描くが、React の木では札の子として泡立つので、ここで止まる。
 * auto は hangar が自動で付けた状態の印（文字の頭に ✦）で、title はその理由のツールチップ。どちらもセッションの札だけが渡す。
 */
export function StatusSelect(props: { label: string; value: ProjectStatus; onChange: (status: ProjectStatus) => void; auto?: boolean; title?: string }) {
  const t = useT();
  const options: ListboxOption[] = STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], sub: t(HINT_KEY[s]), subKind: 'prose', status: s }));
  return (
    <span className="status-host" title={props.title} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Listbox label={props.label} value={props.value} options={options} onChange={(v) => props.onChange(v as ProjectStatus)} minWidth={220} align="end"
        faceClassName="status-pill" faceProps={props.auto ? { 'data-status': props.value, 'data-auto': 'true' } : { 'data-status': props.value }}
        renderFace={() => <>{props.auto && <Icon name="autoMark" />}<span className="status-text">{STATUS_LABEL[props.value]}</span><ProjectStatusDot status={props.value} /><Icon name="chevronDown" /></>} />
    </span>
  );
}

/** 状態の色の点。隣に文字があるので飾りとして読み上げから外す。 */
export function ProjectStatusDot(props: { status: ProjectStatus }) {
  return <span className="st-dot" data-status={props.status} aria-hidden="true" />;
}
