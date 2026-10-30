import { describe, expect, it } from 'vitest';
import { localDate, localTime, osName, t as tt, translator, type Language } from '@agent-hangar/shared';
import type { HandoverFacts } from '../runs/handover.ts';
import { DEFAULT_INJECTION_PARTS, renderInjection, renderCodexInjectionEntries, renderInjectionEntries, renderOpencodeInjectionEntries, type InjectionInput, type InjectionParts } from './injection.ts';

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
/** notify_user で知らせる段（launch.injection.notify）。 */
const NOTIFY_JA = [
  'ユーザーは複数のセッションを並べて使っており、このセッションの画面を見ていないことが多いです。返答したことは notify_user でしか伝わりません。',
  'ターンを終えてユーザーに返すたびに（依頼の結果、途中経過の報告、サブエージェントの結果がまとまったとき、ユーザーの判断が必要なときを含む）、最後の返答の前に notify_user を呼び、何が起きたかを 1 文で text に、場面を kind に書いてください。',
  'kind は、頼まれたことが済んだら "done"、ユーザーの判断や答えが必要なら "ask"、まだ途中の報告なら "progress" です。どこに知らせるかは hangar がユーザーの設定で決めるので、to は渡さないでください。',
  'AskUserQuestion で聞くときは呼ばなくて構いません（入力待ちとして別に知らせます）。',
  'ターンの途中の細かい手順のたびには呼ばないでください。',
];
/** 知らせ方を保存する段（launch.injection.notifySave）。os は Mac か Windows、rules は今の決まり。 */
const SAVE_JA = (os: string, rules: string) => [
  'ユーザーが知らせ方を言ったら（AskUserQuestion の答えを含む）、set_notify_preference で保存してください。'
  + `text にはユーザーの言葉をそのまま入れ、unread（未読の数）、os（${os} の通知）、phone（スマホの通知）のそれぞれに、知らせる場面を done、ask、progress から選んで入れます。ユーザーが触れていない出し先は、今の決まりのままにします。今の決まり：${rules}。`,
  `whileFocused（見ている間も ${os} の通知を出すか）と merge（返答と入力待ちを 1 通にまとめるか）は、ユーザーがそう言ったときだけ true か false で渡してください。`,
  '保存したら、出し先ごとにどの場面で知らせるかを返答で短く読み返してください。',
];
const RULES_DEFAULT_JA = 'unread は done・ask・progress、os は done・ask、phone は done・ask';
/** 知らせ方がまだ決まっていないときだけ足す段（launch.injection.notifyAsk）。 */
const ASK_JA = (os: string) => [
  '知らせ方がまだ決まっていません。このセッションの最初の返答の終わりには、依頼が済んだかどうか、区切りかどうかに関係なく、必ず AskUserQuestion で、どんなときに知らせてほしいかを 1 度だけ聞いてください。'
  + `選択肢は「返答のたびに未読、${os} とスマホは済んだときと判断が必要なとき（デフォルト）」「${os} とスマホにも毎回」「${os} とスマホは判断が必要なときだけ」の 3 つにし、ユーザーは Other で自由に答えられます。答えたら set_notify_preference で保存してください。`
  + 'この問いは、下の「このセッションをどうしますか」の決まり（明確に終わったときだけ聞く、迷ったら聞かない）とは別のもので、その決まりは当てはまりません。',
];
/** Mac で、知らせ方が未設定の既定の入り（Windows の CI でも同じ文になるよう、OS を指す）。 */
const MAC: InjectionParts = { askStatusAtEnd: true, liveHints: true, notifyUser: true, notify: { platform: 'darwin' } };
const NOTIFY_ALL_JA = [...NOTIFY_JA, ...SAVE_JA('Mac', RULES_DEFAULT_JA), ...ASK_JA('Mac')];
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
    expect(renderInjection(input, 'ja', MAC)).toBe(joined(BODY_JA, NOTIFY_ALL_JA, STATUS_JA, LIVE_JA));
    expect(renderInjection(input, 'ja', { askStatusAtEnd: true, liveHints: true, notify: { platform: 'darwin' } })).toBe(joined(BODY_JA, NOTIFY_ALL_JA, STATUS_JA, LIVE_JA));
  });
  it('知らせ方が決まっていれば、未設定の段は出さず、今の決まりを差し込む。出し先が空なら「出さない」と言う', () => {
    const input = { projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] };
    const rules = { text: 'x', unread: ['done' as const], os: [], phone: ['ask' as const, 'progress' as const], whileFocused: false, merge: true };
    const t = renderInjection(input, 'ja', { ...MAC, notify: { platform: 'darwin', rules, decided: true } });
    expect(t).toBe(joined(BODY_JA, NOTIFY_JA, SAVE_JA('Mac', 'unread は done、os は 出さない、phone は ask・progress'), STATUS_JA, LIVE_JA));
    expect(t).not.toContain('まだ決まっていません');
  });
  it('Windows の PC では、出し先の名前を Windows にする', () => {
    const input = { projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] };
    const t = renderInjection(input, 'ja', { ...MAC, notify: { platform: 'win32' } });
    expect(t).toBe(joined(BODY_JA, [...NOTIFY_JA, ...SAVE_JA('Windows', RULES_DEFAULT_JA), ...ASK_JA('Windows')], STATUS_JA, LIVE_JA));
    expect(t).not.toContain('Mac');
  });
  it('区切りの問いを切ると、問いの段を足さない', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] }, 'ja', { askStatusAtEnd: false, liveHints: true, notifyUser: false });
    expect(t).toBe(joined(BODY_JA, LIVE_JA));
    expect(t).not.toContain('AskUserQuestion');
    expect(t).not.toContain('propose_session_status');
  });
  it('ターンの意図と短い手の説明を切ると、その段を足さない', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] }, 'ja', { askStatusAtEnd: true, liveHints: false, notifyUser: false });
    expect(t).toBe(joined(BODY_JA, STATUS_JA));
    expect(t).not.toContain('set_turn_intent');
    expect(t).not.toContain('description');
  });
  it('両方を切ると、常に足す段だけになる', () => {
    const t = renderInjection({ projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }] }, 'ja', { askStatusAtEnd: false, liveHints: false, notifyUser: false });
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
    expect(renderInjection(input, 'en', { askStatusAtEnd: false, liveHints: true, notifyUser: false })).not.toContain('AskUserQuestion');
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
    expect(two.indexOf('このプロジェクトは')).toBeLessThan(two.indexOf('頼まれたことが明確に終わったとき'));
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

