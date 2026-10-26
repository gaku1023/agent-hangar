import { describe, expect, it } from 'vitest';
import type { SessionDto } from '@agent-hangar/shared';
import { initialStore, type Store } from '../store/store.ts';
import { cleanPaneLayout, paneLeaves, PANES_KEY, type PaneNode } from './panes.ts';
import { initialState, transition, type State } from './transition.ts';
import type { Input } from './types.ts';

// 画面の分割（別のセッションを並べる）の木。mediator の純関数として確かめる。

const act = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const hash = (id: string): Input => ({ kind: 'runtime', event: { type: 'hash.changed', route: { name: 'session', id } } });
const store: Store = initialStore();

/** 入力を順に流す。最後の結果と、途中の副作用をすべて返す。 */
function run(start: State, inputs: Input[], st: Store = store) {
  let state = start;
  const effects: ReturnType<typeof transition>['effects'] = [];
  for (const i of inputs) {
    const r = transition(state, st, i);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

/** セッション s1 を開いた状態（ペイン 1 つ）。 */
const one = (): State => run(initialState(), [hash('s1')]).state;
const ids = (s: State) => paneLeaves(s.panes.root).map((l) => l.sessionId);
const focusSession = (s: State) => paneLeaves(s.panes.root).find((l) => l.id === s.panes.focus)?.sessionId;
const saves = (effects: { kind: string }[]) => effects.filter((e) => e.kind === 'storage.save' && (e as { key?: string }).key === PANES_KEY);

/** 開いて、hash が追いつくまで流す（navigate の結果を hash.changed として返す）。 */
const open = (s: State, sessionId: string, side: 'left' | 'right' | 'up' | 'down' | 'center', target: string | null = null) =>
  run(s, [act({ type: 'pane.open', sessionId, target, side }), hash(sessionId)]).state;

describe('ペインの木：開く', () => {
  it('最初のセッションでペイン 1 つの木ができ、操作中になる', () => {
    const s = one();
    expect(ids(s)).toEqual(['s1']);
    expect(s.panes.focus).toBe(paneLeaves(s.panes.root)[0]!.id);
  });
  it.each([
    ['right', 'row', ['s1', 's2']], ['left', 'row', ['s2', 's1']], ['down', 'col', ['s1', 's2']], ['up', 'col', ['s2', 's1']],
  ] as const)('%s で開くと向き %s で並びの合った節ができ、新しいペインが操作中になる', (side, dir, order) => {
    const r = run(one(), [act({ type: 'pane.open', sessionId: 's2', target: null, side })]);
    const root = r.state.panes.root as Extract<PaneNode, { kind: 'split' }>;
    expect(root.kind).toBe('split');
    expect(root.dir).toBe(dir);
    expect(root.ratio).toBe(0.5);
    expect(ids(r.state)).toEqual(order);
    expect(focusSession(r.state)).toBe('s2');
    expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's2' } });
  });
  it('中央で開くと中身だけ替わり、ペインの数は変わらない', () => {
    const s = open(one(), 's2', 'center');
    expect(ids(s)).toEqual(['s2']);
    expect(s.panes.focus).toBe(paneLeaves(s.panes.root)[0]!.id);
  });
  it('木にあるセッションを開くと、数は変わらず、そのペインが操作中になり、光らせる一時状態が立つ', () => {
    const two = open(one(), 's2', 'right');
    expect(focusSession(two)).toBe('s2');
    const r = run(two, [act({ type: 'pane.open', sessionId: 's1', target: null, side: 'right' })]);
    expect(ids(r.state)).toEqual(['s1', 's2']);
    expect(focusSession(r.state)).toBe('s1');
    expect(r.state.panes.flash).toEqual({ pane: r.state.panes.focus, n: 1 });
    expect(r.effects.filter((e) => e.kind === 'toast')).toHaveLength(1);
    expect(saves(r.effects)).toHaveLength(1);
  });
  it('target を指すと、その辺に分けて開く', () => {
    const two = open(one(), 's2', 'right');
    const [a] = paneLeaves(two.panes.root);
    const s = open(two, 's3', 'down', a!.id);
    expect(ids(s)).toEqual(['s1', 's3', 's2']);
  });
  it('空のペインを右・下に開く。操作中は新しい空のペインになる', () => {
    const r = run(one(), [act({ type: 'pane.openEmpty', side: 'right' })]);
    expect(ids(r.state)).toEqual(['s1', null]);
    expect(focusSession(r.state)).toBeNull();
    const d = run(one(), [act({ type: 'pane.openEmpty', side: 'down' })]);
    expect((d.state.panes.root as Extract<PaneNode, { kind: 'split' }>).dir).toBe('col');
  });
  it('空のペインにセッションを入れる', () => {
    const e = run(one(), [act({ type: 'pane.openEmpty', side: 'right' })]).state;
    const r = run(e, [act({ type: 'pane.fill', pane: e.panes.focus!, sessionId: 's2' })]);
    expect(ids(r.state)).toEqual(['s1', 's2']);
    expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's2' } });
  });
});

