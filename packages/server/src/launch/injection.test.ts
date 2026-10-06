import { describe, expect, it } from 'vitest';
import { renderInjection } from './injection.ts';

const todo = (n: number | string) => ({ id: `id${n}`, text: `t${n}` });

describe('renderInjection', () => {
  it('テンプレートの各要素を埋める', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', memo: 'メモ本文', todos: [{ id: 'ta', text: 'a' }, { id: 'tb', text: 'b' }] });
    expect(t).toContain('あなたは agent-hangar から起動されたセッションです。');
    expect(t).toContain('プロジェクト：alpha（/w/alpha）');
    expect(t).toContain('プロジェクトのメモの要約：メモ本文');
    expect(t).toContain('未完の TODO：\n- [ta] a\n- [tb] b');
    expect(t).toContain('search_sessions と get_transcript');
    expect(t).toContain('set_session_summary');
    expect(t).toContain('TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。\n完了にするのは利用者です。確かめられていないものは出さないでください。');
    expect(t).toContain('ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。\nBash と Agent の description は日本語で 20 字以内にしてください。\n');
  });
  it('区切りで状態を聞く 4 行を、TODO の 2 行と意図の行の間に置く', () => {
    const t = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: [] });
    expect(t).toContain([
      '完了にするのは利用者です。確かめられていないものは出さないでください。',
      '頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <戻る日。時刻に意味があれば時刻も>（何を確かめに戻るか）」「まだ続ける」です。',
      '利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。',
      'Paused の戻る日は return_on（YYYY-MM-DD）に、確かめる時刻が決まっているときは return_time（HH:MM、手元の時刻）にも渡してください。時刻を note の文だけに書かないでください。',
      '途中のターンでは聞かないでください。',
      'ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。',
    ].join('\n'));
  });
  it('メモは 500 字、TODO は 10 件に切り、無ければ（なし）', () => {
    const t = renderInjection({ projectName: 'p', projectPath: '/p', memo: 'あ'.repeat(600), todos: Array.from({ length: 12 }, (_, i) => todo(i)) });
    expect(t).toContain('あ'.repeat(500) + '\n');
    expect(t).not.toContain('あ'.repeat(501));
    expect(t).toContain('- [id9] t9\n');
    expect(t).not.toContain('- [id10] t10');
    const e = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: [] });
    expect(e).toContain('プロジェクトのメモの要約：（なし）');
    expect(e).toContain('未完の TODO：（なし）');
  });
  it('メモはちょうど 500 字なら切らず、501 字なら最後の 1 字だけを落とす', () => {
    // 境界を直接踏む。末尾に目印を置くと、1 字ずれても見分けられる。
    const at500 = renderInjection({ projectName: 'p', projectPath: '/p', memo: 'あ'.repeat(499) + '印', todos: [] });
    expect(at500).toContain('プロジェクトのメモの要約：' + 'あ'.repeat(499) + '印\n');
    const at501 = renderInjection({ projectName: 'p', projectPath: '/p', memo: 'あ'.repeat(500) + '印', todos: [] });
    expect(at501).toContain('プロジェクトのメモの要約：' + 'あ'.repeat(500) + '\n');
    expect(at501).not.toContain('印');
  });
  it('TODO はちょうど 10 件なら全部、11 件なら 11 件目だけを落とす', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => todo(i + 1));
    const at10 = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: items(10) });
    expect(at10).toContain('未完の TODO：\n' + items(10).map((t) => `- [${t.id}] ${t.text}`).join('\n') + '\n');
    const at11 = renderInjection({ projectName: 'p', projectPath: '/p', memo: null, todos: items(11) });
    expect(at11).toContain('- [id10] t10\n');
    expect(at11).not.toContain('- [id11] t11');
  });
});