/**
 * 段に割る前の renderInjection の写し。段に割った後も、出る文字列が 1 字も変わらないことを、これと見比べて確かめる。
 */
function renderBeforeSplit(i: InjectionInput, language: Language = 'ja', parts: InjectionParts = DEFAULT_INJECTION_PARTS): string {
  const none = tt(language, 'launch.injection.none');
  const todos = i.todos.slice(0, 10);
  const todoText = todos.length ? '\n' + todos.map((todo) => `- [${todo.id}] ${todo.text}`).join('\n') : none;
  const handover = (h: HandoverFacts): string => {
    const os = (p: string | null) => osName(translator(language), p) ?? none;
    const files = h.missing.map((f) => `\n- ${f}`).join('') + (h.missingCount > h.missing.length ? '\n- …' : '');
    return tt(language, 'launch.injection.handover', {
      prevDevice: h.prevDevice ?? none, prevOs: os(h.prevPlatform),
      lastAt: h.lastAt === null ? none : `${localDate(h.lastAt)} ${localTime(h.lastAt)}`,
      prevPath: h.prevPath, device: h.device ?? none, os: os(h.platform), path: h.path,
      branch: h.branch ?? none, editedCount: String(h.editedCount),
      missing: h.missingCount === 0 ? none : tt(language, 'launch.injection.missing', { n: String(h.missingCount), files }),
    });
  };
  return [
    tt(language, 'launch.injection.body', { projectName: i.projectName, projectPath: i.projectPath, todos: todoText }),
    parts.notifyUser !== false ? tt(language, 'launch.injection.notify') : '',
    parts.notifyUser !== false ? tt(language, 'launch.injection.notifySave', { os: 'Mac', rules: tt(language, 'launch.injection.notifyRules', { unread: ['done', 'ask', 'progress'].join(tt(language, 'launch.injection.notifyJoin')), os: ['done', 'ask'].join(tt(language, 'launch.injection.notifyJoin')), phone: ['done', 'ask'].join(tt(language, 'launch.injection.notifyJoin')) }) }) : '',
    parts.notifyUser !== false ? tt(language, 'launch.injection.notifyAsk', { os: 'Mac' }) : '',
    i.handover ? handover(i.handover) : '',
    (i.deviceCount ?? 0) >= 2 ? tt(language, 'launch.injection.multiDevice', { deviceCount: String(i.deviceCount) }) : '',
    parts.askStatusAtEnd ? tt(language, 'launch.injection.status') : '',
    parts.liveHints ? tt(language, 'launch.injection.live') : '',
  ].join('');
}

