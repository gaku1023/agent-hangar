import { describe, expect, it } from 'vitest';
import type { ReadinessDto, SetupTarget } from '@agent-hangar/shared';
import { SETTINGS_SECTIONS, settingsSectionOf, translator } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore } from '../store/store.ts';
import { presentSettings } from './settings.ts';
import { clientPlatform, liveReadiness, muxInstallCommand, muxName, notifyBlockedKey, presentMux, presentMuxGuide, presentReadiness, READINESS_AT, readinessPending, toolLine, workspaceLine, type ReadinessKey } from './readiness.ts';

const READY: ReadinessDto = {
  tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, git: { path: '/usr/bin/git', ok: true, problem: null, version: '2.51.0' }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install', join: 'hangar join <token>' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};

describe('欄の下の検証（設定の B1）', () => {
  it('動かせるときは、見つかったパスと版', () => {
    expect(toolLine(ja, 'tmux', READY.tools.tmux)).toEqual({ ok: true, soft: false, text: '/opt/homebrew/bin/tmux', note: '3.4', fix: null, fixCommand: null });
  });
  it('動かせないときは、理由と直し方。tmux は入れるコマンドを添える', () => {
    expect(toolLine(ja, 'tmux', { path: null, ok: false, problem: 'unset', version: null })).toEqual({ ok: false, soft: false, text: '見つかりません', note: null, fix: null, fixCommand: 'brew install tmux' });
    expect(toolLine(ja, 'claude', { path: '/x/claude', ok: false, problem: 'notExecutable', version: null })).toMatchObject({ ok: false, text: '/x/claude には実行権がありません', fix: 'claude コマンドの絶対パスを入力してください' });
    expect(toolLine(ja, 'claude', { path: '/x', ok: false, problem: 'notFile', version: null })).toMatchObject({ text: '/x はファイルではありません' });
    expect(toolLine(ja, 'claude', { path: '/x/claude', ok: false, problem: 'missing', version: null })).toMatchObject({ text: '/x/claude が見つかりません' });
  });
  it('git は無くても動くので、弱い印にして一言添え、OS の入れ方を出す', () => {
    const missing = { path: null, ok: false, problem: 'unset' as const, version: null };
    expect(toolLine(ja, 'git', missing, 'darwin')).toEqual({ ok: false, soft: true, text: '見つかりません', note: '無くても動きます', fix: 'git をインストールしてください。無くても動きますが、ブランチと未コミットの件数は出ません', fixCommand: 'xcode-select --install' });
    expect(toolLine(ja, 'git', missing, 'win32').fixCommand).toBe('winget install --id Git.Git -e');
    expect(toolLine(ja, 'git', missing, 'linux').fixCommand).toBeNull();
    expect(toolLine(ja, 'git', READY.tools.git!)).toMatchObject({ ok: true, text: '/usr/bin/git', note: '2.51.0' });
  });
  it('Node の設定が空なら、自動で見つけた Node だと添える', () => {
    expect(toolLine(ja, 'node', READY.tools.node)).toEqual({ ok: true, soft: false, text: '/opt/homebrew/bin/node', note: 'v22.9.0、自動で見つけました', fix: null, fixCommand: null });
  });
  // 殻は Node-API が要る版以上で、アーキが同じ Node だけを使う。合わない Node は、版が古いのか、アーキが違うのかを分けて言う。
  it('Node の設定が使えないときは、フルパスでない、Node でない、版が古い、アーキが違う、を分けて言う', () => {
    expect(toolLine(ja, 'node', { path: 'node', ok: false, problem: 'notAbsolute', version: null, auto: false })).toMatchObject({ ok: false, text: 'node はフルパスではありません', fix: '同梱のサーバに合う版とアーキテクチャの Node を、node の実行ファイルのフルパスで入力してください' });
    expect(toolLine(ja, 'node', { path: '/x/node', ok: false, problem: 'notNode', version: null, auto: false })).toMatchObject({ ok: false, text: '/x/node は Node として答えません' });
    const need = { napi: 10, min: '22.14', arch: 'arm64' };
    const old = { path: '/x/node', ok: false, problem: 'wrongNode' as const, version: 'v20.18.0', auto: false, found: { version: '20.18.0', napi: 9, arch: 'arm64' }, need };
    expect(toolLine(ja, 'node', old)).toMatchObject({ ok: false, soft: false, text: '/x/node は Node 20.18.0 です。Node 22.14 以上が要ります（Node-API 10 を使うため）' });
    expect(toolLine(en, 'node', old)).toMatchObject({ text: '/x/node is Node 20.18.0. Node 22.14 or later is needed (Hangar uses Node-API 10)' });
    const x64 = { ...old, version: 'v24.21.0', found: { version: '24.21.0', napi: 10, arch: 'x64' } };
    expect(toolLine(ja, 'node', x64)).toMatchObject({ text: '/x/node は x64 用の Node です。arm64 用の Node が要ります' });
    expect(toolLine(en, 'node', x64)).toMatchObject({ text: '/x/node is a Node for x64. A Node for arm64 is needed' });
  });
  it('ワークスペースは、登録したプロジェクトの数を出し、0 件なら理由を言う', () => {
    expect(workspaceLine(ja, { ...READY.workspace, projectCount: 12 })).toEqual({ ok: true, soft: false, text: '/Users/me/workspace', note: 'プロジェクト 12 件', fix: null, fixCommand: null });
    expect(workspaceLine(ja, { ...READY.workspace, exists: false })).toMatchObject({ ok: false, soft: true, text: 'この場所が見つかりません' });
  });
});

describe('tmux の役を担う道具の入れ方', () => {
  it('その PC の OS に合わせて案内する', () => {
    expect(muxInstallCommand('darwin')).toBe('brew install tmux');
    expect(muxInstallCommand('linux')).toBe('brew install tmux');
    expect(muxInstallCommand('win32')).toBe('winget install marlocarlo.psmux');
  });
  // hangar の画面は、サーバと同じ PC のブラウザか WebView で開く。ブラウザの名乗りから OS を読む。
  it('ブラウザの名乗りから Windows を見分ける', () => {
    expect(clientPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('win32');
    expect(clientPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe('darwin');
    expect(clientPlatform(undefined)).toBe('darwin');
    // ブラウザで開いた Linux は、macOS とも Windows とも分ける。tmux の入れ方と通知の案内は macOS の側に寄る。
    expect(clientPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')).toBe('linux');
    expect(muxInstallCommand('linux')).toBe('brew install tmux');
    expect(notifyBlockedKey('linux', 'toast')).toBe('runtime.notify.blocked');
  });
  // 通知の許可は OS ごとに別の場所にある。案内の文は、画面を開いている OS の設定の名前で言う。
  it('通知が切られているときの案内の文は、Windows だけ Windows の設定を指す', () => {
    expect(notifyBlockedKey('win32', 'settings')).toBe('settings.general.notify.blockedWindows');
    expect(notifyBlockedKey('win32', 'toast')).toBe('runtime.notify.blockedWindows');
    expect(notifyBlockedKey('darwin', 'settings')).toBe('settings.general.notify.blocked');
    expect(notifyBlockedKey('darwin', 'toast')).toBe('runtime.notify.blocked');
  });
  it('Windows では、tmux が無いときに psmux の入れ方を出す', () => {
    const missing = { path: null, ok: false, problem: 'unset' as const, version: null };
    expect(toolLine(ja, 'tmux', missing, 'win32').fixCommand).toBe('winget install marlocarlo.psmux');
    expect(toolLine(ja, 'tmux', missing, 'darwin').fixCommand).toBe('brew install tmux');
  });
  it('英語：日本語を出さず、プロジェクトの数は単数と複数を使い分ける', () => {
    expect(toolLine(en, 'node', READY.tools.node)).toMatchObject({ note: 'v22.9.0, Found automatically' });
    expect(toolLine(en, 'git', { path: null, ok: false, problem: 'unset', version: null }, 'darwin')).toEqual({ ok: false, soft: true, text: 'Not found', note: 'Works without it', fix: 'Install git. hangar works without it, but branches and uncommitted counts are not shown', fixCommand: 'xcode-select --install' });
    expect(toolLine(en, 'claude', { path: '/x/claude', ok: false, problem: 'notExecutable', version: null }).text).toBe('/x/claude is not executable');
    expect(workspaceLine(en, { ...READY.workspace, projectCount: 1 })!.note).toBe('1 project');
    expect(workspaceLine(en, { ...READY.workspace, projectCount: 12 })!.note).toBe('12 projects');
  });
});

const ja = translator('ja');
const en = translator('en');
const withCompat = (over: Partial<ReadinessDto['compat']>): ReadinessDto => ({ ...READY, compat: { ...READY.compat, ...over } });
const ALL_OK: ReadinessDto = { ...READY, workspace: { ...READY.workspace, projectCount: 12 }, mcp: { ...READY.mcp, registered: true }, statusline: { ...READY.statusline, installed: true } };
const noTmux: ReadinessDto = { ...READY, tools: { ...READY.tools, tmux: { path: null, ok: false, problem: 'unset', version: null } } };
const noClaude: ReadinessDto = { ...READY, tools: { ...READY.tools, claude: { path: null, ok: false, problem: 'unset', version: null } } };
const noBoth: ReadinessDto = { ...READY, tools: { ...noTmux.tools, claude: noClaude.tools.claude } };

describe('始める前の確認の帯の群（設計書 2.11.4）', () => {
  it('済んだ数を「準備完了 N / M」で錠剤に、直すものの数を件数に、済んだ割合を進みに持つ。残りの件数の要約は持たない', () => {
    const b = presentReadiness(READY, ja)!;
    expect(b.group).toMatchObject({ id: 'readiness', label: 'セットアップの確認', countText: '準備完了 4 / 7', count: 3, progress: 57, tone: 'warn', morning: true, summary: '' });
    // 直すものが残っているので、済んだように読める ✓ ではなく、注意の印にする。
    expect(b.group.icon).toBe('alert');
  });
  it('直すものだけを 1 行ずつ。必須を先に、任意は「任意」の札を付けて後ろに置く', () => {
    const b = presentReadiness(READY, ja)!;
    expect(b.group.rows.map((r) => [r.key, r.name, r.badge ?? null])).toEqual([
      ['ready:workspace', '新しいフォルダの作成場所', null],
      ['ready:mcp', 'MCP サーバー', '任意'],
      ['ready:statusline', 'ステータスライン', '任意'],
    ]);
    expect(b.group.rows[0]).toMatchObject({ lead: { kind: 'check', tone: 'ng', label: '準備できていません' }, text: '/Users/me/workspace の直下に、Claude のセッションがあるフォルダがありません', detail: null });
    expect(b.group.rows[1]).toMatchObject({ lead: { kind: 'check', tone: 'soft', label: '未設定' }, detail: 'hangar mcp install' });
  });
  it('右端のボタンは 1 つ。親フォルダは設定を開き、MCP と statusline は命令をコピーする', () => {
    const rows = presentReadiness(READY, ja)!.group.rows;
    expect(rows.map((r) => r.actions.map((a) => [a.label, a.primary, a.send]))).toEqual([
      [['設定を開く', true, { type: 'nav.go', to: { name: 'settings', at: 'workspace' } }]],
      [['コマンドをコピー', false, { type: 'clipboard.copy', text: 'hangar mcp install' }]],
      [['コマンドをコピー', false, { type: 'clipboard.copy', text: 'hangar statusline install' }]],
    ]);
    expect(rows[1]!.actions[0]!.ariaLabel).toBe('コマンドをコピー、MCP サーバー');
  });
  it('済んだものは 1 行に畳み、開くと見つかった場所を出す。互換の未確認の版も済んだものに数える', () => {
    const b = presentReadiness(withCompat({ localVersion: '2.1.300' }), ja)!;
    expect(b.group.fold!.text).toBe('tmux、claude、git、Claude Code との互換性 は準備完了');
    expect(b.group.fold!.rows.map((r) => [r.name, r.text, r.lead])).toEqual([
      ['tmux', '/opt/homebrew/bin/tmux（3.4）', { kind: 'check', tone: 'ok', label: '準備できています' }],
      ['claude', '/Users/me/.local/bin/claude（2.3.1）', { kind: 'check', tone: 'ok', label: '準備できています' }],
      ['git', '/usr/bin/git（2.51.0）', { kind: 'check', tone: 'ok', label: '準備できています' }],
      ['Claude Code との互換性', '2.1.300（確認済みのバージョンは 2.1.292）', { kind: 'check', tone: 'info', label: '未確認のバージョン' }],
    ]);
    expect(b.group.countText).toBe('準備完了 4 / 7');
  });
  // 帯の右端の文は、始めるのに要る道具（tmux と claude）のうち足りないものだけを名指しする。揃っていれば出さない。
  it('帯の文は、足りない道具だけを名指しし、揃っていれば出さない', () => {
    expect(presentReadiness(READY, ja)!.note).toBeNull();
    expect(presentReadiness(noTmux, ja)!.note).toBe('始めるには tmux が必要です');
    expect(presentReadiness(noClaude, ja)!.note).toBe('始めるには claude が必要です');
    expect(presentReadiness(noBoth, ja)!.note).toBe('始めるには tmux と claude が必要です');
  });
  it('英語の帯の文も、足りない道具だけを名指しする', () => {
    expect(presentReadiness(READY, en)!.note).toBeNull();
    expect(presentReadiness(noTmux, en)!.note).toBe('You need tmux to start');
    expect(presentReadiness(noClaude, en)!.note).toBe('You need claude to start');
    expect(presentReadiness(noBoth, en)!.note).toBe('You need tmux and claude to start');
    expect(presentReadiness(noBoth, en)!.group.countText).toBe('Ready 2 / 7');
  });
  it('親フォルダが無いだけなら、帯は出すが右端の文は出さない', () => {
    const b = presentReadiness({ ...READY, workspace: { ...READY.workspace, exists: false } }, ja)!;
    expect(b.group.rows[0]!.key).toBe('ready:workspace');
    expect(b.note).toBeNull();
  });
  it('tmux が無ければ入れる命令をコピーさせる。パスはあるのに使えないなら設定を開く', () => {
    const row = presentReadiness(noTmux, ja, 'darwin')!.group.rows[0]!;
    expect(row).toMatchObject({ name: 'tmux', text: 'tmux がインストールされていません', detail: 'brew install tmux', lead: { tone: 'ng' } });
    expect(row.actions[0]).toMatchObject({ label: 'コマンドをコピー', send: { type: 'clipboard.copy', text: 'brew install tmux' } });
    expect(presentReadiness(noTmux, ja, 'win32')!.group.rows[0]!.detail).toBe('winget install marlocarlo.psmux');
    const broken: ReadinessDto = { ...READY, tools: { ...READY.tools, tmux: { path: '/x/tmux', ok: false, problem: 'notExecutable', version: null } } };
    const r2 = presentReadiness(broken, ja)!.group.rows[0]!;
    expect(r2).toMatchObject({ text: '/x/tmux には実行権限がありません', detail: null });
    expect(r2.actions[0]).toMatchObject({ label: '設定を開く', send: { type: 'nav.go', to: { name: 'settings', at: 'tmux' } } });
  });
  it('必須が済んで任意の行だけが残ったときは、帯ごと出さない（分母は任意を含めて数える）', () => {
    const optionalOnly: ReadinessDto = { ...READY, workspace: { ...READY.workspace, projectCount: 12 } };
    expect(readinessPending(optionalOnly)).toBe(false);
    expect(presentReadiness(optionalOnly, ja)).toBeNull();
    expect(readinessPending(READY)).toBe(true);
  });
  it('全部そろったときも出さない', () => {
    expect(readinessPending(ALL_OK)).toBe(false);
    expect(presentReadiness(ALL_OK, ja)).toBeNull();
  });
  it('互換のずれは、止めた機能のある直すものとして帯に残る。任意の札は付けず、設定を開く', () => {
    const drifting = withCompat({ localVersion: '2.1.300', driftCount: 2 });
    expect(readinessPending({ ...ALL_OK, compat: drifting.compat })).toBe(true);
    const b = presentReadiness({ ...ALL_OK, compat: drifting.compat }, ja)!;
    expect(b.group.rows.map((r) => [r.key, r.badge ?? null, r.text])).toEqual([['ready:compat', null, '変更点が 2 件あります。無効にした機能は設定で確認できます']]);
    expect(b.group.rows[0]!.actions[0]).toMatchObject({ label: '設定を開く', send: { type: 'nav.go', to: { name: 'settings', at: 'compat' } } });
    expect(b.group.countText).toBe('準備完了 6 / 7');
  });
  it('claude が使えないときの「設定を開く」は、claude のパスの欄を指す', () => {
    const broken: ReadinessDto = { ...READY, tools: { ...READY.tools, claude: { path: '/x/claude', ok: false, problem: 'notFile', version: null } } };
    const row = presentReadiness(broken, ja)!.group.rows.find((r) => r.key === 'ready:claude')!;
    expect(row.actions[0]).toMatchObject({ label: '設定を開く', send: { type: 'nav.go', to: { name: 'settings', at: 'claude' } } });
  });
  it('compat と git の無い古いサーバの答えでは、その行を出さずに 5 つで数える', () => {
    const { compat: _drop, ...older } = READY;
    const b = presentReadiness({ ...older, tools: { ...READY.tools, git: undefined } } as ReadinessDto, ja)!;
    expect(b.group.countText).toBe('準備完了 2 / 5');
    expect(b.group.rows.map((r) => r.key)).not.toContain('ready:compat');
  });
  it('statusline のスクリプトが無ければ、先に作るよう言う', () => {
    const r = presentReadiness({ ...READY, statusline: { command: null, scriptPath: null, installed: false } }, ja)!.group.rows.find((x) => x.key === 'ready:statusline')!;
    expect(r.text).toBe('Claude Code の /statusline でスクリプトを作ってから、次を実行してください');
  });
  it('文は辞書の言語で引く', () => {
    const b = presentReadiness(READY, en)!;
    expect(b.group).toMatchObject({ label: 'Setup check', countText: 'Ready 4 / 7', summary: '' });
    expect(b.group.rows.map((r) => r.badge ?? null)).toEqual([null, 'Optional', 'Optional']);
    expect(b.group.fold!.text).toBe('tmux, claude, git, Claude Code compatibility: ready');
    expect(b.note).toBeNull();
  });
});

// 段 6 の psmux の案内。帯（B1）、始める前のダイアログ（B2）、設定の状態の行（B3）が同じ事実を読む。
describe('psmux と tmux の案内', () => {
  it('Windows は psmux、ほかは tmux と呼ぶ', () => {
    expect(muxName('win32')).toBe('psmux');
    expect(muxName('darwin')).toBe('tmux');
    expect(muxName('linux')).toBe('tmux');
  });
  it('状態を、名前、インストール済みか、版、入れるコマンド、再確認の進みにまとめる', () => {
    expect(presentMux(null, 'idle', 'win32')).toBeNull();
    expect(presentMux(READY, 'idle', 'darwin')).toEqual({ name: 'tmux', windows: false, installed: true, version: '3.4', path: '/opt/homebrew/bin/tmux', command: 'brew install tmux', checking: false, stillMissing: false, outdated: null });
    expect(presentMux(noTmux, 'idle', 'win32')).toEqual({ name: 'psmux', windows: true, installed: false, version: null, path: null, command: 'winget install marlocarlo.psmux', checking: false, stillMissing: false, outdated: null });
    expect(presentMux(noTmux, 'checking', 'win32')).toMatchObject({ checking: true, stillMissing: false });
    expect(presentMux(noTmux, 'missing', 'win32')).toMatchObject({ checking: false, stillMissing: true });
    // 見つかったあとは、前の「まだ見つかりません」を引きずらない。
    expect(presentMux(READY, 'missing', 'win32')).toMatchObject({ installed: true, stillMissing: false });
  });
  it('帯の行は、Windows では psmux の名で、コピーと再確認の 2 つのボタンを持つ', () => {
    const row = presentReadiness(noTmux, ja, 'win32')!.group.rows[0]!;
    expect(row).toMatchObject({ name: 'psmux', text: 'psmux がインストールされていません', detail: 'winget install marlocarlo.psmux' });
    expect(row.actions.map((a) => [a.label, a.send])).toEqual([
      ['コマンドをコピー', { type: 'clipboard.copy', text: 'winget install marlocarlo.psmux' }],
      ['再確認', { type: 'mux.recheck' }],
    ]);
  });
  it('再確認しても無ければ、再起動が要るかもしれないと添える。確かめている間はボタンの文を変える', () => {
    expect(presentReadiness(noTmux, ja, 'win32', 'missing')!.group.rows[0]!.text).toBe('psmux がまだ見つかりません。インストールしたあと、Hangar の再起動が必要な場合があります');
    expect(presentReadiness(noTmux, ja, 'win32', 'checking')!.group.rows[0]!.actions[1]!.label).toBe('確認中…');
    expect(presentReadiness(noTmux, en, 'win32', 'missing')!.group.rows[0]!.text).toBe('psmux still not found. You may need to restart Hangar after installing it');
  });
  it('見つかったら、帯から psmux の行が消える', () => {
    const rows = presentReadiness(READY, ja, 'win32', 'idle')!.group.rows.map((r) => r.key);
    expect(rows).not.toContain('ready:tmux');
  });
  it('帯の右端の文も、Windows では psmux の名で言う', () => {
    expect(presentReadiness(noTmux, ja, 'win32')!.note).toBe('始めるには psmux が必要です');
    expect(presentReadiness(noTmux, en, 'win32')!.note).toBe('You need psmux to start');
    expect(presentReadiness(noBoth, ja, 'win32')!.note).toBe('始めるには psmux と claude が必要です');
    expect(presentReadiness(noBoth, en, 'win32')!.note).toBe('You need psmux and claude to start');
  });
  // psmux 3.4.0 未満（issue #245）。動かせるので始めるのは止めず、注意の行で設定の手順へ案内する。
  describe('古い psmux', () => {
    const OLD: ReadinessDto = { ...ALL_OK, tools: { ...ALL_OK.tools, tmux: { path: 'C:\\x\\psmux.exe', ok: true, problem: null, version: '3.3.8', outdated: { min: '3.4.0' } } } };
    it('準備が全部済んでいても、帯に注意の行を出す（既存の利用者にも届く）', () => {
      expect(readinessPending(ALL_OK)).toBe(false);
      expect(readinessPending(OLD)).toBe(true);
      const band = presentReadiness(OLD, ja, 'win32')!;
      const row = band.group.rows[0]!;
      expect(row).toMatchObject({ key: 'ready:tmux', name: 'psmux', lead: { tone: 'soft' }, text: 'psmux 3.3.8 では、端末をホイールで上へスクロールできません（プロンプトの履歴が呼ばれます）', detail: '3.4.0 以上に上げてください。手順は設定にあります' });
      expect(row.actions.map((a) => a.send)).toEqual([{ type: 'nav.go', to: { name: 'settings', at: 'tmux' } }]);
      // 始められるので、右端の「始めるには」は言わない。
      expect(band.note).toBeNull();
      expect(presentReadiness(OLD, en, 'win32')!.group.rows[0]!.text).toBe('With psmux 3.3.8, scrolling the terminal up with the mouse wheel does not work (it recalls prompt history instead)');
    });
    it('設定の節に、古いことと下限を渡す', () => {
      expect(presentMux(OLD, 'idle', 'win32')).toMatchObject({ installed: true, version: '3.3.8', outdated: { min: '3.4.0', command: 'Get-Process psmux -ErrorAction SilentlyContinue | Stop-Process -Force; winget upgrade marlocarlo.psmux; tmux -V' } });
      expect(presentMux(ALL_OK, 'idle', 'win32')!.outdated).toBeNull();
    });
  });
  it('パスはあるのに実行できないものは、再確認では直らないので設定へ案内するだけにする', () => {
    const broken: ReadinessDto = { ...READY, tools: { ...READY.tools, tmux: { path: '/x/tmux', ok: false, problem: 'notExecutable', version: null } } };
    expect(presentReadiness(broken, ja, 'darwin')!.group.rows[0]!.actions.map((a) => a.id)).toEqual(['fix']);
  });
});

describe('案内を画面へ渡す', () => {
  const store = (r: ReadinessDto | null) => ({ ...initialStore(), readiness: r });
  it('設定の props に psmux（tmux）の状態を載せ、再確認の進みも渡す', () => {
    expect(presentSettings({ ...initialState(), muxCheck: 'missing' }, store(noTmux)).mux).toMatchObject({ installed: false, stillMissing: true });
    expect(presentSettings(initialState(), store(null)).mux).toBeNull();
  });
  it('案内のダイアログは、開いているときだけ状態を返す', () => {
    expect(presentMuxGuide(initialState(), store(noTmux))).toBeNull();
    const open = { ...initialState(), overlay: { kind: 'muxGuide' as const, pending: { type: 'session.resume' as const, id: 's1' }, back: null } };
    expect(presentMuxGuide(open, store(noTmux))).toMatchObject({ mux: { installed: false } });
    expect(presentMuxGuide(open, store(READY))).toMatchObject({ mux: { installed: true, version: '3.4' } });
  });
});

// 起動しただけでは OS に通知の許可を尋ねず、確認の群に任意の行を足す（2026-10-13 の決定、9c、試作の A）。
describe('始める前の確認の通知の行（9c）', () => {
  const setup = (notifyAsk: boolean) => ({ desktop: true, running: null, notifyAsk });
  it('まだ OS に尋ねていなければ、任意の行「通知」と主ボタン「許可する」を出し、押すと受け取りを入れる（OS に尋ねる）', () => {
    const rows = presentReadiness(READY, ja, 'darwin', 'idle', setup(true))!.group.rows;
    const row = rows.find((r) => r.key === 'ready:notify')!;
    expect(row).toMatchObject({ name: '通知', badge: '任意', text: '背面のとき、入力待ちを OS の通知で知らせます', detail: null, lead: { kind: 'check', tone: 'soft' } });
    expect(row.actions.map((a) => [a.label, a.primary, a.ghost, a.send])).toEqual([
      ['許可する', true, false, { type: 'notify.set', on: true }],
      // 要らない人は、通知をオフにして行を消せる（オフにすると ask も下りる）。
      ['要らない', false, true, { type: 'notify.set', on: false }],
    ]);
    // 任意の行なので、必須の行より後ろ。
    expect(rows.at(-1)!.key).toBe('ready:notify');
  });
  it('許可済み、切られている、受け取らないと選んだとき（ask が立たない）は行を出さない', () => {
    expect(presentReadiness(READY, ja, 'darwin', 'idle', setup(false))!.group.rows.some((r) => r.key === 'ready:notify')).toBe(false);
    expect(presentReadiness(READY, ja)!.group.rows.some((r) => r.key === 'ready:notify')).toBe(false);
  });
  // 通知の行だけは、答える（許可するか要らないを押す）まで確認の群を残す（2026-10-13 の決定）。
  it('ほかの行が全部済んでも、通知の行が残っている間は確認の群を出す', () => {
    const b = presentReadiness(ALL_OK, ja, 'darwin', 'idle', setup(true))!;
    expect(b).not.toBeNull();
    expect(b.group.rows.map((r) => r.key)).toEqual(['ready:notify']);
    expect(b.note).toBeNull();
    expect(presentReadiness(ALL_OK, ja, 'darwin', 'idle', setup(false))).toBeNull();
  });
  it('English でも同じ意味で出す', () => {
    const row = presentReadiness(READY, en, 'darwin', 'idle', setup(true))!.group.rows.find((r) => r.key === 'ready:notify')!;
    expect(row).toMatchObject({ name: 'Notifications', badge: 'Optional', text: 'Get an OS notification when a session needs input while Hangar is in the background' });
    expect(row.actions.map((a) => a.label)).toEqual(['Allow', 'No thanks']);
  });
  it('設定の一般の節を指す', () => {
    expect(READINESS_AT.notify).toBe('general');
  });
});

describe('帯の行から設定の欄への対応（READINESS_AT）', () => {
  const KEYS: ReadinessKey[] = ['tmux', 'claude', 'workspace', 'projects', 'git', 'mcp', 'statusline', 'editor', 'compat', 'notify'];
  it('帯の行のすべてが、設定の節を持つ', () => {
    expect(Object.keys(READINESS_AT).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(SETTINGS_SECTIONS).toContain(settingsSectionOf(READINESS_AT[k]));
  });
  it('直すのに設定を開く行は、節だけでなく欄まで指す', () => {
    expect(READINESS_AT).toMatchObject({ tmux: 'tmux', claude: 'claude', workspace: 'workspace', compat: 'compat' });
    expect(settingsSectionOf(READINESS_AT.tmux)).toBe('tools');
    expect(settingsSectionOf(READINESS_AT.compat)).toBe('integrations');
  });
  it('git とエディタの行（0.5.0）。git は入れるコマンドをコピーし、エディタは一般の節のエディタの欄を開く。どちらも任意', () => {
    const noGit: ReadinessDto = { ...ALL_OK, tools: { ...READY.tools, git: { path: null, ok: false, problem: 'unset', version: null } }, workspace: READY.workspace };
    const row = presentReadiness(noGit, ja, 'darwin')!.group.rows.find((r) => r.key === 'ready:git')!;
    expect(row).toMatchObject({ name: 'git', badge: '任意', text: 'git が見つかりません。無くても始められますが、ブランチと未コミットの件数は出ません', detail: 'xcode-select --install', lead: { tone: 'soft' } });
    expect(row.actions[0]).toMatchObject({ label: 'コマンドをコピー', send: { type: 'clipboard.copy', text: 'xcode-select --install' } });
    expect(presentReadiness(noGit, ja, 'win32')!.group.rows.find((r) => r.key === 'ready:git')!.detail).toBe('winget install --id Git.Git -e');
    expect(presentReadiness(noGit, ja, 'linux')!.group.rows.find((r) => r.key === 'ready:git')!.actions[0]).toMatchObject({ send: { type: 'nav.go', to: { name: 'settings', at: 'tools' } } });
    // git とエディタだけが残るなら、帯は出さない（任意の行）。
    expect(readinessPending({ ...ALL_OK, tools: noGit.tools, editor: { id: 'cursor', name: 'Cursor', state: 'none', path: null } })).toBe(false);
    const noEditor: ReadinessDto = { ...READY, editor: { id: 'cursor', name: 'Cursor', state: 'none', path: null } };
    const e = presentReadiness(noEditor, ja)!.group.rows.find((r) => r.key === 'ready:editor')!;
    expect(e).toMatchObject({ name: 'エディタ', badge: '任意', text: 'Cursor が見つかりません' });
    expect(e.actions[0]).toMatchObject({ label: '設定を開く', send: { type: 'nav.go', to: { name: 'settings', at: 'editor' } } });
    const custom = presentReadiness({ ...READY, editor: { id: 'custom', name: null, state: 'none', path: 'subl' } }, ja)!.group.rows.find((r) => r.key === 'ready:editor')!;
    expect(custom.text).toBe('エディタのコマンド subl が見つかりません');
    // アプリだけでも開けるので、済んだものに数える。
    const app = presentReadiness({ ...READY, editor: { id: 'zed', name: 'Zed', state: 'app', path: '/Applications/Zed.app' } }, ja)!;
    expect(app.group.fold!.rows.find((r) => r.key === 'ready:editor')!.text).toBe('Zed（/Applications/Zed.app、アプリだけ）');
  });
  it('MCP とステータスラインは連携の節（命令をコピーする行なので、欄までは指さない）', () => {
    expect(READINESS_AT.mcp).toBe('integrations');
    expect(READINESS_AT.statusline).toBe('integrations');
  });
});

describe('始める前の確認の MCP とステータスラインの行（殻の中）', () => {
  const app: { desktop: boolean; running: SetupTarget | null } = { desktop: true, running: null };
  const rowOf = (r: ReadinessDto, key: string, setup = app) => presentReadiness(r, ja, 'darwin', 'idle', setup)!.group.rows.find((x) => x.key === key)!;
  it('設定の連携の節と同じボタンにし、書き込む先を添える', () => {
    const mcp = rowOf(READY, 'ready:mcp');
    expect(mcp.detail).toBe('/Users/me/.claude.json');
    expect(mcp.actions.map((a) => [a.label, a.primary, a.send])).toEqual([['登録…', true, { type: 'setup.run', target: 'mcp-install' }]]);
    const sl = rowOf(READY, 'ready:statusline');
    expect(sl.detail).toBe('/Users/me/.claude/statusline.sh');
    expect(sl.actions[0]!.send).toEqual({ type: 'setup.run', target: 'statusline-install' });
  });
  it('返事を待つあいだは「確認中…」、スクリプトが無ければ設定を開く', () => {
    expect(rowOf(READY, 'ready:mcp', { desktop: true, running: 'mcp-install' as const }).actions[0]!.label).toBe('確認中…');
    const none = rowOf({ ...READY, statusline: { command: null, scriptPath: null, installed: false } }, 'ready:statusline');
    expect(none.text).toBe('Claude Code の /statusline でスクリプトを作ってから、設定の連携の節で設定してください');
    expect(none.actions[0]!.send).toEqual({ type: 'nav.go', to: { name: 'settings', at: 'integrations' } });
  });
  it('ブラウザでは今までどおりコマンドをコピーする', () => {
    expect(rowOf(READY, 'ready:mcp', { desktop: false, running: null }).actions[0]!.send).toEqual({ type: 'clipboard.copy', text: 'hangar mcp install' });
  });
});

// 初日のプロジェクト（2026-10-13）。行の名前は「プロジェクト」で、この PC に解決済みのプロジェクトが 1 件以上で済み、0 件は注意（soft）。
describe('始める前の確認の「プロジェクト」の行', () => {
  const day1 = (candidates: number): ReadinessDto => ({ ...ALL_OK, workspace: { path: '', exists: false, projectCount: 0 }, projects: { resolved: 0, candidates } });
  it('プロジェクトが 0 件なら、注意の印で件数と「選ぶ…」を出し、押すと候補のダイアログを開く', () => {
    const b = presentReadiness(day1(9), ja)!;
    expect(b.group.rows.map((r) => r.key)).toEqual(['ready:projects']);
    expect(b.group.rows[0]).toMatchObject({ name: 'プロジェクト', badge: null, lead: { kind: 'check', tone: 'soft', label: '未設定' }, text: 'Claude Code と会話したフォルダが 9 件見つかりました。プロジェクトにするものを選んでください' });
    expect(b.group.rows[0]!.actions.map((a) => [a.label, a.primary, a.send])).toEqual([['選ぶ…', true, { type: 'project.candidates.open' }]]);
    expect(b.group.countText).toBe('準備完了 6 / 7');
    expect(b.note).toBeNull();
    expect(presentReadiness(day1(9), en)!.group.rows[0]!.text).toBe('Found 9 folders where you have talked with Claude Code. Choose which ones become projects');
  });
  it('候補が 0 件なら、新しいプロジェクトの作成へ案内する', () => {
    const row = presentReadiness(day1(0), ja)!.group.rows[0]!;
    expect(row.text).toBe('まだありません。新しいプロジェクトを作るか、フォルダを登録してください');
    expect(row.actions.map((a) => [a.label, a.send])).toEqual([['新しいプロジェクト…', { type: 'project.new.open' }]]);
  });
  it('1 件以上なら済みに数え、畳んだ行に件数を出す。作成場所は問わない', () => {
    const ok: ReadinessDto = { ...READY, workspace: { path: '', exists: false, projectCount: 0 }, projects: { resolved: 3, candidates: 0 } };
    // 任意の行だけが残るので、帯は出さない。済んだ行を見るため、tmux が無いときで見る。
    expect(presentReadiness(ok, ja)).toBeNull();
    const b = presentReadiness({ ...ok, tools: noTmux.tools }, ja)!;
    expect(b.group.rows.map((r) => r.key)).toEqual(['ready:tmux', 'ready:mcp', 'ready:statusline']);
    expect(b.group.fold!.text).toBe('claude、プロジェクト、git、Claude Code との互換性 は準備完了');
    expect(b.group.fold!.rows.find((r) => r.key === 'ready:projects')).toMatchObject({ name: 'プロジェクト', text: 'プロジェクト 3 件' });
    expect(readinessPending(ok)).toBe(false);
    expect(readinessPending(day1(2))).toBe(true);
  });
  // 既存の利用者（~/workspace にプロジェクトがある）は、見た目も振る舞いも変わらない（3e）。帯は出ない。
  it('作成場所にプロジェクトがある今の利用者は、帯を出さない', () => {
    expect(presentReadiness({ ...ALL_OK, projects: { resolved: 12, candidates: 0 } }, ja)).toBeNull();
  });
  it('サーバの数より、画面が持っているプロジェクトの数を優先する（登録した直後に行を消す）', () => {
    const r = day1(4);
    expect(liveReadiness(r, [{ isScratch: false, resolved: true }])!.projects).toEqual({ resolved: 1, candidates: 4 });
    expect(liveReadiness(r, [{ isScratch: true, resolved: true }, { isScratch: false, resolved: false }])!.projects).toEqual({ resolved: 0, candidates: 4 });
    // 古いサーバの答え（projects が無い）は、そのまま返す。
    expect(liveReadiness(READY, [{ isScratch: false, resolved: true }])).toBe(READY);
  });
});

describe('作成場所の欄の下の検証', () => {
  it('空なら行を出さず、無い場所は直し方、ある場所はプロジェクトの数（0 件でも ✓）', () => {
    expect(workspaceLine(ja, { path: '', exists: false, projectCount: 0 })).toBeNull();
    expect(workspaceLine(ja, { path: '/Users/me/src', exists: true, projectCount: 0 })).toEqual({ ok: true, soft: false, text: '/Users/me/src', note: 'プロジェクト 0 件', fix: null, fixCommand: null });
    // 作成場所は任意なので、決めた場所が無くても注意（soft）にとどめる。古い設定の ~/workspace がその PC に無い今の利用者で起きる（0.6.0-rc.1 の Windows の確かめ）。
    expect(workspaceLine(ja, { path: '/x', exists: false, projectCount: 0 })).toEqual({ ok: false, soft: true, text: 'この場所が見つかりません', note: null, fix: '空にするか、別の場所を選んでください', fixCommand: null });
    expect(workspaceLine(en, { path: '/x', exists: false, projectCount: 0 })).toMatchObject({ text: 'This location was not found', fix: 'Leave it empty or choose another location' });
  });
});
