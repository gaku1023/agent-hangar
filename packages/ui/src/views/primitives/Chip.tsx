import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon.tsx';

/** 押すと灯るチップ。表示の切り替えに使う。見える文字は短くし、読み上げの名前は label で渡す。 */
export function ToggleChip(props: { label: string; text: string; icon?: IconName; pressed: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" className="chip" aria-label={props.label} aria-pressed={props.pressed} onClick={() => props.onChange(!props.pressed)}>
      {props.icon && <Icon name={props.icon} />}{props.text}
    </button>
  );
}

export type ChoiceChip = { value: string; label: string };

/**
 * 択一のチップ。other を渡すと末尾に「ほか」を置き、押すとその場で入力欄に変わる。
 * 選択肢に無い値は入力欄で出す。入力欄にいる間はどのチップにも印を付けない。
 */
export function ChoiceChips(props: { label: string; value: string; options: ChoiceChip[]; onChange: (value: string) => void; other?: { label: string; placeholder: string } }) {
  const known = props.options.some((o) => o.value === props.value);
  const [otherOpen, setOtherOpen] = useState(!known);
  const input = useRef<HTMLInputElement>(null);
  // 利用者が「ほか」を押したときだけ入力欄へフォーカスを移す。最初から入力欄で出すときは奪わない。
  const focusNext = useRef(false);
  const inOther = !!props.other && (otherOpen || !known);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    input.current?.focus();
  });
  return (
    <div className="chips" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" role="radio" className="chip" aria-checked={!inOther && o.value === props.value}
          onClick={() => { setOtherOpen(false); if (inOther || o.value !== props.value) props.onChange(o.value); }}>{o.label}</button>
      ))}
      {props.other && (inOther
        ? <span className="chip chip-input" data-on="true"><input ref={input} aria-label={props.other.placeholder} placeholder={props.other.placeholder} value={props.value} onChange={(e) => props.onChange(e.target.value)} /></span>
        : <button type="button" className="chip" onClick={() => { focusNext.current = true; setOtherOpen(true); props.onChange(''); }}><Icon name="edit" />{props.other.label}</button>)}
    </div>
  );
}