describe('renderInjectionEntries', () => {
  const inputs: InjectionInput[] = [
    { ...BASE },
    { projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 'ta', text: 'a' }, { id: 'tb', text: 'b' }] },
    { projectName: 'p', projectPath: '/p', todos: Array.from({ length: 12 }, (_, i) => todo(i)) },
    { ...BASE, handover: FACTS },
    { ...BASE, handover: { ...FACTS, prevDevice: null, prevPlatform: null, lastAt: null, branch: null, missing: [], missingCount: 0 } },
    { ...BASE, handover: { ...FACTS, editedCount: 14, missing: Array.from({ length: 10 }, (_, i) => `f${i}.ts`), missingCount: 12 } },
    { ...BASE, handover: null, deviceCount: 1 },
    { ...BASE, deviceCount: 2 },
    { ...BASE, handover: FACTS, deviceCount: 3 },
  ];
  const mac = { platform: 'darwin' };
  const partsList: InjectionParts[] = [
    { askStatusAtEnd: true, liveHints: true, notify: mac }, { askStatusAtEnd: false, liveHints: true, notify: mac },
    { askStatusAtEnd: true, liveHints: false, notify: mac }, { askStatusAtEnd: false, liveHints: false, notify: mac },
    { askStatusAtEnd: true, liveHints: true, notifyUser: false }, { askStatusAtEnd: false, liveHints: false, notifyUser: false },
  ];

  it('段を順につないだ文字列は、段に割る前の renderInjection と 1 字も違わない', () => {
    for (const language of ['ja', 'en'] as const) {
      for (const input of inputs) {
        for (const parts of partsList) {
          const want = renderBeforeSplit(input, language, parts);
          const label = JSON.stringify({ language, input, parts });
          expect(renderInjectionEntries(input, language, parts).map((e) => e.text).join(''), label).toBe(want);
          expect(renderInjection(input, language, parts), label).toBe(want);
        }
      }
    }
    expect(renderInjectionEntries(BASE, 'ja', MAC).map((e) => e.text).join('')).toBe(renderBeforeSplit(BASE));
  });

  it('段は body、notify、notifySave、notifyAsk（未設定のときだけ）、handover、multiDevice、status、live の順で、足さない段は入れない', () => {
    const keys = (i: InjectionInput, parts?: InjectionParts) => renderInjectionEntries(i, 'ja', parts).map((e) => e.key);
    expect(keys({ ...BASE, handover: FACTS, deviceCount: 2 })).toEqual(['body', 'notify', 'notifySave', 'notifyAsk', 'handover', 'multiDevice', 'status', 'live']);
    expect(keys(BASE)).toEqual(['body', 'notify', 'notifySave', 'notifyAsk', 'status', 'live']);
    expect(keys(BASE, { ...MAC, notify: { decided: true } })).toEqual(['body', 'notify', 'notifySave', 'status', 'live']);
    expect(keys(BASE, { askStatusAtEnd: false, liveHints: false, notifyUser: false })).toEqual(['body']);
    expect(keys({ ...BASE, deviceCount: 2 }, { askStatusAtEnd: false, liveHints: true, notifyUser: false })).toEqual(['body', 'multiDevice', 'live']);
    for (const e of renderInjectionEntries({ ...BASE, handover: FACTS, deviceCount: 2 })) expect(e.text, e.key).not.toBe('');
  });
});

