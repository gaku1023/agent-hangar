import { describe, expect, it } from 'vitest';
import { renderInjection } from './injection.ts';

const todo = (n: number | string) => ({ id: `id${n}`, text: `t${n}` });

/** 常に足す段（launch.injection.body）。 */
const BODY_JA = [
  'あなたは agent-hangar から起動されたセッションです。',
  'プロジェクト：alpha（/w/alpha）',
  '未完の TODO：',
  '- [ta] a',
  '過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。',
  '依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、',
  'set_session_summary で題名、2〜3 文の要約、進捗、次のステップを更新してください。',
  'TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。',
  '完了にするのはユーザーです。確認できていないものは出さないでください。',
];
/** 区切りの問いの段（launch.injection.status）。明確に終わったときだけ聞く。 */
const STATUS_JA = [
  '頼まれたことが明確に終わったときだけ、そのターンの終わりに AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <リマインダーの日付。時刻に意味があれば時刻も>（理由。何を確認しに戻るか）」「まだ続ける」です。',
  '明確に終わったときとは、ユーザーが終わりを告げたとき（「ありがとう」「ここまで」「マージした」「今日はここまで」など）、頼まれたことが全部済んで次のステップが残っていないとき、ユーザーが外の出来事（CI、レビュー、明日の確認など）を待つと言ったときです。',
  '一手が済んだだけのとき、質問に答えただけのとき、修正のやりとりの途中、ユーザーが次の指示を続けているとき、次のステップが残っているときは聞かないでください。迷ったら聞かないでください。',
  '聞かないときは、set_session_summary の進捗を正直に書いてください。待ちが明らかなら、propose_session_status に confirmed なしで提案だけ出してください。',
  'ユーザーが Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。',
  'Paused のリマインダーの日付は return_on（YYYY-MM-DD）に、確認する時刻が決まっているときは return_time（HH:MM、この PC の時刻）にも渡してください。時刻を note の文だけに書かないでください。',
];
/** ターンの意図と短い手の説明の段（launch.injection.live）。 */
const LIVE_JA = [
  'ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。',
  'Bash と Agent の description は日本語で短く（20 字程度）書いてください。',
];
const joined = (...parts: string[][]) => [...parts.flat(), ''].join('\n');