describe('ペインの木：外す', () => {
  const three = () => open(open(one(), 's2', 'right'), 's3', 'down');
  it('外すと親の節がたたまれ、兄弟が親の位置に入る。操作中だったら兄弟の最初のペインへ移る', () => {
    const s = three();
    expect(ids(s)).toEqual(['s1', 's2', 's3']);
    const r = run(s, [act({ type: 'pane.remove', pane: s.panes.focus! })]);
    expect(ids(r.state)).toEqual(['s1', 's2']);
    expect(focusSession(r.state)).toBe('s2');
    expect((r.state.panes.root as Extract<PaneNode, { kind: 'split' }>).dir).toBe('row');
    // 画面は、移った先に合わせて履歴を積まずに置き換える。
    expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's2' }, replace: true });
  });
  it('兄弟が節なら、その最初のペインが操作中になる', () => {
    const s = open(open(one(), 's2', 'right'), 's3', 'down'); // s1 | (s2 / s3)
    const first = paneLeaves(s.panes.root)[0]!;
    const r = run(s, [act({ type: 'pane.focus', pane: first.id }), act({ type: 'pane.remove', pane: first.id })]);
    expect(ids(r.state)).toEqual(['s2', 's3']);
    expect(focusSession(r.state)).toBe('s2');
  });
  it('最後の 1 つは外れず、知らせが出る', () => {
    const s = one();
    const r = run(s, [act({ type: 'pane.remove', pane: s.panes.focus! })]);
    expect(ids(r.state)).toEqual(['s1']);
    expect(r.effects).toEqual([{ kind: 'toast', level: 'info', message: '最後のペインは外せません' }]);
  });
  it('ほかのペインを全部外す', () => {
    const s = three();
    const keep = paneLeaves(s.panes.root)[1]!;
    const r = run(s, [act({ type: 'pane.removeOthers', pane: keep.id })]);
    expect(ids(r.state)).toEqual(['s2']);
    expect(r.state.panes.focus).toBe(keep.id);
  });
  it('最大化中のペインを外すと最大化が解ける', () => {
    const s = three();
    const z = run(s, [act({ type: 'pane.zoom', pane: s.panes.focus! })]).state;
    expect(z.panes.zoom).toBe(s.panes.focus);
    const r = run(z, [act({ type: 'pane.remove', pane: s.panes.focus! })]);
    expect(r.state.panes.zoom).toBeNull();
  });
  it('最大化は同じペインでもう一度で解ける', () => {
    const s = one();
    const z = run(s, [act({ type: 'pane.zoom', pane: s.panes.focus! })]).state;
    expect(run(z, [act({ type: 'pane.zoom', pane: s.panes.focus! })]).state.panes.zoom).toBeNull();
  });
});

