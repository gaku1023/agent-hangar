import { translator } from '@agent-hangar/shared';
import { describe, expect, it } from 'vitest';
import { morningGroup, presentHomeBand, type AttentionCard, type BandGroup, type ConfirmCard, type ReturnCard, type RunningCard } from './home.ts';

const ja = translator('ja');
const en = translator('en');

const waiting = (id: string, over: Partial<AttentionCard> = {}): AttentionCard => ({ id, name: `待ち ${id}`, projectName: 'alpha', waited: '12分', question: '削除してよいですか', answer: 'terminal', ...over });
const reminder = (id: string, over: Partial<ReturnCard> = {}): ReturnCard => ({ id, name: `戻る ${id}`, projectName: 'alpha', reason: '結果を確かめる', returnOn: '2026-10-02', returnTime: null, overdueDays: 0, due: true, pastMin: null, ...over });
const running = (id: string, over: Partial<RunningCard> = {}): RunningCard => ({ id, name: `動く ${id}`, live: 'busy', aside: false, elapsed: '5分', meta: 'alpha · opus', intent: null, activity: null, note: '作業中', contextPercent: 40, contextLabel: '40%', ...over });
const todoCard = (id: string): ConfirmCard => ({ kind: 'todo', id, text: `やる ${id}`, projectId: 'alpha', projectName: 'alpha', sessionName: 'one', ago: '1 時間前', note: '片付いた' });
const sessionCard = (id: string, status: 'paused' | 'done'): ConfirmCard => ({ kind: 'session', id, name: `提案 ${id}`, projectName: null, status, label: status === 'done' ? 'Done にする？' : 'Paused · 10/3（土）？', note: '直した', ago: '2 時間前' });
const none = { attention: [], returning: [], running: [], confirm: [] };

const ids = (gs: BandGroup[]) => gs.map((g) => g.id);

describe('presentHomeBand の群', () => {
  it('要対応、実行中、確認待ちの順に 3 つの群を出し、0 件でも群は残す', () => {
    const band = presentHomeBand(none, ja);
    expect(ids(band.groups)).toEqual(['attention', 'running', 'pending']);
    expect(band.groups.map((g) => g.count)).toEqual([0, 0, 0]);
    expect(band.groups.map((g) => g.label)).toEqual(['要対応', '実行中', '確認待ち']);
  });

  it('要対応の件数は、入力待ちと今日のリマインダーを足したもの', () => {
    const band = presentHomeBand({ ...none, attention: [waiting('a'), waiting('b')], returning: [reminder('r')] }, ja);
    const g = band.groups[0]!;
    expect(g.count).toBe(3);
    expect(g.rows.map((r) => r.key)).toEqual(['wait:a', 'wait:b', 'return:r']);
    expect(g.summary).toBe('入力待ち 2、今日のリマインダー 1');
    expect(g.tone).toBe('wait');
    expect(g.icon).toBe('alert');
  });

  it('実行中の件数と、作業中とアイドルの内訳', () => {
    const band = presentHomeBand({ ...none, running: [running('a'), running('b', { live: 'idle' }), running('c', { live: 'idle' })] }, ja);
    const g = band.groups[1]!;
    expect(g.count).toBe(3);
    expect(g.summary).toBe('作業中 1、アイドル 2');
    expect(g.tone).toBe('default');
  });

  it('確認待ちの件数は、TODO の完了の提案とセッションの提案を合わせたもの', () => {
    const band = presentHomeBand({ ...none, confirm: [todoCard('t1'), sessionCard('s1', 'done')] }, ja);
    const g = band.groups[2]!;
    expect(g.count).toBe(2);
    expect(g.rows.map((r) => r.key)).toEqual(['todo:t1', 'session:s1']);
    expect(g.summary).toBe('提案 2');
    expect(g.tone).toBe('cand');
  });

  it('文は辞書の言語で引く', () => {
    const band = presentHomeBand({ ...none, attention: [waiting('a')], confirm: [todoCard('t')] }, en);
    expect(band.groups.map((g) => g.label)).toEqual(['Needs attention', 'Running', 'Pending review']);
    expect(band.groups[0]!.summary).toBe("Needs input 1, today's reminders 0");
    expect(band.groups[0]!.rows[0]!.trail).toEqual([{ text: 'Waiting 12分', tone: 'wait' }]);
  });
});

describe('presentHomeBand の追加の群（4 つ目の錠剤）', () => {
  const unresolved: BandGroup = { id: 'unresolved', label: '場所の不明なプロジェクト', icon: 'alert', tone: 'default', count: 2, summary: '', morning: false, rows: [] };

  it('渡した群を、3 つの後ろにそのまま足す', () => {
    const band = presentHomeBand(none, ja, [unresolved]);
    expect(ids(band.groups)).toEqual(['attention', 'running', 'pending', 'unresolved']);
    expect(band.groups[3]).toBe(unresolved);
  });

  it('追加の群は朝に開く群の候補にならない（morning を立てたときだけなる）', () => {
    expect(presentHomeBand(none, ja, [unresolved]).morning).toBeNull();
    expect(presentHomeBand(none, ja, [{ ...unresolved, morning: true }]).morning).toBe('unresolved');
  });
});

