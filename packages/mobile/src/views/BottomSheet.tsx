import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useSheetPhase } from '../presence.ts';

type Props = {
  open: boolean;
  title: string;
  /** 右上の文字。無ければ右上に出さない（確認のシートのように、閉じる操作を中に持つとき）。 */
  closeText?: string;
  /** 読み上げの名前。画面の文字を含めること。 */
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * 下から出るシート。背景（scrim）をタップするか、右上の文字で閉じる。
 * 閉じるときは下がって消える（動きを減らす設定ではすぐ外す）。
 */
export function BottomSheet({ open, title, closeText, closeLabel, onClose, children }: Props): ReactNode {
  const { mounted, leaving } = useSheetPhase(open);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mounted && !leaving) ref.current?.focus({ preventScroll: true });
    // 開いたときだけ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);
  if (!mounted) return null;
  return (
    <>
      <div className={`scrim ${leaving ? 'leaving' : ''}`} data-testid="sheet-scrim" onClick={onClose} />
      <div ref={ref} className={`bsheet ${leaving ? 'leaving' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} inert={leaving}>
        <div className="grab" aria-hidden="true" />
        <header className="bs-head">
          <span aria-hidden="true" />
          <h2 className="bs-title" id={id}>
            {title}
          </h2>
          {closeText ? (
            <button type="button" className="bs-close" aria-label={closeLabel} onClick={onClose}>
              {closeText}
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
        </header>
        <div className="bs-body">{children}</div>
      </div>
    </>
  );
}
