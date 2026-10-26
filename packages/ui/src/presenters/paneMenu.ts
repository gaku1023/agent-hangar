import type { PaneId, SessionStatus, Translate } from '@agent-hangar/shared';
import { statusEntries, type SessionMenuEntry } from './sessionMenu.ts';

/** ペインの見出しの右クリックに要るもの。空のペインは sessionId が null で、ステータスと ID のコピーを出さない。 */
export type PaneMenuProps = { pane: PaneId; sessionId: string | null; status: SessionStatus | null; zoomed: boolean };

/**
 * ペインの見出しの右クリックの項目（試作の paneMenu）。
 * ステータス（サブメニュー）、ID をコピー、区切り、最大化か解除、右と下に空のペインを開く、サイズを均等にする、区切り、分割から外す、ほかのペインを外す、の順に置く。
 * 右クリックしたペインは、押した時点で操作中になっている（PaneCell の pointerdown）。
 * 空のペインを右と下に開く入力（pane.openEmpty）は操作中のペインの隣に開くので、押したペインの隣になる。
 */
export function paneMenuEntries(t: Translate, m: PaneMenuProps): SessionMenuEntry[] {
  const out: SessionMenuEntry[] = [];
  if (m.sessionId) {
    out.push({ key: 'status', label: t('pane.menu.status'), icon: 'chevron', disabled: null, send: null, sub: statusEntries(m.sessionId, m.status) });
    out.push({ key: 'copyId', label: t('session.action.copyId'), icon: 'copy', disabled: null, send: { type: 'session.copyId', id: m.sessionId } });
  }
  out.push(
    { key: 'zoom', label: m.zoomed ? t('pane.header.unzoom') : t('pane.menu.zoom'), icon: m.zoomed ? 'restore' : 'maximize', separatorBefore: m.sessionId !== null, disabled: null, send: { type: 'pane.zoom', pane: m.pane } },
    { key: 'newRight', label: t('pane.menu.newRight'), icon: 'splitRight', disabled: null, send: { type: 'pane.openEmpty', side: 'right' } },
    { key: 'newDown', label: t('pane.menu.newDown'), icon: 'splitDown', disabled: null, send: { type: 'pane.openEmpty', side: 'down' } },
    { key: 'equalize', label: t('pane.menu.equalize'), disabled: null, send: { type: 'pane.equalize' } },
    { key: 'unsplit', label: t('pane.header.remove'), icon: 'close', separatorBefore: true, disabled: null, send: { type: 'pane.remove', pane: m.pane } },
    { key: 'closeOthers', label: t('pane.menu.closeOthers'), disabled: null, send: { type: 'pane.removeOthers', pane: m.pane } },
  );
  return out;
}
