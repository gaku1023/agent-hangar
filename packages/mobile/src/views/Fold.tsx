import type { ReactNode } from 'react';
import { phaseClass, type Present } from '../presence.ts';

/** 出入りの段階の箱。中の .fold-in が高さの補間の間だけはみ出しを隠す（styles.css）。 */
export function Fold({ phase, children, className = '' }: { phase: Present<unknown>['phase']; children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={`fold ${phaseClass(phase)} ${className}`} aria-hidden={phase === 'leave' ? true : undefined}>
      <div className="fold-in">
        <div className="fold-pad">{children}</div>
      </div>
    </div>
  );
}

/** 載ったときに、高さを伸ばして現れる箱（m-grow）。消すときは外すだけ。 */
export function Reveal({ children, className = '' }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <Fold phase="enter" className={className}>
      {children}
    </Fold>
  );
}
