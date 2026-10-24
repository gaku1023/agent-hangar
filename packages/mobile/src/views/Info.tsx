import { useCallback, useId, useState, type ReactNode } from 'react';
import { usePresence } from '../presence.ts';
import { Fold } from './Fold.tsx';

/** ⓘ の開き閉じ。InfoButton と InfoPanel に同じものを渡して結ぶ。 */
export type InfoState = { open: boolean; id: string; toggle: () => void };

export function useInfo(): InfoState {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = useCallback(() => setOpen((v) => !v), []);
  return { open, id, toggle };
}

/**
 * 見出しの横の ⓘ。押す的は 44px 四方で、見た目の丸は小さい（styles.css の .info-btn）。
 * label は読み上げの名前（「接続の説明」など）。見出しの名前に混ざらないよう、見出しの外に置く。
 */
export function InfoButton({ info, label }: { info: InfoState; label: string }): ReactNode {
  return (
    <button type="button" className="info-btn" aria-label={label} aria-expanded={info.open} aria-controls={info.id} onClick={info.toggle}>
      <i aria-hidden="true">i</i>
    </button>
  );
}

const ON = ['info'];
const OFF: string[] = [];

/**
 * ⓘ で開く説明。見出しのすぐ下に置くと、その場で伸びて開き（m-grow）、もう一度押すと畳む（m-collapse）。
 * 長さと曲線は styles.css のトークンに従い、動きを減らす設定では動かさない。
 */
export function InfoPanel({ info, children, className = '' }: { info: InfoState; children: ReactNode; className?: string }): ReactNode {
  const shown = usePresence(info.open ? ON : OFF, (k) => k);
  return (
    <div id={info.id} className={`info-panel ${className}`}>
      {shown.map((s) => (
        <Fold key={s.key} phase={s.phase} className="info-fold">
          <div className="info-body">{children}</div>
        </Fold>
      ))}
    </div>
  );
}
