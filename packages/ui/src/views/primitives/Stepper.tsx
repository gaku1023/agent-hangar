import { Icon } from './Icon.tsx';

/**
 * 数の入力欄を − と ＋ で挟む。入力欄はそのまま打てる number として残す。
 * 値は文字列で受け渡し、範囲の外や小数を打ったときの扱い（保存の前の案内）は呼び出し側に任せる。
 */
export function Stepper(props: { label: string; value: string; onChange: (text: string) => void; min: number; max: number; step?: number }) {
  const step = props.step ?? 1;
  const n = Number(props.value);
  const readable = props.value.trim() !== '' && Number.isFinite(n);
  const clamp = (x: number) => Math.min(props.max, Math.max(props.min, x));
  const bump = (d: number) => props.onChange(String(clamp(Math.round(readable ? clamp(n) : props.min) + d)));
  return (
    <span className="stepper">
      <button type="button" aria-label={`${props.label}を減らす`} disabled={readable && n <= props.min} onClick={() => bump(-step)}><Icon name="minus" /></button>
      <input className="stepper-input" type="number" min={props.min} max={props.max} step={step} aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <button type="button" aria-label={`${props.label}を増やす`} disabled={readable && n >= props.max} onClick={() => bump(step)}><Icon name="add" /></button>
    </span>
  );
}
