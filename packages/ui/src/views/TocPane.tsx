import type { ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { ariaKeyShortcuts, shortcutHint } from '../keys.ts';

/**
 * 目次だけの右パネル（設計書 2.3 の C）。240px の細い列で、実行中も終わった後も同じ場所に同じもの（目次）がある。
 * 「いま」の段と境目は持たない。中身（TurnIndex）は children に渡す。
 * 畳むかどうかは画面が決め、畳んでいる間は描かない（タブの列か切り替えの行の右端の「目次 N」の札に畳む）。
 */
export function TocPane(props: { children: ReactNode }) {
  const t = useT();
  return <aside className="toc-pane" aria-label={t('session.toc.label')}>{props.children}</aside>;
}

/**
 * 右パネルの開閉のボタン（⌘J と同じ `transcript.toggle`）。
 * タブの列のある画面では右の列の頭の行（タブの列と同じ高さ）の右端に、タブの列の無い画面では目次の見出しの行の右端に置く。
 * どちらも、畳んだ後の「目次 N」の札が出る右上の場所と重なる。
 * onToggle を渡すと、その関数を呼ぶ（狭い窓で、目次を上乗せの形で開閉するとき）。
 */
export function TocToggle(props: { open: boolean; onToggle?: () => void }) {
  const t = useT();
  const emit = useEmit();
  return (
    <button type="button" className="tr-toggle" aria-label={props.open ? t('session.toc.close') : t('session.toc.open')} aria-keyshortcuts={ariaKeyShortcuts('transcript.toggle')} title={t('session.toc.shortcut', { keys: shortcutHint(t, 'transcript.toggle', '⌘J') })} onClick={() => (props.onToggle ? props.onToggle() : emit({ type: 'transcript.toggle' }))}>
      <Icon name={props.open ? 'paneClose' : 'paneOpen'} />
    </button>
  );
}
