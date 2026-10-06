import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEmit } from '../intent/chain.tsx';
import { isPickableAccount, switchLabel, type AccountView } from '../presenters/accounts.ts';
import type { HeaderAccountProps } from '../presenters/shell.ts';
import { AccountMeters } from './primitives/AccountMeters.tsx';
import { place, type Placement } from './primitives/listboxModel.ts';
import { foldAt } from './headerFold.ts';

/** 開いた先の幅。 */
const WIDTH = 380;
/** 設定の画面の、アカウントの節への道。着くと、その節が見える位置へ移る。 */
const SETTINGS = { name: 'settings', at: 'accounts' } as const;

/**
 * ヘッダのアカウントの切り替え。
 * 色の点、名前、計器（children）、▾ の全体が 1 つのボタンで、押すとアカウントの一覧が開く。
 * ヘッダは窓を掴む領域なので、押す部品はボタンにする。
 * 一覧はアカウントごとに 1 枚の札で、選ぶと、ホームなら「いまのアカウント」を、セッション画面ならそのセッションのアカウントを替える。
 * いまの札を押しても何も出さず、閉じるだけにする。未ログインの札と初めてのログインの途中の札は押せない（右上は空で、理由は札の中身が言う）。ログインし直しの途中の札は、いまのログインが生きているので押せる。
 * 開くたびに accounts.load を出し、認証を読み直させる。
 * 面は document.body への portal に描く（ヘッダの重なりに切られないため）。
 * 位置は place() で決め、Esc と外側の押下で閉じる。Esc ではボタンへフォーカスを戻す。
 */
export function AccountSwitcher(props: { account: NonNullable<HeaderAccountProps>; children: ReactNode }) {
  const { shown, list, sessionId, working } = props.account;
  const emit = useEmit();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const face = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const popId = `${useId()}-accounts`;

  const show = () => { setPos(null); setOpen(true); emit({ type: 'accounts.load' }); };
  const hide = (refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) face.current?.focus();
  };

  const reposition = useCallback(() => {
    if (!face.current || !pop.current) return;
    const r = face.current.getBoundingClientRect();
    setPos(place({ top: r.top, bottom: r.bottom, left: r.left, width: r.width }, pop.current.offsetHeight, { width: window.innerWidth, height: window.innerHeight }, { minWidth: WIDTH, align: 'end' }));
  }, []);
  useLayoutEffect(() => { if (open) reposition(); }, [open, reposition]);

  // 位置が決まって見えてから、開くたびに一度だけ、shown の札へフォーカスを送る。
  const ready = open && pos !== null;
  useLayoutEffect(() => {
    if (!ready) return;
    pop.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
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
  }, [open, reposition]);

  // 選べない札（isPickableAccount）は、押しても切り替えられない。shown の札だけは、押すと閉じるので除く。
  const blocked = (a: AccountView) => !isPickableAccount(a) && a.id !== shown.id;
  const choose = (a: AccountView) => {
    if (blocked(a)) return;
    hide(true);
    if (a.id === shown.id) return;
    emit(sessionId === null ? { type: 'account.choose', accountId: a.id } : { type: 'account.switchSession', sessionId, accountId: a.id, working });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const cards = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (cards.length === 0) return;
    e.preventDefault();
    const at = cards.indexOf((e.target as HTMLElement).closest<HTMLElement>('[role="menuitemradio"]') as HTMLElement);
    const next = e.key === 'ArrowDown' ? at + 1 : at < 0 ? cards.length - 1 : at - 1;
    cards[(next + cards.length) % cards.length]!.focus();
  };

  return (
    <>
      <button ref={face} type="button" className="account-switch" aria-label={switchLabel(shown)} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined}
        onClick={() => (open ? hide(false) : show())}>
        <span className="st-dot account-dot" style={{ color: shown.color }} aria-hidden="true" />
        <span className="account-name" data-fold-at={foldAt('account-name')}>{shown.name}</span>
        {props.children}
        <span className="account-caret" aria-hidden="true">▾</span>
      </button>
      {open && createPortal(
        <div ref={pop} id={popId} role="dialog" aria-label="アカウントを切り替える" tabIndex={-1} className="menu-pop account-pop" data-up={pos?.up ? 'true' : undefined} onKeyDown={onKey}
          style={pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom } : { visibility: 'hidden', left: 0, top: 0, width: WIDTH }}>
          <div role="menu" aria-label="アカウント" className="account-cards">
            {list.map((a) => {
              const isShown = a.id === shown.id;
              const disabled = blocked(a);
              return (
                <button key={a.id} type="button" role="menuitemradio" aria-checked={isShown} aria-disabled={disabled ? 'true' : undefined} className="account-card" onClick={() => choose(a)}>
                  {/* 押せない札の右上は空にする。理由は札の中身（メールの行）が言う。 */}
                  {!disabled && <span className="account-card-tag" data-kind={isShown ? 'shown' : 'go'}>{isShown ? (sessionId === null ? 'いまのアカウント' : 'このセッション') : '切り替える'}</span>}
                  <AccountMeters account={a} showResets />
                </button>
              );
            })}
          </div>
          <div className="account-pop-foot">
            <button type="button" className="account-settings" onClick={() => { hide(true); emit({ type: 'nav.go', to: SETTINGS }); }}>アカウントの設定</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
