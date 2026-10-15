import type { ProjectStatus } from '@agent-hangar/shared';
import { useId } from 'react';
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
 * isolate（既定は true）では、クリックとキー入力を親へ伝えない。プロジェクト画面ではカードの中に置かれ、押しでカードを開かせないためである。
 * 一覧は portal に描くが、React の木では札の子として泡立つので、ここで止まる。
 * セッション画面は isolate={false} で渡す。止めると、window で泡立ちを受ける全体のショートカット（⌘K、Esc など）まで届かなくなるからである。
 * auto は hangar が自動で付けた状態の印（文字の頭に ✦）で、title はその理由。ツールチップに出し、隠し要素で札の読み上げの説明にも入れる。どちらもセッションの札だけが渡す。
 * onReselect は、いまの値と同じ行を選び直したときに呼ぶ（Paused の選び直しで戻る日を決め直すため）。
 */
export function StatusSelect(props: { label: string; value: ProjectStatus; onChange: (status: ProjectStatus) => void; onReselect?: (status: ProjectStatus) => void; auto?: boolean; title?: string; isolate?: boolean }) {
  const t = useT();
  const titleId = useId();
  const options: ListboxOption[] = STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], sub: t(HINT_KEY[s]), subKind: 'prose', status: s }));
  const stop = props.isolate === false ? undefined : (e: { stopPropagation: () => void }) => e.stopPropagation();
  const onReselect = props.onReselect;
  return (
    <span className="status-host" title={props.title} onClick={stop} onKeyDown={stop}>
      <Listbox label={props.label} value={props.value} options={options} onChange={(v) => props.onChange(v as ProjectStatus)} minWidth={220} align="end"
        onReselect={onReselect ? (v) => onReselect(v as ProjectStatus) : undefined} describedBy={props.title ? titleId : undefined}
        faceClassName="status-pill" faceProps={props.auto ? { 'data-status': props.value, 'data-auto': 'true' } : { 'data-status': props.value }}
        renderFace={() => <>{props.auto && <Icon name="autoMark" />}<span className="status-text">{STATUS_LABEL[props.value]}</span><ProjectStatusDot status={props.value} /><Icon name="chevronDown" /></>} />
      {props.title && <span id={titleId} hidden>{props.title}</span>}
    </span>
  );
}

/** 状態の色の点。隣に文字があるので飾りとして読み上げから外す。 */
export function ProjectStatusDot(props: { status: ProjectStatus }) {
  return <span className="st-dot" data-status={props.status} aria-hidden="true" />;
}
