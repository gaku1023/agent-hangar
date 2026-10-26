import { useCallback, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import { paneMenuEntries, type PaneMenuProps } from '../presenters/paneMenu.ts';
import type { SessionMenuEntry } from '../presenters/sessionMenu.ts';
import { useT } from './primitives/language.tsx';
import { MenuPop, type MenuAnchor, type MenuItem } from './primitives/MenuButton.tsx';
import { menuItemOf, pointAnchor } from './sessionMenu.tsx';

type Open = { at: MenuAnchor; view: 'main' | 'status' };

/**
 * ペインの見出しの右クリックのメニュー（試作の paneMenu）。
 * 見出しの onContextMenu に onContextMenu を渡し、node を見出しの中に置く。
 * ステータスは、押すと同じ場所に状態の 4 つを出し直すサブメニューにする（MenuPop は重ねて開く面を持たないため）。
 * 中身は presenters/paneMenu.ts の paneMenuEntries が決める。
 */
export function usePaneMenu(menu: PaneMenuProps, label: string): { onContextMenu: (e: ReactMouseEvent) => void; node: ReactNode } {
  const t = useT();
  const emit = useEmit();
  const [open, setOpen] = useState<Open | null>(null);
  const anchor = useCallback(() => open?.at ?? null, [open]);
  const onContextMenu = (e: ReactMouseEvent) => {
    // ボタンや入力欄の上は、その部品の右クリック（ブラウザの既定）に任せる。
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    e.preventDefault();
    setOpen({ at: pointAnchor(e.clientX, e.clientY), view: 'main' });
  };
  let node: ReactNode = null;
  if (open) {
    const entries = open.view === 'status' ? (paneMenuEntries(t, menu).find((x) => x.key === 'status')?.sub ?? []) : paneMenuEntries(t, menu);
    const items = entries.map((e): MenuItem => (e.sub
      // サブメニューを開く項目。MenuPop は選ぶと先に閉じるので、閉じる指示のあとに出し直す指示を重ねる（あとの指示が勝つ）。
      ? { ...menuItemOf(e, emit), onSelect: () => setOpen({ at: open.at, view: 'status' }) }
      : menuItemOf(e, emit)));
    node = <MenuPop key={open.view} label={label} items={items} anchor={anchor} minWidth={240} align="start" onClose={() => setOpen(null)} />;
  }
  return { onContextMenu, node };
}

export type { SessionMenuEntry };
