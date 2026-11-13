import type { ConfigKindMode } from '@agent-hangar/shared';
import { useT } from './primitives/language.tsx';

/**
 * 切、確認、自動の切り替え。つまみは横へ滑り（transform の transition、長さと曲線は --dur と --ease-out）、色が替わる。
 * 会話の本文は切と自動の 2 つだけ（two）。束の中が揃っていないときは mixed で、つまみを消す。
 * 手元と相手を選ぶときは options を渡して語を替える（初回の突き合わせ、競合）。
 */
export type TriOption<V extends string> = { value: V; label: string };

export function TriSwitch<V extends string>(props: { label: string; value: V | 'mixed'; options: readonly TriOption<V>[]; tone?: string; onChange: (v: V) => void; disabled?: boolean }) {
  const idx = props.options.findIndex((o) => o.value === props.value);
  return (
    <span className="tri" role="group" aria-label={props.label} data-s={props.tone ?? props.value} data-n={props.options.length} data-mixed={idx < 0 ? '' : undefined}>
      <span className="tri-thumb" style={{ ['--i' as string]: Math.max(0, idx) }} aria-hidden="true" />
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} disabled={props.disabled} onClick={() => { if (o.value !== props.value) props.onChange(o.value); }}>{o.label}</button>
      ))}
    </span>
  );
}

/** 種類の状態（切、確認、自動）の切り替え。two は切と自動だけ。 */
export function KindModeSwitch(props: { label: string; value: ConfigKindMode | 'mixed'; two?: boolean; onChange: (v: ConfigKindMode) => void }) {
  const t = useT();
  const all: readonly TriOption<ConfigKindMode>[] = [{ value: 'off', label: t('configKindsUi.mode.off') }, { value: 'confirm', label: t('configKindsUi.mode.confirm') }, { value: 'auto', label: t('configKindsUi.mode.auto') }];
  return <TriSwitch label={props.label} value={props.value} options={props.two ? all.filter((o) => o.value !== 'confirm') : all} onChange={props.onChange} />;
}
