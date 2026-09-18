import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
export function Fold(props: { summary: ReactNode; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; className?: string }) {
  return (
    <details className={`fold ${props.className ?? ''}`} open={props.open} onToggle={(e) => props.onToggle?.((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="fold-head"><span className="fold-arrow"><Icon name="chevron" /></span>{props.summary}</summary>
      {props.children}
    </details>
  );
}
