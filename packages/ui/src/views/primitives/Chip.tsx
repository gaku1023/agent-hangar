import { useEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { useT } from './language.tsx';

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

type ButtonProps = ComponentPropsWithRef<'button'>;

/**
 * 数の札。名前と件数を小さな札に畳む（帯の錠剤、いまの列、TODO の見出し、帯と冒頭の 1 枚、目次の要修正）。
 * onClick があればボタン、無ければ読むだけの札で、ボタンにしない。
 * expanded を渡すと開閉の札になり、aria-expanded を出して矢印を向ける（閉じていれば右、開いていれば下）。
 * 読み上げの名前は見える文字（名前と件数）のままにし、開閉は aria-expanded に言わせる。
 * lead を渡すと、アイコンの代わりに名前の前へ置く（サブエージェントの札の、状態の灯）。
 * 数が 0 なら薄く（data-zero）、tone は件数の色（wait は入力待ちの赤茶、cand は確認待ちの紫）、size の sm は小さい札である。
 * Popover の開く元にもなるので、ボタンの属性と ref をそのまま受ける。
 */
export function CountChip(props: { label: string; count: number; icon?: IconName; lead?: ReactNode; tone?: 'default' | 'wait' | 'cand'; size?: 'md' | 'sm'; expanded?: boolean } & Omit<ButtonProps, 'children' | 'className'>) {
  const { label, count, icon, lead, tone = 'default', size = 'md', expanded, onClick, ...rest } = props;
  const body = (
    <>
      {lead ?? (icon && <Icon name={icon} />)}
      <span>{label}</span>{' '}
      <b data-count="true">{count}</b>
      {expanded !== undefined && <Icon name={expanded ? 'chevronDown' : 'chevron'} />}
    </>
  );
  const marks = { className: 'count-chip', 'data-tone': tone, 'data-size': size, 'data-zero': count === 0 ? 'true' : undefined } as const;
  if (!onClick) return <span {...marks}>{body}</span>;
  return <button type="button" {...rest} {...marks} aria-expanded={expanded ?? rest['aria-expanded']} onClick={onClick}>{body}</button>;
}

/**
 * 設定の札。値を札に見せ、押すと小さい一覧が開く（新しいセッションの札の列）。
 * 開く先は呼んだ側が決める（Popover、Listbox の面）。ここはボタンの属性と ref を受けるだけの顔である。
 * name は項目の名前で、読み上げの名前は「名前、値」にする。showName なら名前も札に見せる（「モデル opus」）。
 * tone の muted は既定のまま（値が薄い）、danger は赤い縁（Bypass permissions）。開いている間（aria-expanded）は青い縁である。
 */
export function SettingChip(props: { name: string; value: string; icon?: IconName; showName?: boolean; tone?: 'default' | 'muted' | 'danger' } & Omit<ButtonProps, 'children' | 'className' | 'aria-label'>) {
  const { name, value, icon, showName, tone = 'default', ...rest } = props;
  const t = useT();
  return (
    <button type="button" {...rest} className="set-chip" data-tone={tone} aria-label={t('common.chip.nameValue', { name, value })}>
      {icon && <Icon name={icon} />}
      {showName && <span className="set-chip-name">{name}</span>}
      <span className="set-chip-value">{value}</span>
      <Icon name="chevronDown" />
    </button>
  );
}
