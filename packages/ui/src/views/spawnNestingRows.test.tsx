import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import { SessionRows } from './SessionRows.tsx';

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-09-01 10:00', filesChanged: 0, prUrl: null, hasTranscript: true, cost: '', runId: null, transcript: 'present', state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const rowsEl = (id: string) => screen.getByText('n' + id).closest('[role="row"]') as HTMLElement;
const mount = (rows: SessionRowProps[], onAction = vi.fn()) => ({ ...render(<ActionRoot onAction={onAction}><SessionRows rows={rows} height={600} variant="project" /></ActionRoot>), onAction });

describe('一覧の入れ子', () => {
  it('子の行は深さの印を持ち、字下げの幅と線の本数をそれで決める。行の高さは変えない', () => {
    mount([row('p', { nest: { depth: 0, toggle: { open: true, dots: [] } } }), row('c', { nest: { depth: 1, toggle: null } }), row('x')]);
    expect(rowsEl('c').getAttribute('data-depth')).toBe('1');
    expect(rowsEl('c').style.getPropertyValue('--depth')).toBe('1');
    expect(rowsEl('x').hasAttribute('data-depth')).toBe(false);
  });
  it('子を持つ行だけに開閉の席がある。押すと sidebar.fold を出し、行は開かない', () => {
    const { onAction } = mount([row('p', { nest: { depth: 0, toggle: { open: true, dots: [] } } }), row('c', { nest: { depth: 1, toggle: null } })]);
    expect(document.querySelectorAll('.row-fold')).toHaveLength(1);
    const btn = rowsEl('p').querySelector('.row-fold') as HTMLElement;
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.fold', key: 'spawn:p', open: false });
    expect(onAction).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.open' }));
  });
  it('畳んだ行は名前の右に子孫ごとの丸を並べる', () => {
    mount([row('p', { nest: { depth: 0, toggle: { open: false, dots: [{ live: 'busy', aside: false, reason: null }, { live: null, aside: false, reason: null }] } } })]);
    expect([...rowsEl('p').querySelectorAll('.row-kidot')].map((d) => d.getAttribute('data-status'))).toEqual(['busy', 'ended']);
    expect(rowsEl('p').querySelector('.row-fold')).toHaveAttribute('aria-expanded', 'false');
  });
  it('← で畳み、→ で開く（カーソルの行）', () => {
    const { onAction } = mount([row('p', { nest: { depth: 0, toggle: { open: true, dots: [] } } })]);
    const r = rowsEl('p');
    act(() => r.focus());
    fireEvent.keyDown(r, { key: 'ArrowRight' });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.keyDown(r, { key: 'ArrowLeft' });
    expect(onAction).toHaveBeenCalledWith({ type: 'sidebar.fold', key: 'spawn:p', open: false });
  });
});
