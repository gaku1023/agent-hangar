import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { HomeProps, RunningCard } from '../presenters/home.ts';
import type { SessionsProps } from '../presenters/sessions.ts';
import { HomeScreen } from './HomeScreen.tsx';
import { SessionsScreen } from './SessionsScreen.tsx';

const styles = path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles');
const css = (name: string) => fs.readFileSync(path.join(styles, name), 'utf8');

const home = (over: Partial<HomeProps> = {}): HomeProps => ({ attention: [], returning: [], confirm: [], running: [], recent: [], projects: [], idle: false, ...over });
const card = (over: Partial<RunningCard> = {}): RunningCard => ({ id: 's1', name: 'キーボード操作の見直し', live: 'busy', elapsed: '12 分', meta: 'agent-hangar · opus 5.5 · high', intent: null, activity: { tool: 'Edit', summary: 'packages/ui/src/keys.ts' }, note: null, contextPercent: 38, contextLabel: '38%', ...over });
const mountHome = (running: RunningCard[]) => render(<IntentRoot onIntent={vi.fn()}><HomeScreen {...home({ running })} /></IntentRoot>);

describe('ホームの実行中の札（白い札に状態の輪、意図と手の 2 行）', () => {
  it('作業中は、意図を白地の 1 行で、いまの手を墨の帯の 1 行で出す', () => {
    const { container } = mountHome([card({ intent: '一覧の枠をなくし、行の印で居場所を示す' })]);
    const el = container.querySelector('.live-card')!;
    expect(el).toHaveAttribute('data-live', 'busy');
    expect(el.querySelector('.live-intent')).toHaveTextContent('一覧の枠をなくし、行の印で居場所を示す');
    expect(el.querySelector('.live-act')).toHaveTextContent('Edit packages/ui/src/keys.ts');
    expect(el.querySelector('.live-rest')).toBeNull();
  });
  it('意図が書かれていなければ、意図の行は出さない', () => {
    const { container } = mountHome([card()]);
    expect(container.querySelector('.live-intent')).toBeNull();
    expect(container.querySelector('.live-act')).not.toBeNull();
  });
  it('休みと起動中は墨の帯を使わず、白地の文で言う', () => {
    const { container } = mountHome([card({ live: 'idle', activity: null, note: '休み。最後の返答から 8 分' }), card({ id: 's2', live: null, activity: null, note: '起動しています' })]);
    const cards = container.querySelectorAll('.live-card');
    expect(cards[0]).toHaveAttribute('data-live', 'idle');
    expect(cards[0]!.querySelector('.live-act')).toBeNull();
    expect(cards[0]!.querySelector('.live-rest')).toHaveTextContent('休み。最後の返答から 8 分');
    expect(cards[1]).not.toHaveAttribute('data-live');
    expect(cards[1]!.querySelector('.live-rest')).toHaveTextContent('起動しています');
  });
  it('状態の輪は作業中と入力待ちだけに灯し、呼吸させない', () => {
    const h = css('home.css');
    expect(h).toMatch(/\.live-card\[data-live='busy'\] \{[^}]*box-shadow: 0 0 0 1px color-mix\(in srgb, var\(--busy\)/);
    expect(h).toMatch(/\.live-card\[data-live='waiting'\] \{[^}]*box-shadow: 0 0 0 1px var\(--waiting\)/);
    expect(h).not.toMatch(/\.live-card\[data-live='idle'\]/);
    expect(h).not.toMatch(/\.live-card[^{]*\{[^}]*animation/);
  });
});

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

const TABS: SessionsProps['tabs'] = [
  { tab: 'all', label: 'すべて', count: '1,249', hot: false },
  { tab: 'paused', label: 'Paused', count: '0', hot: false },
  { tab: 'done', label: 'Done', count: '1,222', hot: false },
];
const sessions = (over: Partial<SessionsProps> = {}): SessionsProps => ({ text: '', filter: {}, projects: [], rows: [], total: 0, loading: false, mode: 'all', allCount: 1249, conditions: [], tabs: TABS, tab: 'all', sections: null, pager: null, statusColumn: true, tokens: [], hints: [], ...over } as SessionsProps);
const mountSessions = (over: Partial<SessionsProps>) => render(<IntentRoot onIntent={vi.fn()}><SessionsScreen {...sessions(over)} /></IntentRoot>);

describe('セッション一覧の絞り込みの反復', () => {
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
