import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import { presentAccounts } from '../presenters/accounts.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { applyFold, chooseFoldLevel, FOLD_LEVELS } from './headerFold.ts';
import { Shell } from './Shell.tsx';

/** 段ごとの要る幅を表で与える。何段目を測ったかも記録する。 */
const table = (needs: number[]) => {
  const asked: number[] = [];
  return { asked, need: (level: number) => { asked.push(level); return needs[level]!; } };
};
const NEEDS = [1000, 950, 900, 850, 800, 760, 720, 680, 640, 400];

describe('chooseFoldLevel（どこまで畳むか）', () => {
  it('畳まずに収まるなら畳まない', () => {
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 1200, current: 0, slack: 24 })).toBe(0);
  });
  it('収まるまで、優先度の低い段から順に畳む', () => {
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 870, current: 0, slack: 24 })).toBe(3);
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 850, current: 0, slack: 24 })).toBe(3);
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 849, current: 0, slack: 24 })).toBe(4);
  });
  it('どの段でも収まらなければ、いちばん奥まで畳む', () => {
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 100, current: 0, slack: 24 })).toBe(9);
  });
  it('中身が伸びて今の段で収まらなくなったら、窓の幅が同じでも次の段へ進む', () => {
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 830, current: 3, slack: 24 })).toBe(4);
  });
  // 戻すのは、戻した段がゆとりを持って収まるときだけにする。ちょうどの幅で行き来すると、見た目がぴくぴくする。
  it('広がっても、ゆとりの分が空くまでは戻さない', () => {
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 860, current: 4, slack: 24 })).toBe(4);
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 874, current: 4, slack: 24 })).toBe(3);
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 2000, current: 4, slack: 24 })).toBe(0);
  });
  it('ゆとりの分だけ空けば、一度に何段でも戻す', () => {
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 930, current: 6, slack: 24 })).toBe(2);
  });
  // 測るたびにレイアウトを組み直すので、要らない段は測らない。
  it('答えを決めるのに要る段だけを測る', () => {
    const t = table(NEEDS);
    chooseFoldLevel({ ...t, levels: 9, available: 1200, current: 0, slack: 24 });
    expect(t.asked).toEqual([0]);
    const u = table(NEEDS);
    chooseFoldLevel({ ...u, levels: 9, available: 870, current: 1, slack: 24 });
    expect(Math.max(...u.asked)).toBe(3);
  });
  // 隠れている間や、配置を測れない環境（jsdom）では、幅が 0 と出る。そのときは今の段を保つ。
  it('使える幅を測れないときは、今の段を保つ', () => {
    expect(chooseFoldLevel({ ...table(NEEDS), levels: 9, available: 0, current: 2, slack: 24 })).toBe(2);
  });
});

const usage = { fiveHour: 48, sevenDay: 12, fiveHourResets: null, sevenDayResets: null, updatedLabel: '3 分前' };
const sync = { visible: true, state: 'idle' as const, label: '同期 1 分前', pending: 6, sweepPending: 44, skipped: 2, paused: false, reason: null };
const props = { live: { count: 0, ids: [], rows: [], more: 0 }, sidebarCollapsed: false, wide: false, nav: [], conn: { visible: false, staleLabel: '', retryLabel: '', hard: false, desktop: false }, index: { phase: 'idle' as const, done: 0, total: 0 }, indexLabel: '索引 10 / 200 件', usage, sync, retention: { visible: false, title: '', detail: '', extendTo: 365 }, account: null, newSession: {} };
/** アカウントが 2 件あるときのヘッダ。計器は shown（会社）の値で作る。 */
const accountList = presentAccounts({ ...initialStore(), accounts: accountsFixture }, 0);
const withAccount = { ...props, account: { shown: accountList[0]!, list: accountList, sessionId: null, working: false } };
const renderShell = (account = false) => render(<IntentRoot onIntent={() => {}}><Shell {...(account ? withAccount : props)} overlays={null}><div /></Shell></IntentRoot>);

/**
 * 部品と、それが畳まれる最初の段。
 * 段 n では、ここで n 以下の段に書いた部品がすべて畳まれ、それより奥の部品は畳まれない。
 */
