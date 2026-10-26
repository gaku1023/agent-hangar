import { describe, expect, it } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { paneMenuEntries, type PaneMenuProps } from './paneMenu.ts';

const ja = translator('ja');
const en = translator('en');
const base = (over: Partial<PaneMenuProps> = {}): PaneMenuProps => ({ pane: 'p1', sessionId: 's1', status: null, zoomed: false, ...over });

describe('ペインの見出しの右クリック（paneMenuEntries）', () => {
  it('ステータス、ID をコピー、最大化、右と下に空のペイン、均等、分割から外す、ほかを外すの順に並べる', () => {
    expect(paneMenuEntries(ja, base()).map((e) => [e.key, e.label])).toEqual([
      ['status', 'ステータス'], ['copyId', 'セッション ID をコピー'], ['zoom', 'ペインを最大化'], ['newRight', '右に空のペインを開く'], ['newDown', '下に空のペインを開く'],
      ['equalize', 'ペインのサイズを均等にする'], ['unsplit', '分割から外す'], ['closeOthers', 'ほかのペインを外す'],
    ]);
  });
  it('各項目が出す入力。ペインの id を持つ項目は、右クリックしたペインの id を渡す', () => {
    const sends = Object.fromEntries(paneMenuEntries(ja, base({ pane: 'p9' })).map((e) => [e.key, e.send]));
    expect(sends).toMatchObject({
      status: null,
      copyId: { type: 'session.copyId', id: 's1' },
      zoom: { type: 'pane.zoom', pane: 'p9' },
      newRight: { type: 'pane.openEmpty', side: 'right' },
      newDown: { type: 'pane.openEmpty', side: 'down' },
      equalize: { type: 'pane.equalize' },
      unsplit: { type: 'pane.remove', pane: 'p9' },
      closeOthers: { type: 'pane.removeOthers', pane: 'p9' },
    });
  });
  it('ステータスはサブメニューで、状態の 4 つにいまの状態の ✓ を付ける', () => {
    const status = paneMenuEntries(ja, base({ status: 'done' })).find((e) => e.key === 'status')!;
    expect(status.sub!.map((e) => [e.label, e.checked])).toEqual([['Active', false], ['Paused', false], ['Done', true], ['Archived', false]]);
    expect(status.sub!.find((e) => e.key === 'archived')!.send).toEqual({ type: 'session.state.set', id: 's1', status: 'archived' });
  });
  it('最大化中は「最大化を解除」になる', () => {
    expect(paneMenuEntries(ja, base({ zoomed: true })).find((e) => e.key === 'zoom')!.label).toBe('最大化を解除');
    expect(paneMenuEntries(en, base({ zoomed: true })).find((e) => e.key === 'zoom')!.label).toBe('Restore');
    expect(paneMenuEntries(en, base()).find((e) => e.key === 'zoom')!.label).toBe('Maximize Pane');
  });
  it('空のペインはステータスと ID のコピーを出さない', () => {
    expect(paneMenuEntries(ja, base({ sessionId: null })).map((e) => e.key)).toEqual(['zoom', 'newRight', 'newDown', 'equalize', 'unsplit', 'closeOthers']);
  });
});
