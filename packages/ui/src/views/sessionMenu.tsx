import type { PaneId, Translate } from '@agent-hangar/shared';
import { createContext, useCallback, useContext } from 'react';
import { useEmit, type Emit } from '../action/chain.tsx';
import { sessionMenuEntries, type SessionMenuEntry, type SessionMenuProps } from '../presenters/sessionMenu.ts';
import { useT } from './primitives/language.tsx';
import { MenuPop, type MenuAnchor, type MenuCloseHow, type MenuItem } from './primitives/MenuButton.tsx';

/** メニューの幅。「この PC で再開」の押せない理由は長いので、そのときだけ広げる。 */
export const sessionMenuWidth = (m: SessionMenuProps): number => (m.resumeHere ? 300 : 260);

/**
 * セッションのメニュー（1A）の項目を、MenuButton と MenuPop の項目にする。
 * 項目の並びと中身は presenters/sessionMenu.ts の sessionMenuEntries が決め、ここは押したときに送るだけにする。
 */
export function sessionMenuItems(t: Translate, m: SessionMenuProps, emit: Emit): MenuItem[] {
  return sessionMenuEntries(t, m).map((e) => menuItemOf(e, emit));
}

/** 項目 1 つを、MenuButton と MenuPop の項目にする。ペインの右クリックも同じ形で使う。 */
export function menuItemOf(e: SessionMenuEntry, emit: Emit): MenuItem {
  return {
    key: e.key,
    label: e.label,
    disabled: e.disabled,
    onSelect: () => { if (e.send) emit(e.send); },
    ...(e.icon ? { icon: e.icon } : {}),
    ...(e.kbd ? { kbd: e.kbd } : {}),
    ...(e.danger ? { danger: true } : {}),
    ...(e.separatorBefore ? { separatorBefore: true } : {}),
    ...(e.checked !== undefined ? { checked: e.checked } : {}),
    ...(e.dot ? { lead: <span className="st-dot" data-status={e.dot} aria-hidden="true" /> } : {}),
  };
}

/**
 * セッションがいま分割の木のどのペインにあるか。木に無ければ null。
 * 一覧とサイドバーのメニューが、先頭に「表示中のペインへ移動」を出すかどうかを決めるのに使う（Root が木から作る）。
 * ペインが 2 つ以上のときだけ値を返し、1 つのあいだは常に null にする。
 */
export const PaneOfContext = createContext<(sessionId: string) => PaneId | null>(() => null);
export const usePaneOf = () => useContext(PaneOfContext);

/** 右クリックした点に吊るす矩形（幅 0）。 */
export const pointAnchor = (x: number, y: number): MenuAnchor => ({ top: y, bottom: y, left: x, width: 0 });
/** 要素に吊るす矩形（打鍵 . で開いたとき）。 */
export const boxAnchor = (el: Element): MenuAnchor => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, width: b.width }; };

/**
 * ボタンを持たずに開くセッションのメニュー（右クリックした点、打鍵 . で開いた行）。
 * 開け閉めとフォーカスの戻し先は呼んだ側が持つ。
 */
export function SessionMenuPop(props: { menu: SessionMenuProps; at: MenuAnchor; align?: 'start' | 'end'; onClose: (how: MenuCloseHow) => void }) {
  const t = useT();
  const emit = useEmit();
  const paneOf = usePaneOf();
  const { at } = props;
  const anchor = useCallback(() => at, [at]);
  return <MenuPop label={t('row.menu.label', { name: props.menu.name })} items={sessionMenuItems(t, { ...props.menu, pane: paneOf(props.menu.id) }, emit)} anchor={anchor} minWidth={sessionMenuWidth(props.menu)} align={props.align ?? 'start'} onClose={props.onClose} />;
}