describe('renderOpencodeInjectionEntries（opencode に足す段）', () => {
  const input: InjectionInput = { projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 't1', text: '直す' }], deviceCount: 2 };

  it('最小限（既定）は、hangar の MCP の使い方の段と、状態の段。時機は各ターンの最初の一手で、Code Mode の呼び方を添える（RESULT.md の条件 d）', () => {
    const entries = renderOpencodeInjectionEntries(input, 'ja', DEFAULT_INJECTION_PARTS, 'minimal');
    expect(entries.map((e) => e.key)).toEqual(['body', 'notify', 'notifySave', 'notifyAsk', 'status']);
    expect(entries[0]!.text).toBe(
      'あなたは agent-hangar から起動されたセッションです。\n'
      + '各ターンの最初の一手で、他のツールより先に、execute で `await tools.hangar.set_turn_intent({ text: "<このターンで何のために何をするか、1〜2 文>" })` を呼んでください。方針を変えたときも呼びます。\n'
      + '依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、execute で `await tools.hangar.set_session_summary({ title, one_liner, body, state, next_steps })` を呼び、題名、2〜3 文の要約、進捗（state）、次のステップを更新してください。\n'
      + 'ユーザーがこのセッションを Done か Paused にしてと言ったら、execute で `await tools.hangar.propose_session_status({ status, note, confirmed: true })` を呼んでください。status は "done" か "paused"、note は根拠の一文です。Paused でリマインダーの日付があれば return_on（YYYY-MM-DD）に渡します。set_session_summary の state を変えても、セッションの状態は変わりません。\n');
    expect(entries.find((e) => e.key === 'status')!.text).toBe(
      '頼まれたことが全部済んで次のステップが残っていないとき、ユーザーが終わりを告げたとき（「ありがとう」「ここまで」など）は、ターンの終わりに execute で `await tools.hangar.propose_session_status({ status: "done", note })` を confirmed なしで呼び、提案だけ出してください。ユーザーが外の出来事（CI、レビュー、明日の確認など）を待つと言ったときは status: "paused" で同じようにします。\n'
      + 'ユーザーが Done か Paused にしてと言っていないのに、confirmed: true を渡さないでください。\n');
    // 英語も同じ道具と同じ時機を指す。
    const en = renderOpencodeInjectionEntries(input, 'en', DEFAULT_INJECTION_PARTS, 'minimal');
    expect(en.map((e) => e.key)).toEqual(['body', 'notify', 'notifySave', 'notifyAsk', 'status']);
    expect(en[0]!.text).toContain('tools.hangar.set_turn_intent');
    expect(en[0]!.text).toContain('tools.hangar.set_session_summary');
    expect(en[0]!.text).toContain('tools.hangar.propose_session_status({ status, note, confirmed: true })');
    expect(en[0]!.text).toMatch(/first step of every turn, before any other tool/);
    expect(en.find((e) => e.key === 'status')!.text).toContain('without confirmed');
    // 段は区切りを足さずにつなぐので、どの言語の段も改行で終わる。
    for (const e of [...entries, ...en]) expect(e.text.endsWith('\n'), e.key).toBe(true);
  });

  it('最小限でも、区切りで状態を確認する設定を切れば状態の段は足さない。頼まれたときの確定は本文に残る', () => {
    const entries = renderOpencodeInjectionEntries(input, 'ja', { askStatusAtEnd: false, liveHints: true, notifyUser: false }, 'minimal');
    expect(entries.map((e) => e.key)).toEqual(['body']);
    expect(entries[0]!.text).toContain('propose_session_status({ status, note, confirmed: true })');
  });

  it('追記しないなら段は無い', () => {
    expect(renderOpencodeInjectionEntries(input, 'ja', DEFAULT_INJECTION_PARTS, 'none')).toEqual([]);
  });

  it('Claude Code と同じなら Claude の段を使い、意図の段だけ時機を各ターンの最初の一手に書き直す（条件 g）', () => {
    const claude = renderInjectionEntries(input, 'ja');
    const oc = renderOpencodeInjectionEntries(input, 'ja', DEFAULT_INJECTION_PARTS, 'claude');
    expect(oc.map((e) => e.key)).toEqual(claude.map((e) => e.key));
    expect(oc.filter((e) => !['live', 'notify', 'notifySave', 'notifyAsk'].includes(e.key))).toEqual(claude.filter((e) => !['live', 'notify', 'notifySave', 'notifyAsk'].includes(e.key)));
    expect(oc.find((e) => e.key === 'notify')!.text).toContain('tools.hangar.notify_user');
    expect(oc.find((e) => e.key === 'live')!.text).toBe('各ターンの最初の一手で、他のツールより先に、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。方針を変えたときも呼びます。\nBash と Agent の description は日本語で短く（20 字程度）書いてください。\n');
    // 段の入り切りの設定は Claude と同じく効く。
    expect(renderOpencodeInjectionEntries(input, 'ja', { askStatusAtEnd: false, liveHints: false, notifyUser: false }, 'claude').map((e) => e.key)).toEqual(['body', 'multiDevice']);
    expect(renderOpencodeInjectionEntries(input, 'en', DEFAULT_INJECTION_PARTS, 'claude').find((e) => e.key === 'live')!.text).toMatch(/^At the first step of every turn, before any other tool/);
  });
});