describe('renderInjection', () => {
  it('テンプレートの各要素を埋める', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }, { id: 'tb', text: 'b' }] });
    expect(t).toContain('あなたは agent-hangar から起動されたセッションです。');
    expect(t).toContain('プロジェクト：alpha（/w/alpha）');
    expect(t).not.toContain('ノート');
    expect(t).toContain('未完の TODO：\n- [ta] a\n- [tb] b');
    expect(t).toContain('search_sessions と get_transcript');
    expect(t).toContain('set_session_summary');
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

  it('既定では、常に足す段、区切りの問いの段、ターンの意図の段をこの順に並べる', () => {
    const input = { projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] };
    expect(renderInjection(input)).toBe(joined(BODY_JA, STATUS_JA, LIVE_JA));
    expect(renderInjection(input, 'ja', { askStatusAtEnd: true, liveHints: true })).toBe(joined(BODY_JA, STATUS_JA, LIVE_JA));
  });
  it('区切りの問いを切ると、問いの段を足さない', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] }, 'ja', { askStatusAtEnd: false, liveHints: true });
    expect(t).toBe(joined(BODY_JA, LIVE_JA));
    expect(t).not.toContain('AskUserQuestion');
    expect(t).not.toContain('propose_session_status');
  });
  it('ターンの意図と短い手の説明を切ると、その段を足さない', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] }, 'ja', { askStatusAtEnd: true, liveHints: false });
    expect(t).toBe(joined(BODY_JA, STATUS_JA));
    expect(t).not.toContain('set_turn_intent');
    expect(t).not.toContain('description');
  });
  it('両方を切ると、常に足す段だけになる', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] }, 'ja', { askStatusAtEnd: false, liveHints: false });
    expect(t).toBe(joined(BODY_JA));
  });

  it('英語では、指示の全部が英語になり、求めることを 1 つも落とさない', () => {
    const input = { projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] };
    const en = renderInjection(input, 'en');
    expect(en).not.toMatch(/[぀-ヿ一-鿿＀-￯]/);
    // 行の数は日本語と同じである。1 行が 1 つの求めに当たる。段ごとにも同じである。
    for (const opts of [{ askStatusAtEnd: true, liveHints: true }, { askStatusAtEnd: false, liveHints: true }, { askStatusAtEnd: true, liveHints: false }, { askStatusAtEnd: false, liveHints: false }]) {
      expect(renderInjection(input, 'en', opts).split('\n').length, JSON.stringify(opts)).toBe(renderInjection(input, 'ja', opts).split('\n').length);
    }
    expect(en).toContain('Project: alpha (/w/alpha)');
    expect(en).not.toContain('note:');
    expect(en).toContain('Open to-dos: \n- [ta] a');
    // 呼ぶ道具と引数の名前は、どれも残る。
    for (const name of ['search_sessions', 'get_transcript', 'set_session_summary', 'update_project', 'propose_done', 'AskUserQuestion', 'propose_session_status', 'confirmed: true', 'without confirmed', 'return_on (YYYY-MM-DD)', 'return_time (HH:MM, local time)', 'set_turn_intent', 'Bash and Agent']) expect(en, name).toContain(name);
    // してはいけないことも残る。
    expect(en).toContain('Only the user marks a to-do as done. Do not suggest anything that has not been verified.');
    expect(en).toContain('Do not write the time only in the note text.');
    expect(en).toContain('When in doubt, do not ask.');
    // 明確に終わったときだけ聞く。
    expect(en).toContain('Only when the work is clearly finished');
    // 選択肢は用語集の語にする。
    expect(en).toContain('"Mark as Done", "Paused · <reminder date, plus the time if the time matters> (what to come back and check)", and "Keep going"');
    // 手の説明は短く。字数の上限ではなく目安で言う。
    expect(en).toContain('briefly (about 40 characters)');
    expect(en).not.toContain('or fewer');
  });
  it('英語でも、切った段は足さない', () => {
    const input = { projectName: 'alpha', projectPath: '/w/alpha', todos: [] };
    expect(renderInjection(input, 'en', { askStatusAtEnd: false, liveHints: true })).not.toContain('AskUserQuestion');
    expect(renderInjection(input, 'en', { askStatusAtEnd: true, liveHints: false })).not.toContain('set_turn_intent');
  });
  it('英語では、TODO が無いときの語も英語になる', () => {
    const en = renderInjection({ projectName: 'p', projectPath: '/p', todos: [] }, 'en');
    expect(en).toContain('Open to-dos: (none)');
  });
});

/** 引き継ぎの段に渡す事実の例。架空の PC 名とパスである。 */
const FACTS = {
  prevDevice: 'work-pc', prevPlatform: 'win32', prevPath: 'D:\\src\\app',
  device: 'this-mac', platform: 'darwin', path: '/Users/me/src/app',
  lastAt: new Date(2026, 9, 12, 18, 5).getTime(), branch: 'feature/x',
  editedCount: 3, missing: ['src/new.ts'], missingCount: 1,
};
const BASE = { projectName: 'alpha', projectPath: '/Users/me/src/app', todos: [] };