describe('朝に開く群', () => {
  const g = (id: string, count: number, morning = true): BandGroup => ({ id, label: id, icon: 'check', tone: 'default', count, summary: '', morning, rows: [] });

  it('要対応があれば要対応、無ければ実行中、それも無ければ確認待ち', () => {
    expect(morningGroup([g('attention', 2), g('running', 3), g('pending', 1)])).toBe('attention');
    expect(morningGroup([g('attention', 0), g('running', 3), g('pending', 1)])).toBe('running');
    expect(morningGroup([g('attention', 0), g('running', 0), g('pending', 1)])).toBe('pending');
  });

  it('どれも 0 件なら、開く群は無い', () => {
    expect(morningGroup([g('attention', 0), g('running', 0), g('pending', 0)])).toBeNull();
    expect(presentHomeBand(none, ja).morning).toBeNull();
  });

  it('presentHomeBand が、件数から朝の群を決める', () => {
    expect(presentHomeBand({ ...none, attention: [waiting('a')], running: [running('r')] }, ja).morning).toBe('attention');
    expect(presentHomeBand({ ...none, returning: [reminder('r')] }, ja).morning).toBe('attention');
    expect(presentHomeBand({ ...none, running: [running('r')], confirm: [todoCard('t')] }, ja).morning).toBe('running');
    expect(presentHomeBand({ ...none, confirm: [todoCard('t')] }, ja).morning).toBe('pending');
  });
});

describe('行（要対応）', () => {
  it('入力待ちの行：点、名前、プロジェクト、問い、待った時間、答えるボタン', () => {
    const row = presentHomeBand({ ...none, attention: [waiting('a')] }, ja).groups[0]!.rows[0]!;
    expect(row).toMatchObject({ key: 'wait:a', lead: { kind: 'dot', live: 'waiting', aside: false }, name: '待ち a', context: 'alpha', text: '削除してよいですか', detail: null, tone: 'wait' });
    expect(row.trail).toEqual([{ text: '12分待機', tone: 'wait' }]);
    expect(row.open).toEqual({ type: 'session.open', id: 'a' });
    expect(row.actions).toEqual([{ id: 'answer', label: 'ターミナルで回答', ariaLabel: 'ターミナルで回答、待ち a', primary: true, ghost: false, intent: { type: 'session.open', id: 'a', focus: 'terminal' } }]);
  });

  it('答え方で、ボタンの語と Intent が変わる', () => {
    const act = (answer: AttentionCard['answer']) => presentHomeBand({ ...none, attention: [waiting('a', { answer })] }, ja).groups[0]!.rows[0]!.actions[0]!;
    expect(act('attach')).toMatchObject({ label: 'ターミナルで回答', intent: { type: 'session.attach', id: 'a' } });
    expect(act('adopt')).toMatchObject({ label: 'hangar に移動', intent: { type: 'session.adopt', id: 'a' } });
    expect(act(null)).toMatchObject({ label: '開く', primary: false, intent: { type: 'session.open', id: 'a' } });
  });

  it('外部ターミナルで動くものは、行に注記を添える。プロジェクトが無ければ未分類', () => {
    const row = presentHomeBand({ ...none, attention: [waiting('a', { answer: 'adopt', projectName: null })] }, ja).groups[0]!.rows[0]!;
    expect(row.context).toBe('未分類 · 外部ターミナルで実行中');
  });

  it('今日のリマインダーの行：戻る日の札、理由、開く・日付を変更・Done', () => {
    const row = presentHomeBand({ ...none, returning: [reminder('r', { returnOn: '2026-09-29', overdueDays: 3 })] }, ja).groups[0]!.rows[0]!;
    expect(row).toMatchObject({ key: 'return:r', lead: { kind: 'tag', text: '3 日過ぎ', tone: 'due' }, name: '戻る r', context: 'alpha', text: '結果を確かめる', tone: null, trail: [] });
    expect(row.actions.map((a) => [a.id, a.label, a.ariaLabel, a.primary, a.ghost])).toEqual([
      ['open', '開く', '開く、戻る r', false, false],
      ['changeDate', '日付を変更', '日付を変更、戻る r', false, true],
      ['done', 'Done', 'Done、戻る r', false, true],
    ]);
    expect(row.actions.map((a) => a.intent)).toEqual([
      { type: 'session.open', id: 'r' },
      { type: 'session.pause.open', id: 'r', from: 'menu' },
      { type: 'session.state.set', id: 'r', status: 'done' },
    ]);
  });

  it('戻る時刻の前の札は「まだ」の調子（soft）で、日付の無いものは日付なし', () => {
    const rows = presentHomeBand({ ...none, returning: [reminder('soon', { returnTime: '15:00', due: false }), reminder('x', { returnOn: null, overdueDays: null })] }, ja).groups[0]!.rows;
    expect(rows[0]!.lead).toEqual({ kind: 'tag', text: '今日 15:00', tone: 'soon', title: 'リマインダーの時刻 15:00' });
    expect(rows[1]!.lead).toEqual({ kind: 'tag', text: '日付なし', tone: 'due' });
  });
});

