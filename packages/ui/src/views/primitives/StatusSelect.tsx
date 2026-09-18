import type { ProjectStatus } from '@agent-hangar/shared';
import { Icon } from './Icon.tsx';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

/**
 * プロジェクトのステータスを選ぶ部品。
 * 素の select の中には丸を置けないので、見た目（文字、その右の丸、矢印）は自前で描き、その上に透明な本物の select を重ねる。
 * 選択肢の一覧、キーボード操作、読み上げは select がそのまま受け持つ。色は外側の data-status から CSS が引く。
 * カードの中に置かれるので、クリックとキー入力は親へ伝えない。
 */
export function StatusSelect(props: { label: string; value: ProjectStatus; onChange: (status: ProjectStatus) => void }) {
  return (
    <span className="status-pill" data-status={props.value} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <span className="status-face" aria-hidden="true">
        <span className="status-text">{props.value}</span>
        <ProjectStatusDot status={props.value} />
        <Icon name="chevronDown" />
      </span>
      <select className="status-select" data-status={props.value} aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value as ProjectStatus)}>
        {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </span>
  );
}

/** ステータスの色の点。隣に文字があるので飾りとして読み上げから外す。 */
export function ProjectStatusDot(props: { status: ProjectStatus }) {
  return <span className="st-dot" data-status={props.status} aria-hidden="true" />;
}