describe('ペインの木：動かす', () => {
  const pairs = (s: State) => paneLeaves(s.panes.root).map((l) => [l.id, l.sessionId]);
  it('中央に動かすと 2 つが入れ替わり、id とセッションの組は保たれる', () => {
    const s = open(open(one(), 's2', 'right'), 's3', 'right');
    const [a, , c] = paneLeaves(s.panes.root);
    const before = pairs(s);
    const r = run(s, [act({ type: 'pane.move', pane: a!.id, target: c!.id, side: 'center' })]);
    expect(ids(r.state)).toEqual(['s3', 's2', 's1']);
    expect([...pairs(r.state)].sort()).toEqual([...before].sort());
  });
  it('辺に動かすと抜いて差し込む。組は保たれる', () => {
    const s = open(open(one(), 's2', 'right'), 's3', 'right');
    const [a, b] = paneLeaves(s.panes.root);
    const before = pairs(s);
    const r = run(s, [act({ type: 'pane.move', pane: a!.id, target: b!.id, side: 'down' })]);
    expect(ids(r.state)).toEqual(['s2', 's1', 's3']);
    expect([...pairs(r.state)].sort()).toEqual([...before].sort());
  });
  it('自分の上は無効', () => {
    const s = open(one(), 's2', 'right');
    const [a] = paneLeaves(s.panes.root);
    const r = run(s, [act({ type: 'pane.move', pane: a!.id, target: a!.id, side: 'right' })]);
    expect(r.state.panes.root).toBe(s.panes.root);
    expect(r.effects).toEqual([]);
  });
  it('比率は 0.1〜0.9 に収まり、均等にすると全部 0.5', () => {
    const s = open(open(one(), 's2', 'right'), 's3', 'down');
    const root = s.panes.root as Extract<PaneNode, { kind: 'split' }>;
    const inner = root.b as Extract<PaneNode, { kind: 'split' }>;
    let r = run(s, [act({ type: 'pane.resize', node: root.id, ratio: 0.02 }), act({ type: 'pane.resize', node: inner.id, ratio: 5 })]).state;
    const r1 = r.panes.root as Extract<PaneNode, { kind: 'split' }>;
    expect(r1.ratio).toBe(0.1);
    expect((r1.b as Extract<PaneNode, { kind: 'split' }>).ratio).toBe(0.9);
    r = run(r, [act({ type: 'pane.equalize' })]).state;
    const r2 = r.panes.root as Extract<PaneNode, { kind: 'split' }>;
    expect([r2.ratio, (r2.b as Extract<PaneNode, { kind: 'split' }>).ratio]).toEqual([0.5, 0.5]);
  });
  it('右パネルの開閉は、ペインが 2 つ以上のときだけ効く', () => {
    const s = one();
    expect(run(s, [act({ type: 'pane.toc', pane: s.panes.focus! })]).state.panes.root).toBe(s.panes.root);
    const two = open(s, 's2', 'right');
    const r = run(two, [act({ type: 'pane.toc', pane: two.panes.focus! })]);
    expect(paneLeaves(r.state.panes.root).find((l) => l.id === two.panes.focus)!.toc).toBe(true);
  });
});

describe('画面との関係', () => {
  it('操作中を移すと画面を合わせ、履歴は置き換える', () => {
    const s = open(one(), 's2', 'right');
    const a = paneLeaves(s.panes.root)[0]!;
    const r = run(s, [act({ type: 'pane.focus', pane: a.id })]);
    expect(r.state.panes.focus).toBe(a.id);
    expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's1' }, replace: true });
  });
  it('セッションへ移る入力で、木にあれば操作中が移り、無ければ操作中のペインが替わる。screen.id は操作中のセッション', () => {
    let s = open(one(), 's2', 'right');
    s = run(s, [hash('s1')]).state;
    expect(focusSession(s)).toBe('s1');
    expect(ids(s)).toEqual(['s1', 's2']);
    s = run(s, [hash('s9')]).state;
    expect(ids(s)).toEqual(['s9', 's2']);
    expect(focusSession(s)).toBe('s9');
    expect(s.screen).toEqual({ name: 'session', id: 's9' });
  });
  it('session.open（サイドバーのクリック）も同じ道を通る', () => {
    const s = open(one(), 's2', 'right');
    const r = run(s, [act({ type: 'session.open', id: 's7' })]);
    expect(r.effects).toContainEqual({ kind: 'navigate', route: { name: 'session', id: 's7' } });
    const after = run(r.state, [hash('s7')]).state;
    expect(ids(after)).toEqual(['s1', 's7']);
  });
  it('ホームへ移っても木は残り、セッションへ戻ると分割が戻る', () => {
    const s = open(one(), 's2', 'right');
    const home = run(s, [{ kind: 'runtime', event: { type: 'hash.changed', route: { name: 'home' } } }]).state;
    expect(ids(home)).toEqual(['s1', 's2']);
    const back = run(home, [hash('s1')]).state;
    expect(ids(back)).toEqual(['s1', 's2']);
    expect(focusSession(back)).toBe('s1');
  });
});

describe('保存', () => {
  it('木の形か操作中が変わると storage.save が 1 回出る', () => {
    const r = run(one(), [act({ type: 'pane.open', sessionId: 's2', target: null, side: 'right' })]);
    const [sv] = saves(r.effects);
    expect(saves(r.effects)).toHaveLength(1);
    expect(sv).toEqual({ kind: 'storage.save', key: PANES_KEY, value: { root: r.state.panes.root, focus: r.state.panes.focus } });
    const s = r.state;
    const f = run(s, [act({ type: 'pane.focus', pane: paneLeaves(s.panes.root)[0]!.id })]);
    expect(saves(f.effects)).toHaveLength(1);
  });
  it('最大化と光らせるのは保存しない', () => {
    const two = open(one(), 's2', 'right');
    expect(saves(run(two, [act({ type: 'pane.zoom', pane: two.panes.focus! })]).effects)).toEqual([]);
    expect(saves(run(two, [act({ type: 'pane.open', sessionId: 's1', target: null, side: 'right' })]).effects).length).toBe(1); // 操作中が移るので保存する
    const again = run(two, [act({ type: 'pane.open', sessionId: 's2', target: null, side: 'right' })]);
    expect(saves(again.effects)).toEqual([]); // すでに操作中のペインを光らせるだけ
    expect(again.state.panes.flash).not.toBeNull();
  });
  it('初めてセッションを開いたときも 1 回保存する', () => {
    expect(saves(run(initialState(), [hash('s1')]).effects)).toHaveLength(1);
  });
});