describe('行（実行中）', () => {
  const one = (r: RunningCard) => presentHomeBand({ ...none, running: [r] }, ja).groups[1]!.rows[0]!;

  it('作業中：意図を本文に、いまの手を等幅の詳細に、経過とコンテキストを末尾に', () => {
    const row = one(running('a', { intent: '金額の上限のテストを足す', activity: { tool: 'Edit', summary: 'src/limit.ts' } }));
    expect(row).toMatchObject({ key: 'run:a', lead: { kind: 'dot', live: 'busy', aside: false }, name: '動く a', context: 'alpha · opus', text: '金額の上限のテストを足す', detail: 'Edit src/limit.ts', tone: null });
    expect(row.trail).toEqual([{ text: '作業中 5分', tone: 'busy' }, { text: '40%' }]);
    expect(row.actions).toEqual([]);
    expect(row.open).toEqual({ type: 'session.open', id: 'a' });
  });

  it('意図が無く手だけのとき、本文は空で詳細だけを出す。ツール名だけなら、ツール名だけ', () => {
    expect(one(running('a', { activity: { tool: 'Bash', summary: 'npm test' } }))).toMatchObject({ text: '', detail: 'Bash npm test' });
    expect(one(running('a', { activity: { tool: 'Read', summary: '' } }))).toMatchObject({ text: '', detail: 'Read' });
  });

  it('アイドルと起動中は、決まりの一言を本文にし、作業中の経過を出さない', () => {
    const row = one(running('a', { live: 'idle', note: 'アイドル 3分', contextPercent: null, contextLabel: '' }));
    expect(row).toMatchObject({ text: 'アイドル 3分', detail: null, lead: { kind: 'dot', live: 'idle' } });
    expect(row.trail).toEqual([]);
  });

  it('裏だけ動いているものは、点に aside を立てる', () => {
    expect(one(running('a', { aside: true, note: 'バックグラウンドで作業中' })).lead).toEqual({ kind: 'dot', live: 'busy', aside: true });
  });
});

describe('行（確認待ち）', () => {
  it('TODO の完了の提案：名前は TODO の文、確定と却下。名前を押すとプロジェクトへ', () => {
    const row = presentHomeBand({ ...none, confirm: [todoCard('t1')] }, ja).groups[2]!.rows[0]!;
    expect(row).toMatchObject({ key: 'todo:t1', lead: { kind: 'todo' }, name: 'やる t1', context: 'alpha · 1 時間前', text: '片付いた', open: { type: 'project.open', id: 'alpha' } });
    expect(row.actions.map((a) => [a.id, a.label, a.ariaLabel, a.primary])).toEqual([['confirm', '確定', '確定、やる t1', true], ['dismiss', '却下', '却下、やる t1', false]]);
    expect(row.actions.map((a) => a.intent)).toEqual([{ type: 'todo.confirm', id: 't1' }, { type: 'todo.reject', id: 't1' }]);
  });

  it('セッションの提案：札に提案の文言。Paused のときだけ日付を変更が入る', () => {
    const rows = presentHomeBand({ ...none, confirm: [sessionCard('s1', 'paused'), sessionCard('s2', 'done')] }, ja).groups[2]!.rows;
    expect(rows[0]!.lead).toEqual({ kind: 'tag', text: 'Paused · 10/3（土）？', tone: 'cand' });
    expect(rows[0]!.context).toBe('未分類 · 2 時間前');
    expect(rows[0]!.actions.map((a) => a.id)).toEqual(['confirm', 'changeDate', 'dismiss']);
    expect(rows[0]!.actions.map((a) => a.intent)).toEqual([
      { type: 'session.state.confirm', id: 's1' },
      { type: 'session.pause.open', id: 's1', from: 'candidate' },
      { type: 'session.state.reject', id: 's1' },
    ]);
    expect(rows[1]!.actions.map((a) => a.id)).toEqual(['confirm', 'dismiss']);
    expect(rows[1]!.open).toEqual({ type: 'session.open', id: 's2' });
  });
});
