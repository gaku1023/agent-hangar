import type { ReactNode } from 'react';

type Props = { checked: boolean; onPick: () => void; title: string; sub?: string; dot?: string | null; value?: string; danger?: boolean; small?: boolean };

export function Choice({ checked, onPick, title, sub, dot, value, danger, small }: Props): ReactNode {
  return (
    <button type="button" role="radio" aria-checked={checked} data-value={value} className={`choice ${checked ? 'on' : ''} ${danger ? 'danger' : ''} ${small ? 'sm' : ''}`} onClick={onPick}>
      {dot !== undefined && <span className="acct-dot" style={dot ? { background: dot } : undefined} aria-hidden="true" />}
      <span className="choice-title">{title}</span>
      {sub && <span className="choice-sub">{sub}</span>}
    </button>
  );
}