describe('renderCodexInjectionEntries（Codex に足す段）', () => {
  const input: InjectionInput = { projectName: 'alpha', projectPath: '/w/alpha', todos: [{ id: 't1', text: '直す' }], deviceCount: 2 };

  it('最小限（既定）は、hangar の MCP の使い方の段と、状態の段。道具は名前で指し、opencode の Code Mode の呼び方は使わない', () => {
    const ja = renderCodexInjectionEntries(input, 'ja', DEFAULT_INJECTION_PARTS, 'minimal');
    expect(ja.map((e) => e.key)).toEqual(['body', 'notify', 'notifySave', 'notifyAsk', 'status']);
    for (const name of ['set_turn_intent', 'set_session_summary', 'propose_session_status']) expect(ja[0]!.text).toContain(name);
    expect(ja[0]!.text).toContain('confirmed: true');
    expect(ja.find((e) => e.key === 'status')!.text).toContain('confirmed なし');
    const en = renderCodexInjectionEntries(input, 'en', DEFAULT_INJECTION_PARTS, 'minimal');
    expect(en.map((e) => e.key)).toEqual(['body', 'notify', 'notifySave', 'notifyAsk', 'status']);
    expect(en[0]!.text).toMatch(/first step of every turn, before any other tool/);
    expect(en.find((e) => e.key === 'status')!.text).toContain('without confirmed');
    for (const e of [...ja, ...en]) {
      expect(e.text).not.toContain('tools.hangar');
      expect(e.text.endsWith('\n'), e.key).toBe(true);
    }
  });

  it('最小限でも、区切りで状態を確認する設定を切れば状態の段は足さない', () => {
    expect(renderCodexInjectionEntries(input, 'ja', { askStatusAtEnd: false, liveHints: true, notifyUser: false }, 'minimal').map((e) => e.key)).toEqual(['body']);
  });

  it('追記しないなら段は無い。Claude Code と同じなら Claude の段をそのまま使う', () => {
    expect(renderCodexInjectionEntries(input, 'ja', DEFAULT_INJECTION_PARTS, 'none')).toEqual([]);
    expect(renderCodexInjectionEntries(input, 'ja', DEFAULT_INJECTION_PARTS, 'claude')).toEqual(renderInjectionEntries(input, 'ja'));
  });
});

