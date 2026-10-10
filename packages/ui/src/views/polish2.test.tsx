import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { SessionListProps } from '../presenters/sessions.ts';
import { SessionList } from './SessionList.tsx';

const styles = path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles');
const css = (name: string) => fs.readFileSync(path.join(styles, name), 'utf8');

describe('状態の印の色', () => {
  it('休みは灰で、緑（--idle）は使わない', () => {
    const rule = css('base.css').match(/\.dot\[data-status='idle'\] \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('var(--ink-3)');
    expect(rule).not.toContain('var(--idle)');
  });
});

describe('ガラスの濃さ', () => {
  it('サイドバーはガラスにしない', () => {
    const rule = css('base.css').match(/^\.sidebar \{[^}]*\}/m)?.[0] ?? '';
    expect(rule).not.toContain('backdrop-filter');
    expect(rule).not.toContain('--glass-bg');
  });
  it('開いて出るもの（パレット、ダイアログ、知らせ、メニュー）は、白 88% 以上の濃さにする', () => {
    const t = css('tokens.css');
    for (const name of ['--glass-bg-palette', '--glass-bg-dialog', '--glass-bg-toast', '--glass-bg-menu']) {
      const a = Number(t.match(new RegExp(`${name}: rgba\\(255, 255, 255, ([0-9.]+)\\)`))?.[1]);
      expect(a, name).toBeGreaterThanOrEqual(0.88);
    }
  });
});

const TABS: SessionListProps['tabs'] = [
  { tab: 'all', label: 'すべて', count: '1,249', hot: false },
  { tab: 'paused', label: 'Paused', count: '0', hot: false },
  { tab: 'done', label: 'Done', count: '1,222', hot: false },
];
const sessions = (over: Partial<SessionListProps> = {}): SessionListProps => ({ text: '', filter: {}, projects: [], rows: [], total: 0, loading: false, mode: 'all', allCount: 1249, conditions: [], tabs: TABS, tab: 'all', pager: null, statusColumn: true, tokens: [], hints: [], ...over });
const mountSessions = (over: Partial<SessionListProps>) => render(<ActionRoot onAction={vi.fn()}><div className="host"><SessionList {...sessions(over)} /></div></ActionRoot>);

describe('一覧の絞り込みの反復', () => {
  it('状態のタブだけで絞っているときは、条件の行を出さない', () => {
    mountSessions({ tab: 'done', filter: { status: 'done' }, conditions: ['Done'], total: 1222 });
    expect(screen.queryByRole('status', { name: '絞り込みの条件' })).toBeNull();
  });
  it('タブに別の条件が加わったら、条件の行を出す', () => {
    mountSessions({ tab: 'done', filter: { status: 'done', days: 7 }, conditions: ['Done', '7 日'], total: 12 });
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toHaveTextContent('12 件');
  });
  it('タブが「すべて」で条件があるときは、条件の行を出す', () => {
    mountSessions({ tab: 'all', filter: { days: 7 }, conditions: ['7 日'], total: 40 });
    expect(screen.getByRole('status', { name: '絞り込みの条件' })).toBeInTheDocument();
  });
  it('0 件のタブには印を付け、淡くする', () => {
    mountSessions({});
    expect(screen.getByRole('button', { name: /Paused/ })).toHaveAttribute('data-empty', 'true');
    expect(screen.getByRole('button', { name: /Done/ })).not.toHaveAttribute('data-empty');
    expect(css('rows.css')).toMatch(/\.sessions-tab\[data-empty='true'\]:not\(\[aria-pressed='true'\]\) \{[^}]*color: var\(--ink-3\)/);
  });
  it('帯のいまのページは塗りつぶさず、淡い地と色の文字で示す', () => {
    const rule = css('rows.css').match(/\.pager-btn\[aria-current='page'\] \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('background: var(--accent-soft)');
    expect(rule).toContain('color: var(--accent)');
  });
});