const ORDER: [string, number][] = [
  ['.gauge-updated', 1],
  ['.progress', 3],
  ['.sync-action', 4],
  ['.sync-count', 5],
  ['.gauge-bar', 6],
  ['.search-pill-label', 7],
  ['.search-kbd', 7],
  ['.sync-label-text', 8],
  ['.new-session .btn-label', 9],
  ['.gauges', 10],
];
/** アカウントがあるときだけ現れる部品。最終更新の次、計器の棒より前に畳む。 */
const ACCOUNT_ORDER: [string, number][] = [['.account-name', 2]];
/** どの段でも畳まない部品。 */
const KEPT = ['.search-pill', '.sync', '.sync-label', '.sync-dot', '.sync-skipped', '.gauge-key', '.gauge-num', '.new-session'];
/** アカウントがあるとき、どの段でも畳まない部品。名前を畳んでも、色の点と押せるボタンは残る。 */
const ACCOUNT_KEPT = ['.account-switch', '.account-dot', '.account-caret'];

describe('applyFold（段ごとに付く畳んだ印）', () => {
  it('段の数は、畳む部品の組の数である', () => {
    expect(FOLD_LEVELS).toBe(10);
  });
  // アカウントが 1 件以下のときは、ヘッダに account の部品が無く、段は何も畳まない。ほかの部品の順は変わらない。
  for (const account of [false, true]) {
    const order = account ? [...ORDER, ...ACCOUNT_ORDER] : ORDER;
    const kept = account ? [...KEPT, ...ACCOUNT_KEPT] : KEPT;
    for (let level = 0; level <= 10; level++) {
      it(`${account ? 'アカウントあり' : 'アカウントなし'}・段 ${level} では、その段までの部品にだけ印が付く`, () => {
        const { container } = renderShell(account);
        const row = container.querySelector<HTMLElement>('.header-row')!;
        applyFold(row, level);
        for (const [sel, at] of order) {
          const els = row.querySelectorAll(sel);
          expect(els.length, sel).toBeGreaterThan(0);
          for (const el of els) expect(el.hasAttribute('data-folded'), `${sel} @${level}`).toBe(at <= level);
        }
        for (const sel of kept) for (const el of row.querySelectorAll(sel)) expect(el.hasAttribute('data-folded'), `${sel} @${level}`).toBe(false);
        if (!account) expect(row.querySelector('[class*="account-"]')).toBeNull();
      });
    }
  }
  it('段を戻すと印を外す', () => {
    const { container } = renderShell(true);
    const row = container.querySelector<HTMLElement>('.header-row')!;
    applyFold(row, 10);
    applyFold(row, 0);
    expect(row.querySelectorAll('[data-folded]')).toHaveLength(0);
  });
});

describe('畳んでも読める', () => {
  // 件数を畳んでも、同期の文の title から読める。文そのものを畳んでも、点だけのリンクが残り、押せば設定へ行ける。
  it('同期のリンクは点を含み、title に状態と件数を持つ', () => {
    renderShell();
    const link = screen.getByRole('link', { name: '同期 1 分前' });
    expect(link).toHaveAttribute('title', '同期 1 分前、未送信 6、未送信の本文 44、送れなかった本文 2（押すと同期の設定を開く）');
    expect(link.querySelector('.sync-dot')).not.toBeNull();
  });
  it('件数が無いときは title に足さない', () => {
    render(<IntentRoot onIntent={() => {}}><Shell {...props} sync={{ ...sync, pending: 0, sweepPending: 0, skipped: 0 }} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByRole('link', { name: '同期 1 分前' })).toHaveAttribute('title', '同期 1 分前（押すと同期の設定を開く）');
  });
  it('最終更新を畳んでも、ゲージの title から読める', () => {
    renderShell();
    expect(screen.getByRole('meter', { name: '5 時間枠の使用率' }).closest('.gauge')).toHaveAttribute('title', '5 時間枠の使用率 48%、最終更新 3 分前');
    expect(screen.getByRole('meter', { name: '週の枠の使用率' }).closest('.gauge')).toHaveAttribute('title', '週の枠の使用率 12%、最終更新 3 分前');
  });
});

