import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.tsx';
import { place, type Placement } from './listboxModel.ts';

/**
 * メニューの 1 項目。
 * disabled は押せない理由で、押せる項目では null か省く。押せない項目も消さずに並べ、理由を 1 行添える。
 * note は押せる項目に添える補足の 1 行。danger は取り消せない操作で、区切りの後ろに危険色で置く。
 */
export type MenuItem = { key: string; label: string; icon?: IconName; note?: string | null; disabled?: string | null; danger?: boolean; onSelect: () => void };

/**
 * 押すと開くガラスのメニュー（WAI-ARIA の menu ボタンの作法）。
 * ボタンの ↓ と Enter と Space は最初の項目、↑ は最後の項目を開いてフォーカスする。
 * 開いている間は ↑ ↓ で項目を移り（端では反対の端へ回る）、Home と End で端へ、Enter と Space で選ぶ。
 * Esc は閉じてボタンへフォーカスを戻し、Tab と外を押したときは閉じるだけにする。
 * 押せない項目にもフォーカスは止まる。理由を読めるようにするためである。
 * 面は document.body への portal に描く。見出しの段やカードの overflow で切られないようにするため。
 */
export function MenuButton(props: { label: string; items: MenuItem[]; face?: ReactNode; faceClassName?: string; title?: string; minWidth?: number; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState<null | 'first' | 'last'>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  const face = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const uid = useId();
  const menuId = `${uid}-menu`;
  const { minWidth = 280, align = 'end' } = props;

  const rows = () => [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const show = (from: 'first' | 'last') => { setPos(null); setOpen(from); };
  const hide = (refocus: boolean) => {
    setOpen(null);
    setPos(null);
    if (refocus) face.current?.focus();
  };

  const reposition = useCallback(() => {
    if (!face.current || !pop.current) return;
    const r = face.current.getBoundingClientRect();
    setPos(place({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, pop.current.offsetHeight, { width: window.innerWidth, height: window.innerHeight }, { minWidth, align }));
  }, [minWidth, align]);
  useLayoutEffect(() => { if (open) reposition(); }, [open, reposition]);

  // 位置が決まって見えてから、開くたびに一度だけ端の項目へフォーカスを送る。
  const ready = open !== null && pos !== null;
  useLayoutEffect(() => {
    if (!ready) return;
    const all = rows();
    (open === 'last' ? all[all.length - 1] : all[0])?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || face.current?.contains(t)) return;
      hide(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reposition]);

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    hide(true);
    item.onSelect();
  };

  const onFaceKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const from = e.key === 'ArrowUp' ? 'last' : e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ' ? 'first' : null;
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    show(from);
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = rows();
    // キーを受けた項目から数える。フォーカスの位置と打鍵の宛先はふつう同じだが、宛先の方を信じる。
    const at = all.indexOf((e.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]') as HTMLElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    switch (e.key) {
      case 'ArrowDown': go(at + 1); break;
      case 'ArrowUp': go(at < 0 ? all.length - 1 : at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(all.length - 1); break;
      case 'Escape': hide(true); break;
      case 'Enter': case ' ': { const item = props.items[at]; if (item) choose(item); break; }
      // Tab はボタンへ戻してから既定の動きに任せ、ボタンの次へ進ませる。
      case 'Tab': hide(true); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const firstDanger = props.items.findIndex((i) => i.danger);
  return (
    <>
      <button ref={face} type="button" className={props.faceClassName ?? 'btn btn-icon'} aria-label={props.face === undefined ? props.label : undefined} title={props.title ?? (props.face === undefined ? props.label : undefined)}
        aria-haspopup="menu" aria-expanded={open !== null} aria-controls={open ? menuId : undefined}
        onClick={() => (open ? hide(false) : show('first'))} onKeyDown={onFaceKey}>
        {props.face ?? <Icon name="more" />}
      </button>
      {open && createPortal(
        <div ref={pop} id={menuId} role="menu" aria-label={props.label} className="menu-pop" data-up={pos?.up ? 'true' : undefined} onKeyDown={onMenuKey}
          style={pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden', left: 0, top: 0 }}>
          {props.items.map((item, i) => (
            <Fragment key={item.key}>
              {i === firstDanger && i > 0 && <div role="separator" className="menu-sep" />}
              <button type="button" role="menuitem" tabIndex={-1} className="menu-item" aria-disabled={item.disabled ? 'true' : undefined} data-danger={item.danger ? 'true' : undefined}
                onClick={() => choose(item)}>
                {item.icon && <Icon name={item.icon} />}
                <span className="menu-item-text">
                  <span>{item.label}</span>
                  {(item.disabled || item.note) && <small>{item.disabled ?? item.note}</small>}
                </span>
              </button>
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
