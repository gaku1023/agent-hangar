import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.tsx';
import { place, type Placement } from './listboxModel.ts';

/**
 * メニューの 1 項目。
 * disabled は押せない理由で、押せる項目では null か省く。
 * 押せない項目も消さずに並べ、理由を 1 行添える。
 * note は押せる項目に添える補足の 1 行。
 * danger は取り消せない操作で、区切りの後ろに危険色で置く。
 * kbd は打鍵の印。メニューが開いている間、その 1 字で選べる（「⋯」の p・d・a・u など）。
 */
export type MenuItem = { key: string; label: string; icon?: IconName; note?: string | null; disabled?: string | null; danger?: boolean; kbd?: string; onSelect: () => void };

export type MenuCloseHow = 'select' | 'escape' | 'tab' | 'outside';

/**
 * 押すと開くガラスのメニュー（WAI-ARIA の menu ボタンの作法）。
 * ボタンの ↓ と Enter と Space は最初の項目、↑ は最後の項目を開いてフォーカスする。
 * 開いている間は ↑ ↓ で項目を移り（端では反対の端へ回る）、Home と End で端へ、Enter と Space で選ぶ。
 * Esc は閉じてボタンへフォーカスを戻し、Tab と外を押したときは閉じるだけにする。
 * 押せない項目にもフォーカスは止まる。
 * 理由を読めるようにするためである。
 * onClose は閉じたときに、閉じ方（項目を選んだ・Esc・Tab・外を押した）を添えて呼ぶ。
 * 行の中の「⋯」のように、呼んだ側がフォーカスの戻し先を決めるのに使う。
 * head は項目の前に置く読むだけの段（提案の根拠など）。項目ではないのでフォーカスは止まらない。
 * 面は document.body への portal に描く。
 * 見出しの段やカードの overflow で切られないようにするため。
 */
export function MenuButton(props: { label: string; items: MenuItem[]; head?: ReactNode; face?: ReactNode; faceClassName?: string; title?: string; minWidth?: number; align?: 'start' | 'end'; onClose?: (how: MenuCloseHow) => void }) {
  const [open, setOpen] = useState<null | 'first' | 'last'>(null);
  const face = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const menuId = `${uid}-menu`;

  const hide = (how: MenuCloseHow) => {
    setOpen(null);
    if (how !== 'outside') face.current?.focus();
    // フォーカスをボタンへ戻したあとに呼ぶ。呼んだ側が別の場所へ戻したいときは、これで上書きできる。
    props.onClose?.(how);
  };
  const anchor = useCallback(() => face.current?.getBoundingClientRect() ?? null, []);

  const onFaceKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const from = e.key === 'ArrowUp' ? 'last' : e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ' ? 'first' : null;
    if (!from) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(from);
  };

  return (
    <>
      <button ref={face} type="button" className={props.faceClassName ?? 'btn btn-icon'} aria-label={props.face === undefined ? props.label : undefined} title={props.title ?? (props.face === undefined ? props.label : undefined)}
        aria-haspopup="menu" aria-expanded={open !== null} aria-controls={open ? menuId : undefined}
        onClick={() => (open ? hide('outside') : setOpen('first'))} onKeyDown={onFaceKey}>
        {props.face ?? <Icon name="more" />}
      </button>
      {open && <MenuPop id={menuId} label={props.label} items={props.items} head={props.head} anchor={anchor} from={open} minWidth={props.minWidth} align={props.align} ignore={face} onClose={hide} />}
    </>
  );
}

/** メニューを吊るす相手の矩形。ボタンや行ならその矩形、右クリックなら押した点（幅 0）。 */
export type MenuAnchor = { top: number; bottom: number; left: number; width: number };

/**
 * メニューの面だけ。開いている間だけ描く部品で、開け閉めは呼んだ側が持つ。
 * ボタンに吊るすとき（MenuButton）と、ボタンを持たずに右クリックした点や行に吊るすとき（サイドバーの行）の両方で使う。
 * anchor は吊るす相手の矩形を返す。窓の大きさやスクロールが変わるたびに呼び直すので、点に吊るすときは同じ値を返し続ければよい。
 * from はフォーカスを送る端。ignore は、押しても「外を押した」に数えない部品（開け閉めのボタン）。
 * 閉じるときは onClose を閉じ方と一緒に呼ぶだけで、フォーカスの戻し先は呼んだ側が決める。項目を選んだときは、閉じてから onSelect を呼ぶ。
 * 面は document.body への portal に描く。
 */
export function MenuPop(props: { id?: string; label: string; items: MenuItem[]; head?: ReactNode; anchor: () => MenuAnchor | null; from?: 'first' | 'last'; minWidth?: number; align?: 'start' | 'end'; ignore?: RefObject<HTMLElement | null>; onClose: (how: MenuCloseHow) => void }) {
  const [pos, setPos] = useState<Placement | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  const { minWidth = 280, align = 'end', from = 'first', anchor, ignore } = props;
  // 閉じ方は呼んだ側の関数で、描くたびに作り直される。外を押したときの耳を付け直さないよう、最新のものを ref に持つ。
  const close = useRef(props.onClose);
  close.current = props.onClose;

  const rows = () => [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  const reposition = useCallback(() => {
    const r = anchor();
    if (!r || !pop.current) return;
    setPos(place({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, pop.current.offsetHeight, { width: window.innerWidth, height: window.innerHeight }, { minWidth, align }));
  }, [anchor, minWidth, align]);
  useLayoutEffect(() => { reposition(); }, [reposition]);

  // 位置が決まって見えてから、一度だけ端の項目へフォーカスを送る。
  const ready = pos !== null;
  useLayoutEffect(() => {
    if (!ready) return;
    const all = rows();
    (from === 'last' ? all[all.length - 1] : all[0])?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || ignore?.current?.contains(t)) return;
      close.current('outside');
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [reposition, ignore]);

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    props.onClose('select');
    item.onSelect();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = rows();
    // キーを受けた項目から数える。
    // フォーカスの位置と打鍵の宛先はふつう同じだが、宛先の方を信じる。
    const at = all.indexOf((e.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]') as HTMLElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    switch (e.key) {
      case 'ArrowDown': go(at + 1); break;
      case 'ArrowUp': go(at < 0 ? all.length - 1 : at - 1); break;
      case 'Home': go(0); break;
      case 'End': go(all.length - 1); break;
      case 'Escape': props.onClose('escape'); break;
      case 'Enter': case ' ': { const item = props.items[at]; if (item) choose(item); break; }
      // Tab は呼んだ側がフォーカスを戻してから既定の動きに任せ、その次へ進ませる。
      case 'Tab': props.onClose('tab'); return;
      default: {
        // 打鍵の印のある項目は、その 1 字で選ぶ。修飾の付いた打鍵はアプリ全体のものなので使わない。
        const hit = !e.metaKey && !e.ctrlKey && !e.altKey ? props.items.find((it) => it.kbd !== undefined && it.kbd === e.key) : undefined;
        if (!hit) return;
        choose(hit);
        break;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const firstDanger = props.items.findIndex((i) => i.danger);
  return createPortal(
    <div ref={pop} id={props.id} role="menu" aria-label={props.label} className="menu-pop" data-up={pos?.up ? 'true' : undefined} onKeyDown={onMenuKey}
      style={pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden', left: 0, top: 0 }}>
      {props.head && <div className="menu-head">{props.head}</div>}
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
            {item.kbd && <kbd className="menu-kbd">{item.kbd}</kbd>}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