describe('アカウントの名前を畳んでも読める', () => {
  it('名前を畳んでも、ボタンの名前（読み上げ）と色の点から、どのアカウントか分かる', () => {
    const { container } = renderShell(true);
    const row = container.querySelector<HTMLElement>('.header-row')!;
    applyFold(row, 2);
    const face = screen.getByRole('button', { name: /^アカウントを切り替える（いまは 会社/ });
    expect(face.querySelector('.account-name')).toHaveAttribute('data-folded');
    expect(face.querySelector('.account-dot')).toHaveStyle({ color: '#2a57b8' });
  });
  it('アカウントがあるとき、計器は全体が 1 つのボタンの中にある', () => {
    renderShell(true);
    const face = screen.getByRole('button', { name: /^アカウントを切り替える（いまは 会社/ });
    expect(face.querySelectorAll('.gauge')).toHaveLength(2);
    expect(face.querySelector('.gauge-updated')).not.toBeNull();
  });
  it('アカウントがあって値が無いときも、切り替えのボタンを出し、値が無いと言う', () => {
    const noValue = { ...withAccount, usage: { fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null } };
    render(<IntentRoot onIntent={() => {}}><Shell {...noValue} overlays={null}><div /></Shell></IntentRoot>);
    const face = screen.getByRole('button', { name: /^アカウントを切り替える（いまは 会社/ });
    expect(face).toHaveTextContent('まだ値がありません');
    expect(screen.queryByRole('link', { name: /使用率/ })).toBeNull();
  });
  it('アカウントが無くて値も無いときは、今までどおり設定へ行くリンクを出す', () => {
    const noValue = { ...props, usage: { fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null } };
    render(<IntentRoot onIntent={() => {}}><Shell {...noValue} overlays={null}><div /></Shell></IntentRoot>);
    expect(screen.getByRole('link', { name: '使用率 未取得' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /アカウントを切り替える/ })).toBeNull();
  });
});

describe('useHeaderFold（測って畳む）', () => {
  let roCallbacks: (() => void)[] = [];
  afterEach(() => { vi.unstubAllGlobals(); roCallbacks = []; });

  /** 行の幅を available にし、右の塊の右端を「畳んだ段ごとに 60px ずつ縮む」ように見せる。 */
  const fakeLayout = (row: HTMLElement, width: () => number) => {
    Object.defineProperty(row, 'clientWidth', { configurable: true, get: width });
    row.getBoundingClientRect = () => ({ left: 0, right: width(), width: width(), top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} });
    const end = row.lastElementChild as HTMLElement;
    end.getBoundingClientRect = () => {
      const folded = new Set([...row.querySelectorAll('[data-folded]')].map((el) => el.getAttribute('data-fold-at')));
      const right = 1000 - 60 * folded.size;
      return { left: 0, right, width: right, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} };
    };
  };

  it('はみ出す間は段を進め、広がったら戻す。測る印は残さない', () => {
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { roCallbacks.push(cb); } observe() {} disconnect() {} });
    let width = 0;
    const { container } = renderShell(true);
    const row = container.querySelector<HTMLElement>('.header-row')!;
    expect(row).toHaveAttribute('data-fold-level', '0');
    fakeLayout(row, () => width);
    width = 800;
    act(() => { for (const cb of roCallbacks) cb(); });
    // 畳んだ段の数だけ、行が 60px ずつ縮む。1000 − 60 × 段 ≤ 800 になる最初の段は 4 である（段 4 では最終更新、名前、索引、同期の操作を畳む）。
    expect(row).toHaveAttribute('data-fold-level', '4');
    expect(row.querySelector('.sync-action')).toHaveAttribute('data-folded');
    expect(row.querySelector('.sync-count')).not.toHaveAttribute('data-folded');
    expect(row.querySelector('.gauge-bar')).not.toHaveAttribute('data-folded');
    expect(row).not.toHaveAttribute('data-fold-measuring');
    width = 1100;
    act(() => { for (const cb of roCallbacks) cb(); });
    expect(row).toHaveAttribute('data-fold-level', '0');
    expect(row.querySelectorAll('[data-folded]')).toHaveLength(0);
  });
});
