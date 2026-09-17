import type { ReactNode } from 'react';
export function Fold(props: { summary: ReactNode; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; className?: string }) {
  return (
    <details className={`fold ${props.className ?? ''}`} open={props.open} onToggle={(e) => props.onToggle?.((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="fold-head"><span className="fold-arrow">▸</span>{props.summary}</summary>
      {props.children}
    </details>
  );
}
