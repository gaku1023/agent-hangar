import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { SessionMenuProps } from '../presenters/sessionMenu.ts';
import type { SideLiveGroup, SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import { Sidebar } from './Sidebar.tsx';

// 別の PC で動く子（案 3A）。親の下に入れ子になり、PC 名の札を持つ。結び付きが終わったら、列の線を破線にして灰色にする。

const menuOf = (id: string): SessionMenuProps => ({ id, name: `name-${id}`, status: null, resumeHere: null, stop: null, moveBlocked: null });
const row = (id: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name: `name-${id}`, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: menuOf(id), ...over });
const props = (rows: SideLiveRow[]): SideLiveProps => {
  const g: SideLiveGroup = { key: 'web', name: 'web', open: true, waiting: 0, rows };
  return { count: rows.length, ids: rows.map((r) => r.id), rows, groups: [g], pins: [] };
};
const mount = (rows: SideLiveRow[]) => render(<ActionRoot onAction={vi.fn()}><Sidebar nav={[]} foot={[]} collapsed={false} live={props(rows)} /></ActionRoot>);
const dot = { live: 'busy' as const, aside: false, reason: null };

describe('別の PC の子の行', () => {
  it('PC 名の札を持つ。同じ PC の子は持たない', () => {
    mount([row('p', { nest: { open: true, dots: [dot, dot] } }), row('c', { depth: 1, peer: { name: 'Mac', ended: false } }), row('l', { depth: 1 })]);
    expect(document.querySelector('[data-id="c"] .pc-pill')?.textContent).toBe('Mac');
    expect(document.querySelector('[data-id="l"] .pc-pill')).toBeNull();
    expect(document.querySelector('[data-id="c"]')).not.toHaveAttribute('data-peer-ended');
  });
  it('結び付きが終わった子は ended。子が全部 ended のとき、列が peer-ended になる（線を破線にして灰色にする）', () => {
    mount([row('p', { nest: { open: true, dots: [dot] } }), row('c', { depth: 1, peer: { name: 'Mac', ended: true } })]);
    expect(document.querySelector('[data-id="c"]')).toHaveAttribute('data-peer-ended', 'true');
    expect(document.querySelector('.side-live-kids')).toHaveClass('peer-ended');
  });
  it('終わっていない子がまじっていれば、列の線は実線のまま', () => {
    mount([row('p', { nest: { open: true, dots: [dot, dot] } }), row('c', { depth: 1, peer: { name: 'Mac', ended: true } }), row('d', { depth: 1, peer: { name: 'Mac', ended: false } })]);
    expect(document.querySelector('.side-live-kids')).not.toHaveClass('peer-ended');
  });
});

describe('ほかの PC で動く会話の行（ロック）', () => {
  it('札を持ち、title は PC の文言。黙った PC は stale と ended の印で、輪の点と薄い札になる', () => {
    mount([row('a', { live: 'idle', peer: { name: 'Office', ended: false }, lockTitle: 'Office で実行中' }), row('b', { live: 'idle', peer: { name: 'Home', ended: true }, stale: true, lockTitle: 'Home から応答がありません' })]);
    expect(document.querySelector('[data-id="a"]')).toHaveAttribute('title', 'Office で実行中');
    expect(document.querySelector('[data-id="a"]')).not.toHaveAttribute('data-stale');
    expect(document.querySelector('[data-id="a"] .pc-pill')).toHaveAttribute('title', 'Office');
    expect(document.querySelector('[data-id="b"]')).toHaveAttribute('data-stale', 'true');
    expect(document.querySelector('[data-id="b"]')).toHaveAttribute('data-peer-ended', 'true');
    expect(document.querySelector('[data-id="b"]')).toHaveAttribute('title', 'Home から応答がありません');
  });
});
