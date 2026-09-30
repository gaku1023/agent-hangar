import type { ProjectStatus } from '@agent-hangar/shared';
import { Icon } from './Icon.tsx';
import { Listbox } from './Listbox.tsx';
import type { ListboxOption } from './listboxModel.ts';

const STATUS_OPTIONS: ListboxOption[] = [
  { value: 'active', label: 'active', sub: 'いま進めている', subKind: 'prose', status: 'active' },
  { value: 'paused', label: 'paused', sub: 'いったん止めている', subKind: 'prose', status: 'paused' },
  { value: 'done', label: 'done', sub: 'やり終えた', subKind: 'prose', status: 'done' },
  { value: 'archived', label: 'archived', sub: '一覧の奥へしまう', subKind: 'prose', status: 'archived' },
];

/**
 * プロジェクトのステータスを選ぶ部品。
 * 札（文字、その右の丸、矢印）を Listbox の顔にし、開くと色の点とひとことの意味を並べる。色は札の data-status から CSS が引く。
 * カードの中に置かれるので、クリックとキー入力は親へ伝えない。一覧は portal に描くが、React の木では札の子として泡立つので、ここで止まる。
 */
export function StatusSelect(props: { label: string; value: ProjectStatus; onChange: (status: ProjectStatus) => void }) {
  return (
    <span className="status-host" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Listbox label={props.label} value={props.value} options={STATUS_OPTIONS} onChange={(v) => props.onChange(v as ProjectStatus)} minWidth={220} align="end"
        faceClassName="status-pill" faceProps={{ 'data-status': props.value }}
        renderFace={() => <><span className="status-text">{props.value}</span><ProjectStatusDot status={props.value} /><Icon name="chevronDown" /></>} />
    </span>
  );
}

/** ステータスの色の点。隣に文字があるので飾りとして読み上げから外す。 */
export function ProjectStatusDot(props: { status: ProjectStatus }) {
  return <span className="st-dot" data-status={props.status} aria-hidden="true" />;
}
