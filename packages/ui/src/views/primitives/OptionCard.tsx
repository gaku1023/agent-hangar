import { useId } from 'react';
import { Icon, type IconName } from './Icon.tsx';

export type OptionCardItem = { value: string; label: string; description: string; code?: string; icon: IconName; danger?: boolean };

/** 意味を添えた択一のカード。名前は label で読み、説明は aria-describedby で添える。 */
export function OptionCards(props: { label: string; value: string; options: OptionCardItem[]; onChange: (value: string) => void }) {
  const uid = useId();
  return (
    <div className="option-cards" role="radiogroup" aria-label={props.label}>
      {props.options.map((o, i) => (
        <button key={o.value} type="button" role="radio" className="option-card" aria-label={o.label} aria-describedby={`${uid}-${i}`} aria-checked={o.value === props.value} data-danger={o.danger ? 'true' : undefined}
          onClick={() => { if (o.value !== props.value) props.onChange(o.value); }}>
          <Icon name={o.icon} />
          <span className="option-card-text"><b>{o.label}</b><small id={`${uid}-${i}`}>{o.description}</small>{o.code && <code>{o.code}</code>}</span>
        </button>
      ))}
    </div>
  );
}

/** 何が起きるかを 1 行添えた、複数選択のカード。右端の四角い印が満ちてチェックが描かれる。 */
export function CheckCard(props: { label: string; description: string; icon: IconName; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <button type="button" role="checkbox" className="option-card check-card" aria-label={props.label} aria-describedby={id} aria-checked={props.checked} disabled={props.disabled} onClick={() => props.onChange(!props.checked)}>
      <Icon name={props.icon} />
      <span className="option-card-text"><b>{props.label}</b><small id={id}>{props.description}</small></span>
      <span className="check-box" aria-hidden="true"><Icon name="check" /></span>
    </button>
  );
}
