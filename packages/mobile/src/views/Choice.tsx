import type { ReactNode } from 'react';

type Props = {
  checked: boolean;
  onPick: () => void;
  title: string;
  sub?: string;
  dot?: string | null;
  value?: string;
  danger?: boolean;
  small?: boolean;
  /** 題名の左の絵（エージェントのアイコン）。名前は題名で足りるので、読み上げからは外す。 */
  icon?: ReactNode;
  /** 題名の右の小札（「ベータ」）。 */
  badge?: string;
  /** 題名の下に説明を置く（モデルの札。プロバイダーと費用の型を添える）。 */
  stack?: boolean;
};

export function Choice({ checked, onPick, title, sub, dot, value, danger, small, icon, badge, stack }: Props): ReactNode {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-value={value}
      className={`choice ${checked ? 'on' : ''} ${danger ? 'danger' : ''} ${small ? 'sm' : ''} ${stack ? 'stack' : ''}`}
      onClick={onPick}
    >
      {dot !== undefined && <span className="acct-dot" style={dot ? { background: dot } : undefined} aria-hidden="true" />}
      {icon !== undefined && <span aria-hidden="true">{icon}</span>}
      <span className="choice-title">
        {title}
        {badge && <span className="beta">{badge}</span>}
      </span>
      {sub && <span className="choice-sub">{sub}</span>}
    </button>
  );
}
