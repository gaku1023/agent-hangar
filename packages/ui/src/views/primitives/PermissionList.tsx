import { useT } from './language.tsx';
import { PERMISSION_BYPASS, PERMISSION_MODES, permissionLabel } from './permissionModel.ts';
import { PickList, type PickItem } from './PickList.tsx';

/**
 * 権限モードの縦の一覧（新しいセッションの N2）。
 * 既定、Plan、Manual、Accept edits、Auto、Don't ask の順に並べ、線の下に Bypass permissions を赤い字と警告の印で置く。
 * 説明の文は添えず、並びの順と線と色で伝える。確認のダイアログも足さない。
 * 名前は英語のままで、既定だけが言語で替わる。previous は前回の値で、その行に「前回」を添える。
 * 選んでいる値には check を出す。押す、または Enter で onChange を呼び、閉じるのは呼んだ側（Popover）が決める。
 */
export function PermissionList(props: { value: string; onChange: (value: string) => void; previous?: string }) {
  const t = useT();
  const items: PickItem[] = PERMISSION_MODES.map((m) => ({
    value: m.value,
    label: permissionLabel(m.value, t),
    icon: m.icon,
    tone: m.value === PERMISSION_BYPASS ? 'danger' : undefined,
    separatorBefore: m.value === PERMISSION_BYPASS,
    tag: props.previous !== undefined && m.value === props.previous ? t('launch.permission.previous') : undefined,
  }));
  return <PickList label={t('launch.permission.label')} value={props.value} items={items} onPick={props.onChange} className="permission-list" />;
}