describe('renderInjection の PC をまたぐ段', () => {
  it('引き継ぎの段は、前と今の PC、時刻、パス、ブランチ、無いファイルを埋め、基本の段の直後に置く', () => {
    const t = renderInjection({ ...BASE, handover: FACTS });
    expect(t).toContain('この会話は work-pc（Windows）で 2026-10-12 18:05 まで進め、作業ディレクトリは D:\\src\\app でした。現在は this-mac（macOS）の /Users/me/src/app で続けています。\n');
    expect(t).toContain('同期されたのは会話のトランスクリプトと hangar の記録だけです。ファイル、git の作業ツリー、未コミットの変更、環境（インストール、環境変数、シークレット）は同期されていません。\n');
    expect(t).toContain('この PC では /Users/me/src/app からの相対パスで読み替え、前の PC の絶対パスをそのまま使わないでください。\n');
    expect(t).toContain('会話の終わりのブランチは feature/x でした。この会話で編集したファイル 3 件のうち、この PC に無いもの：1 件\n- src/new.ts\n');
    expect(t).toContain('git status と git log -1 と現在のブランチを見て');
    expect(t).toContain('AskUserQuestion で聞いてください。選択肢は「この PC で環境をそろえて続ける（足りないものを一緒に用意する）」「前の PC からファイルを持ってくる（手順を示す。実行するのはユーザー）」「前の PC で続ける（この PC では何もしない）」「差を承知でこのまま進める」です。');
    expect(t).toContain('ssh、scp、rsync は自分で実行しないでください。1 度合っていると確認したものは、その後は疑わないでください。\n');
    const at = (s: string) => t.indexOf(s);
    expect(at('あなたは agent-hangar')).toBeLessThan(at('この会話は work-pc'));
    expect(at('この会話は work-pc')).toBeLessThan(at('頼まれたことが明確に終わったとき'));
  });
  it('分からない値は（なし）にし、無いファイルが 10 件を越えたら件数を言って末尾を省く', () => {
    const t = renderInjection({ ...BASE, handover: { ...FACTS, prevDevice: null, prevPlatform: null, lastAt: null, branch: null, missing: [], missingCount: 0 } });
    expect(t).toContain('この会話は （なし）（（なし））で （なし） まで進め');
    expect(t).toContain('会話の終わりのブランチは （なし） でした。この会話で編集したファイル 3 件のうち、この PC に無いもの：（なし）\n');
    const many = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const m = renderInjection({ ...BASE, handover: { ...FACTS, editedCount: 14, missing: many, missingCount: 12 } });
    expect(m).toContain('この PC に無いもの：12 件\n' + many.map((f) => `- ${f}`).join('\n') + '\n- …\n');
  });
  it('引き継ぎが無ければ段を足さない', () => {
    expect(renderInjection({ ...BASE, handover: null })).not.toContain('この会話は');
    expect(renderInjection(BASE)).not.toContain('同期されたのは');
  });
  it('プロジェクトを 2 台以上で使っていれば弱い 1 文を足し、1 台なら足さない', () => {
    const two = renderInjection({ ...BASE, deviceCount: 2 });
    expect(two).toContain('このプロジェクトは 2 台の PC で使っています。過去の会話のパスやファイルの状態は、この PC と違うことがあります。\n');
    expect(two.indexOf('このプロジェクトは')).toBeLessThan(two.indexOf('頼まれたことが'));
    expect(renderInjection({ ...BASE, deviceCount: 1 })).not.toContain('台の PC');
    expect(renderInjection(BASE)).not.toContain('台の PC');
  });
  it('英語でも、条件と禁止を 1 つも落とさず、行の数も日本語と同じにする', () => {
    const input = { ...BASE, handover: FACTS, deviceCount: 2 };
    const en = renderInjection(input, 'en');
    expect(en).not.toMatch(/[぀-ヿ一-鿿＀-￯]/);
    expect(en.split('\n').length).toBe(renderInjection(input, 'ja').split('\n').length);
    expect(en).toContain('work-pc (Windows)');
    expect(en).toContain('this-mac (macOS)');
    expect(en).toContain('2026-10-12 18:05');
    for (const s of ['git status', 'git log -1', 'AskUserQuestion', 'ssh, scp, or rsync', 'feature/x', '- src/new.ts', 'This project is used on 2 computers']) expect(en, s).toContain(s);
  });
});
