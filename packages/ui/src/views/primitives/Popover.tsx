import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.tsx';
import { useT } from './language.tsx';
import { place, type Placement } from './listboxModel.ts';

/** 開く元のボタンが受け取る属性。`<button {...p}>` のように広げて使う。 */
export type PopoverFaceProps = {
  ref: RefObject<HTMLButtonElement | null>;
  'aria-haspopup': 'dialog';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
};

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 押すと開く、読むための小さな面（非モーダルの dialog）。
 * メニュー（MenuButton）と違い、中は項目の並びではなく自由な中身で、読むだけのものも、ノートの欄のような入力も置ける。
 * (i) の詳細、ノートの札、数の札から開く一覧に使う。
 * 開く元は face で描く。渡された属性を広げるだけで、ボタンでも札（CountChip、SettingChip）でもよい。
 * 開くと面へ焦点が入る。中に data-autofocus の要素があれば、そこへ入る。
 * Esc は閉じて焦点を開く元へ戻す（外へは伝えない。下のダイアログまで閉じないため）。
 * 外側を押すと閉じる。焦点が行き場を失ったとき（空きを押したとき）だけ開く元へ戻し、別の欄を押したときは奪わない。
 * Tab で中の端を越えたら閉じ、焦点を開く元へ戻して、そこから次へ進ませる。
 * 面は document.body への portal に描く。見出しの段やカードの overflow に切られないため。
 * 幅は width（既定 360px）で、窓の縁には place() が収める。
 */
export function Popover(props: {
  label: string;
  face: (p: PopoverFaceProps) => ReactNode;
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  width?: number;
  align?: 'start' | 'end';
  className?: string;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { width = 360, align = 'end' } = props;
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const [pos, setPos] = useState<Placement | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const popId = `${useId()}-popover`;
  const notify = useRef(props.onOpenChange);
  notify.current = props.onOpenChange;

  const change = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setPos(null);
    notify.current?.(next);
  }, []);
  /** 閉じる。refocus なら焦点を開く元へ戻す。 */
  const hide = useCallback((refocus: boolean) => {
    change(false);
    if (refocus) opener.current?.focus();
  }, [change]);

  const reposition = useCallback(() => {
    const el = opener.current;
    if (!el || !pop.current) return;
    const r = el.getBoundingClientRect();
    setPos(place({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, pop.current.offsetHeight, { width: window.innerWidth, height: window.innerHeight }, { minWidth: width, align }));
  }, [width, align]);
  useLayoutEffect(() => { if (open) reposition(); }, [open, reposition]);

  // 位置が決まって見えてから、開くたびに一度だけ焦点を送る。隠れたままの要素には焦点が入らない。
  const ready = open && pos !== null;
  useLayoutEffect(() => {
    if (!ready) return;
    (pop.current?.querySelector<HTMLElement>('[data-autofocus]') ?? pop.current)?.focus();
  }, [ready]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || opener.current?.contains(t)) return;
      hide(false);
      // 押した先に焦点が移る前（マウスの既定の動きの前）には決められない。移ったあとで、行き場を失っていたときだけ戻す。
      setTimeout(() => {
        const a = document.activeElement;
        if (!a || a === document.body) opener.current?.focus();
      }, 0);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition, hide]);

  const onPopKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(true); return; }
    if (e.key !== 'Tab') return;
    const items = [...(pop.current?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])];
    const at = document.activeElement;
    const leaving = e.shiftKey ? at === pop.current || at === items[0] || items.length === 0 : items.length === 0 || at === items[items.length - 1];
    // 既定の動きは止めない。焦点を開く元へ戻したあと、そこから次（Shift なら前）へ進む。
    if (leaving) hide(true);
  };
  const onFaceKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    e.stopPropagation();
    hide(true);
  };

  return (
    <>
      {props.face({ ref: opener, 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? popId : undefined, onClick: () => (open ? hide(false) : change(true)), onKeyDown: onFaceKey })}
      {open && createPortal(
        <div ref={pop} id={popId} role="dialog" aria-label={props.label} tabIndex={-1} className={`menu-pop popover${props.className ? ` ${props.className}` : ''}`} data-up={pos?.up ? 'true' : undefined} onKeyDown={onPopKey}
          style={pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden', left: 0, top: 0, width }}>
          {typeof props.children === 'function' ? props.children({ close: () => hide(true) }) : props.children}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 名前と値の 1 行。mono は値を等幅で描く（パス、時刻など）。 */
export type PopoverRow = { name: string; value: ReactNode; mono?: boolean };

/** 名前と値の組の一覧。dl で読ませる。 */
export function PopoverRows(props: { rows: PopoverRow[] }) {
  return (
    <dl className="pop-rows">
      {props.rows.map((r) => (
        <div key={r.name} className="pop-row">
          <dt>{r.name}</dt>
          <dd data-mono={r.mono ? 'true' : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 見出しの右端の (i)。押すと、見出しと名前と値の行の面が開く。
 * 行のあとに、操作の行など任意の中身を置ける。関数を渡すと、面を閉じる関数を受け取れる（押すとダイアログが開く操作のあとに閉じる）。
 * 名前と見出しは label（既定は「詳細」）で、画面が別の語を渡してもよい。
 */
export function InfoPopover(props: { rows: PopoverRow[]; label?: string; children?: ReactNode | ((api: { close: () => void }) => ReactNode); width?: number; defaultOpen?: boolean }) {
  const t = useT();
  const label = props.label ?? t('common.popover.details');
  return (
    <Popover label={label} width={props.width} defaultOpen={props.defaultOpen}
      face={(p) => <button type="button" className="btn btn-icon btn-ghost" aria-label={label} title={label} {...p}><Icon name="info" /></button>}>
      {(api) => (
        <>
          <h4 className="pop-title">{label}</h4>
          <PopoverRows rows={props.rows} />
          {typeof props.children === 'function' ? props.children(api) : props.children}
        </>
      )}
    </Popover>
  );
}
