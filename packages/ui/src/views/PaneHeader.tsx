import type { ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { PaneId } from '@agent-hangar/shared';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { MenuButton, type MenuItem } from './primitives/MenuButton.tsx';

/** SessionScreen が variant="pane" のときに受け取る、ペインの見え方。tight と tiny は PaneCell が幅から決める。 */
export type PaneView = { id: PaneId; toc: boolean; tight: boolean; tiny: boolean; zoomed: boolean };

/**
 * ペインの小さな見出し（案 A）。点、名前、プロジェクト名、一言、ステータスの札、主の操作、⋯、ⓘ、☰、✕ を 1 行に並べる。
 * 幅で畳む：tight（620px 未満）は一言とプロジェクト名と主の操作の文字を消し、
 * tiny（420px 未満）はステータスの札の文字も消し、主の操作と ⓘ を ⋯ の中へ移す（呼び出し側が渡す形を替える）。
 * data-pane-header は T3 のドラッグ（見出しをつかんで動かす）と T4 の右クリックのつなぎ目である。
 * 最大化中だけ、✕ の隣に解除のボタンを出す。
 */
export function PaneHeader(props: {
  pane: PaneView;
  title: string;
  /** プロジェクト名。無ければ null。 */
  project: string | null;
  lead: ReactNode;
  badges?: ReactNode;
  oneLiner: string | null;
  /** ステータスの札。出さないときは null。 */
  status: ReactNode;
  /** 主の操作のボタン。tiny では null で、代わりに menu の先頭に入る。 */
  primary: ReactNode;
  menu: MenuItem[];
  /** ⓘ。tiny では null。 */
  info: ReactNode;
}) {
  const emit = useEmit();
  const t = useT();
  const { pane } = props;
  const tocLabel = pane.toc ? t('pane.toc.close') : t('pane.toc.open');
  return (
    <div className="pane-head" data-pane-header={pane.id} role="group" aria-label={t('pane.header.label', { name: props.title })}>
      {props.lead}
      <span className="pane-head-title" title={props.title}>{props.title}</span>
      {props.project && !pane.tight && <span className="pane-head-project" title={props.project}>{props.project}</span>}
      {props.badges}
      {props.oneLiner && !pane.tight ? <span key={props.oneLiner} className="pane-head-oneliner" title={props.oneLiner}>{props.oneLiner}</span> : <span className="spacer" />}
      <span className="pane-head-ctl" data-slot="status">{props.status}</span>
      <span className="pane-head-ctl" data-slot="more">
        {props.primary}
        <MenuButton label={t('session.screen.moreActions')} items={props.menu} />
        {props.info}
      </span>
      <span className="pane-head-sep" aria-hidden="true" />
      <button type="button" className="btn btn-icon btn-ghost pane-head-btn" data-pane-toc={pane.id} aria-pressed={pane.toc} aria-label={tocLabel} title={tocLabel} onClick={() => emit({ type: 'pane.toc', pane: pane.id })}><Icon name={pane.toc ? 'paneClose' : 'paneOpen'} /></button>
      {pane.zoomed && <button type="button" className="btn btn-icon btn-ghost pane-head-btn" data-pane-unzoom={pane.id} aria-label={t('pane.header.unzoom')} title={t('pane.header.unzoom')} onClick={() => emit({ type: 'pane.zoom', pane: pane.id })}><Icon name="restore" /></button>}
      <button type="button" className="btn btn-icon btn-ghost pane-head-btn" data-pane-remove={pane.id} aria-label={t('pane.header.remove')} title={t('pane.header.remove')} onClick={() => emit({ type: 'pane.remove', pane: pane.id })}><Icon name="close" /></button>
    </div>
  );
}

/** 空のペインの見出し。名前の代わりに「空のペイン」を出し、操作は ✕（と最大化中の解除）だけにする。 */
export function EmptyPaneHeader(props: { pane: PaneView }) {
  const emit = useEmit();
  const t = useT();
  const { pane } = props;
  return (
    <div className="pane-head" data-pane-header={pane.id} data-empty="true" role="group" aria-label={t('pane.empty.title')}>
      <span className="pane-head-title">{t('pane.empty.title')}</span>
      <span className="spacer" />
      {pane.zoomed && <button type="button" className="btn btn-icon btn-ghost pane-head-btn" data-pane-unzoom={pane.id} aria-label={t('pane.header.unzoom')} title={t('pane.header.unzoom')} onClick={() => emit({ type: 'pane.zoom', pane: pane.id })}><Icon name="restore" /></button>}
      <button type="button" className="btn btn-icon btn-ghost pane-head-btn" data-pane-remove={pane.id} aria-label={t('pane.header.remove')} title={t('pane.header.remove')} onClick={() => emit({ type: 'pane.remove', pane: pane.id })}><Icon name="close" /></button>
    </div>
  );
}
