import { describe, expect, it } from 'vitest';
import { renderInjection } from './injection.ts';

const todo = (n: number | string) => ({ id: `id${n}`, text: `t${n}` });

describe('renderInjection', () => {
  it('テンプレートの各要素を埋める', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }, { id: 'tb', text: 'b' }] });
    expect(t).toContain('あなたは agent-hangar から起動されたセッションです。');
    expect(t).toContain('プロジェクト：alpha（/w/alpha）');
    expect(t).not.toContain('ノート');
    expect(t).toContain('未完の TODO：\n- [ta] a\n- [tb] b');
    expect(t).toContain('search_sessions と get_transcript');
    expect(t).toContain('set_session_summary');
    expect(t).toContain('TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。\n完了にするのは利用者です。確認できていないものは出さないでください。');
    expect(t).toContain('ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。\nBash と Agent の description は日本語で 20 字以内にしてください。\n');
  });
  it('区切りで状態を聞く 4 行を、TODO の 2 行と意図の行の間に置く', () => {
    const t = renderInjection({ projectName: 'p', projectPath: '/p', todos: [] });
    expect(t).toContain([
      '完了にするのは利用者です。確認できていないものは出さないでください。',
      '頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <リマインダーの日付。時刻に意味があれば時刻も>（理由。何を確認しに戻るか）」「まだ続ける」です。',
      '利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。',
      'Paused のリマインダーの日付は return_on（YYYY-MM-DD）に、確認する時刻が決まっているときは return_time（HH:MM、手元の時刻）にも渡してください。時刻を note の文だけに書かないでください。',
      '途中のターンでは聞かないでください。',
      'ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。',
    ].join('\n'));
  });
  it('TODO は 10 件に切り、無ければ（なし）', () => {
    const t = renderInjection({ projectName: 'p', projectPath: '/p', todos: Array.from({ length: 12 }, (_, i) => todo(i)) });
    expect(t).toContain('- [id9] t9\n');
    expect(t).not.toContain('- [id10] t10');
    const e = renderInjection({ projectName: 'p', projectPath: '/p', todos: [] });
    expect(e).toContain('未完の TODO：（なし）');
  });
  it('TODO はちょうど 10 件なら全部、11 件なら 11 件目だけを落とす', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => todo(i + 1));
    const at10 = renderInjection({ projectName: 'p', projectPath: '/p', todos: items(10) });
    expect(at10).toContain('未完の TODO：\n' + items(10).map((t) => `- [${t.id}] ${t.text}`).join('\n') + '\n');
    const at11 = renderInjection({ projectName: 'p', projectPath: '/p', todos: items(11) });
    expect(at11).toContain('- [id10] t10\n');
    expect(at11).not.toContain('- [id11] t11');
  });

  it('日本語の指示は、ノートの行を外したほかは 1 字も変わらない', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] });
    expect(t).toBe([
      'あなたは agent-hangar から起動されたセッションです。',
      'プロジェクト：alpha（/w/alpha）',
      '未完の TODO：',
      '- [ta] a',
      '過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。',
      '依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、',
      'set_session_summary で題名、2〜3 文の要約、進捗、次のステップを更新してください。',
      'TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。',
      '完了にするのは利用者です。確認できていないものは出さないでください。',
      '頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <リマインダーの日付。時刻に意味があれば時刻も>（理由。何を確認しに戻るか）」「まだ続ける」です。',
      '利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。',
      'Paused のリマインダーの日付は return_on（YYYY-MM-DD）に、確認する時刻が決まっているときは return_time（HH:MM、手元の時刻）にも渡してください。時刻を note の文だけに書かないでください。',
      '途中のターンでは聞かないでください。',
      'ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。',
      'Bash と Agent の description は日本語で 20 字以内にしてください。',
      '',
    ].join('\n'));
  });

  it('英語では、指示の全部が英語になり、求めることを 1 つも落とさない', () => {
    const input = { projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] };
    const en = renderInjection(input, 'en');
    expect(en).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/);
    // 行の数は日本語と同じである。1 行が 1 つの求めに当たる。
    expect(en.split('\n').length).toBe(renderInjection(input, 'ja').split('\n').length);
    expect(en).toContain('Project: alpha (/w/alpha)');
    expect(en).not.toContain('note:');
    expect(en).toContain('Open to-dos: \n- [ta] a');
    // 呼ぶ道具と引数の名前は、どれも残る。
    for (const name of ['search_sessions', 'get_transcript', 'set_session_summary', 'update_project', 'propose_done', 'AskUserQuestion', 'propose_session_status', 'confirmed: true', 'without confirmed', 'return_on (YYYY-MM-DD)', 'return_time (HH:MM, local time)', 'set_turn_intent', 'Bash and Agent']) expect(en, name).toContain(name);
    // してはいけないことも残る。
    expect(en).toContain('Only the user marks a to-do as done. Do not suggest anything that has not been verified.');
    expect(en).toContain('Do not write the time only in the note text.');
    expect(en).toContain('Do not ask in the turns before that.');
    // 選択肢は用語集の語にする。
    expect(en).toContain('"Mark as Done", "Paused · <reminder date, plus the time if the time matters> (what to come back and check)", and "Keep going"');
  });
  it('英語では、TODO が無いときの語も英語になる', () => {
    const en = renderInjection({ projectName: 'p', projectPath: '/p', todos: [] }, 'en');
    expect(en).toContain('Open to-dos: (none)');
  });
});