describe('notify_user の段', () => {
  const input: InjectionInput = { projectName: 'alpha', projectPath: '/w/alpha', todos: [] };
  it('Claude、opencode の最小限、Codex の最小限のどれも、notifyUser が入りなら節が入り、切なら入らない', () => {
    const off: InjectionParts = { askStatusAtEnd: true, liveHints: true, notifyUser: false };
    const key = (es: { key: string }[]) => es.map((e) => e.key).includes('notify');
    expect(key(renderInjectionEntries(input, 'ja'))).toBe(true);
    expect(key(renderInjectionEntries(input, 'ja', off))).toBe(false);
    expect(key(renderOpencodeInjectionEntries(input, 'ja', DEFAULT_INJECTION_PARTS, 'minimal'))).toBe(true);
    expect(key(renderOpencodeInjectionEntries(input, 'ja', off, 'minimal'))).toBe(false);
    expect(key(renderCodexInjectionEntries(input, 'ja', DEFAULT_INJECTION_PARTS, 'minimal'))).toBe(true);
    expect(key(renderCodexInjectionEntries(input, 'ja', off, 'minimal'))).toBe(false);
  });
  it('どの節も、to を渡さず kind で場面を添えることを言い、to で出し先を選ぶ文は持たない', () => {
    for (const language of ['ja', 'en'] as const) {
      for (const k of ['launch.injection.notify', 'launch.injection.opencode.notify', 'launch.injection.codex.notify'] as const) {
        expect(tt(language, k), k).toContain('"done"');
        expect(tt(language, k), k).toContain('"progress"');
        expect(tt(language, k), k).not.toContain("['phone']");
      }
    }
    expect(tt('ja', 'launch.injection.opencode.notify')).toContain('await tools.hangar.notify_user({ text, kind })');
    expect(tt('ja', 'launch.injection.codex.notify')).toContain('hangar の MCP サーバーの notify_user ツール');
  });
  it('opencode と Codex の最小限も、保存と未設定のときに聞く段を持つ。AskUserQuestion ではなく最初の返答の終わりに文で聞く', () => {
    const decided = { ...MAC, notify: { platform: 'win32', decided: true } };
    const oc = renderOpencodeInjectionEntries(input, 'ja', MAC, 'minimal');
    const cx = renderCodexInjectionEntries(input, 'ja', MAC, 'minimal');
    expect(oc.find((e) => e.key === 'notifySave')!.text).toContain('`await tools.hangar.set_notify_preference({ text, unread, os, phone })`');
    expect(oc.find((e) => e.key === 'notifySave')!.text).toContain('今の決まり：' + RULES_DEFAULT_JA + '。');
    expect(cx.find((e) => e.key === 'notifySave')!.text).toContain('hangar の MCP サーバーの set_notify_preference ツール');
    for (const es of [oc, cx]) {
      const ask = es.find((e) => e.key === 'notifyAsk')!.text;
      expect(ask).toContain('依頼が済んだかどうか、区切りかどうかに関係なく、必ず文で');
      expect(ask).toContain('set_notify_preference');
      expect(ask).not.toContain('AskUserQuestion');
    }
    for (const es of [renderOpencodeInjectionEntries(input, 'en', decided, 'minimal'), renderCodexInjectionEntries(input, 'en', decided, 'minimal')]) {
      expect(es.map((e) => e.key)).toEqual(['body', 'notify', 'notifySave', 'status']);
      expect(es.find((e) => e.key === 'notifySave')!.text).toContain('the Windows notification');
    }
  });
  it('どの節も、画面を見ていないことを前置きし、ターンを返すたびに最後の返答の前に呼ばせる', () => {
    for (const k of ['launch.injection.notify', 'launch.injection.opencode.notify', 'launch.injection.codex.notify'] as const) {
      expect(tt('ja', k), k).toMatch(/^ユーザーは複数のセッションを並べて使っており、このセッションの画面を見ていないことが多いです。/);
      expect(tt('ja', k), k).toContain('ターンを終えてユーザーに返すたびに');
      expect(tt('ja', k), k).toContain('最後の返答の前に');
      expect(tt('en', k), k).toMatch(/^The user runs several sessions side by side/);
      expect(tt('en', k), k).toContain('before your final reply');
    }
  });
});