describe('cleanPaneLayout', () => {
  const leaf = (id: string, sessionId: string | null) => ({ kind: 'pane', id, sessionId, toc: false });
  const split = (id: string, a: unknown, b: unknown, ratio = 0.5) => ({ kind: 'split', id, dir: 'row', ratio, a, b });
  it('正しい形はそのまま通し、比率は収める', () => {
    const v = { root: split('n1', leaf('p1', 's1'), leaf('p2', 's2'), 0.99), focus: 'p2' };
    const r = cleanPaneLayout(v);
    expect((r.root as Extract<PaneNode, { kind: 'split' }>).ratio).toBe(0.9);
    expect(r.focus).toBe('p2');
  });
  it.each([[null], ['x'], [{}], [{ root: 3 }], [{ root: { kind: 'pane', id: 3 } }], [{ root: split('n1', leaf('p1', 's1'), { kind: 'zzz' }) }], [{ root: split('n1', leaf('p1', 's1'), leaf('p1', 's2')) }]])('壊れた形は空の木にする %#', (v) => {
    expect(cleanPaneLayout(v)).toEqual({ root: null, focus: null });
  });
  it('同じセッションの重複は後ろを捨てる', () => {
    const r = cleanPaneLayout({ root: split('n1', leaf('p1', 's1'), leaf('p2', 's1')), focus: 'p2' });
    expect(paneLeaves(r.root).map((l) => l.id)).toEqual(['p1']);
    expect(r.focus).toBe('p1');
  });
  it('空のペインは重複と数えない', () => {
    const r = cleanPaneLayout({ root: split('n1', leaf('p1', null), leaf('p2', null)) });
    expect(paneLeaves(r.root)).toHaveLength(2);
  });
  it('操作中が木に無ければ最初のペインにする', () => {
    expect(cleanPaneLayout({ root: leaf('p1', 's1'), focus: 'zz' }).focus).toBe('p1');
  });
});

describe('消されたセッション', () => {
  const sess = (id: string) => ({ id }) as unknown as SessionDto;
  it('Store から消えた行のペインが外れる', () => {
    const s = open(one(), 's2', 'right');
    const live: Store = { ...initialStore(), bootstrapped: true, sessions: { s1: sess('s1'), s2: sess('s2') } };
    expect(ids(run(s, [{ kind: 'store' }], live).state)).toEqual(['s1', 's2']);
    const gone: Store = { ...live, sessions: { s1: sess('s1') } };
    const r = run(s, [{ kind: 'store' }], gone);
    expect(ids(r.state)).toEqual(['s1']);
    expect(focusSession(r.state)).toBe('s1');
    expect(saves(r.effects)).toHaveLength(1);
  });
  it('bootstrap 前（Store が空）は外さない', () => {
    const s = open(one(), 's2', 'right');
    expect(ids(run(s, [{ kind: 'store' }]).state)).toEqual(['s1', 's2']);
  });
});

