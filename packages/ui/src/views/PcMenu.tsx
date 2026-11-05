import type { PeerDeviceDto } from '@agent-hangar/shared';
import { peerMark } from '../presenters/peerChoice.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import type { ListboxOption } from './primitives/listboxModel.ts';

/** 「この PC」の行の値。ほかの PC の id と重ならない。 */
const HERE = ':here';

/**
 * 新しいセッションのダイアログの、見出しの右にある PC のメニュー（案 1C）。
 * 「この PC」とほかの PC を並べ、頼めない PC（つながらない、古い版）には札の 1 語を添える。頼めない PC も選べて、そのときは起動のボタンが押せない。
 * 選んだ PC で使えない項目は、ダイアログの各札が末尾に集めて薄くする（useLaunchChoice）。
 */
export function PcMenu(props: { peers: PeerDeviceDto[]; value: string | null; onChange: (id: string | null) => void }) {
  const t = useT();
  const tagOf = (p: PeerDeviceDto): string | undefined => {
    const m = peerMark(p);
    return m === null ? undefined : t(m === 'offline' ? 'newSession.pc.offline' : 'newSession.pc.outdated');
  };
  const options: ListboxOption[] = [
    { value: HERE, label: t('newSession.pc.here'), icon: 'otherPc' },
    ...props.peers.map((p) => ({ value: p.id, label: p.name, icon: 'otherPc' as const, ...(tagOf(p) ? { tag: tagOf(p)! } : {}) })),
  ];
  return (
    <Listbox id="new-session-pc" label={t('newSession.pc.label')} value={props.value ?? HERE} options={options} onChange={(v) => props.onChange(v === HERE ? null : v)}
      minWidth={Math.max(240, ...props.peers.map((p) => p.name.length * 8 + 96))} align="end" faceClassName="set-chip pc-menu"
      renderFace={(sel) => (
        <>
          <Icon name="otherPc" /><span className="set-chip-value">{sel?.label ?? ''}</span>
          {sel?.tag && <span className="listbox-tag">{sel.tag}</span>}
          <Icon name="chevronDown" />
        </>
      )} />
  );
}
