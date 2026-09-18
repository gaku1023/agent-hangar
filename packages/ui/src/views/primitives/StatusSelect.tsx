import type { ProjectStatus } from '@agent-hangar/shared';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];

/**
 * プロジェクトのステータスを選ぶ select。いまの値を data-status に出し、色は CSS がそこから引く。
 * カードの中に置かれるので、クリックとキー入力は親へ伝えない。
 */
export function StatusSelect(props: { label: string; value: ProjectStatus; onChange: (status: ProjectStatus) => void }) {
  return (
    <select className="select status-select" data-status={props.value} aria-label={props.label} value={props.value}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => props.onChange(e.target.value as ProjectStatus)}>
      {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

/** 見出しに添えるステータスの色の点。隣に文字があるので飾りとして読み上げから外す。 */
export function ProjectStatusDot(props: { status: ProjectStatus }) {
  return <span className="st-dot" data-status={props.status} aria-hidden="true" />;
}