// 並べたペインの端末は、操作中でなくても接続を保つ。
// 切ると、データが届かず描画が止まり、寸法が tmux へ届かず右端が欠け、ホイールが tmux へ届かずスクロールできない。
describe('ペインの木：端末の接続', () => {
  type Eff = { kind: string; sessionId?: string; tabId?: string | null };
  const offs = (effects: Eff[]) => effects.filter((e) => e.kind === 'terminal.disconnectSession').map((e) => e.sessionId);
  const ons = (effects: Eff[]) => effects.filter((e) => e.kind === 'terminal.connect').map((e) => e.sessionId);
  const runDto = (id: string, sessionId: string) => ({ id, sessionId, deviceId: 'd', kind: 'start' as const, tmuxName: `hangar-${id}`, pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 });
  const home: Input = { kind: 'runtime', event: { type: 'hash.changed', route: { name: 'home' } } };

  it('隣に開いても、前のペインのセッションの接続を切らない', () => {
    const r = run(one(), [act({ type: 'pane.open', sessionId: 's2', target: null, side: 'right' }), hash('s2')]);
    expect(offs(r.effects)).toEqual([]);
    expect(ons(r.effects)).toContain('s2');
  });
  it('操作中を移しても、ほかのペインのセッションの接続を切らない', () => {
    const two = open(one(), 's2', 'right');
    const [a] = paneLeaves(two.panes.root);
    const r = run(two, [act({ type: 'pane.focus', pane: a!.id }), hash('s1')]);
    expect(offs(r.effects)).toEqual([]);
  });
  it('画面を離れるとペインのセッションを全部切り、戻ると全部つなぐ', () => {
    const two = open(one(), 's2', 'right');
    const away = run(two, [home]);
    expect(offs(away.effects).sort()).toEqual(['s1', 's2']);
    const back = run(away.state, [hash('s2')]);
    expect(ons(back.effects).sort()).toEqual(['s1', 's2']);
    expect(offs(back.effects)).toEqual([]);
  });
  it('ペインを外すと、そのセッションの接続を切る', () => {
    const two = open(one(), 's2', 'right');
    const [a] = paneLeaves(two.panes.root);
    const r = run(two, [act({ type: 'pane.remove', pane: a!.id })]);
    expect(offs(r.effects)).toEqual(['s1']);
  });
  it('中身を替えたペインの前のセッションは切り、新しいセッションはつなぐ', () => {
    const two = open(one(), 's2', 'right');
    const r = run(two, [act({ type: 'pane.open', sessionId: 's3', target: null, side: 'center' }), hash('s3')]);
    expect(offs(r.effects)).toEqual(['s2']);
    expect(ons(r.effects)).toContain('s3');
  });
  it('操作中でないペインのセッションで run が始まると、その端末をつなぐ', () => {
    const two = open(one(), 's2', 'right');
    const r = run(two, [{ kind: 'server', event: { type: 'run.started', run: runDto('r1', 's1'), tabs: [] } }]);
    expect(r.effects).toContainEqual({ kind: 'terminal.connect', sessionId: 's1', tabId: 'r1' });
  });
  it('最大化と解除、右パネルの開閉では接続を変えない', () => {
    const two = open(one(), 's2', 'right');
    const [a] = paneLeaves(two.panes.root);
    const r = run(two, [act({ type: 'pane.zoom', pane: a!.id }), act({ type: 'pane.zoom', pane: a!.id }), act({ type: 'pane.toc', pane: a!.id })]);
    expect(offs(r.effects)).toEqual([]);
  });
  it('分けていないときは、別のセッションへ移ると前を 1 度だけ切り、次を 1 度だけつなぐ', () => {
    const r = run(one(), [hash('s2')]);
    expect(offs(r.effects)).toEqual(['s1']);
    expect(ons(r.effects)).toEqual(['s2']);
  });
});

describe('ペインの木：右欄と本文の取り直し', () => {
  type Eff = { kind: string; sessionId?: string; fromSeq?: number };
  const appended = (sessionId: string): Input => ({ kind: 'server', event: { type: 'transcript.appended', sessionId, count: 1 } });
  const loads = (effects: Eff[]) => effects.filter((e) => e.kind === 'api.loadEvents').map((e) => `${e.sessionId}:${e.fromSeq}`);

  it('操作中でないペインのセッションに追記が来ても、本文を取り直す', () => {
    const two = open(one(), 's2', 'right');
    expect(focusSession(two)).toBe('s2');
    const r = run(two, [appended('s1')]);
    expect(loads(r.effects)).toEqual(['s1:-2']);
  });
  it('操作中のペインのセッションは今までどおり取り直す', () => {
    const two = open(one(), 's2', 'right');
    expect(loads(run(two, [appended('s2')]).effects)).toEqual(['s2:-2']);
  });
  it('ペインに無いセッションの追記では取り直さない', () => {
    const two = open(one(), 's2', 'right');
    expect(loads(run(two, [appended('s9')]).effects)).toEqual([]);
  });
  it('分割していないときは今までどおり（開いているセッションだけ）', () => {
    const s = one();
    expect(loads(run(s, [appended('s1')]).effects)).toEqual(['s1:-2']);
    expect(loads(run(s, [appended('s2')]).effects)).toEqual([]);
  });
  it('新しく見えた操作中でないペインのセッションの本文も読み始める', () => {
    const two = open(one(), 's2', 'right');
    const home: Input = { kind: 'runtime', event: { type: 'hash.changed', route: { name: 'home' } } };
    const away = run(two, [home]).state;
    const back = run(away, [hash('s2')]);
    expect(loads(back.effects).sort()).toEqual(['s1:0', 's2:0']);
  });
});
