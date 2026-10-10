import { describe, expect, it } from 'vitest';
import type { ReadinessDto } from '@agent-hangar/shared';
import { translator } from '@agent-hangar/shared';
import { clientPlatform, muxInstallCommand, presentReadiness, readinessPending, toolLine, workspaceLine } from './readiness.ts';

const READY: ReadinessDto = {
  tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset', version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/Users/me/workspace', exists: true, projectCount: 0 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: 'bash ~/.claude/statusline.sh', scriptPath: '/Users/me/.claude/statusline.sh', installed: false },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};

describe('欄の下の検証（設定の B1）', () => {
  it('動かせるときは、見つかったパスと版', () => {
    expect(toolLine(ja, 'tmux', READY.tools.tmux)).toEqual({ ok: true, soft: false, text: '/opt/homebrew/bin/tmux', note: '3.4', fix: null, fixCommand: null });
  });
  it('動かせないときは、理由と直し方。tmux は入れるコマンドを添える', () => {
    expect(toolLine(ja, 'tmux', { path: null, ok: false, problem: 'unset', version: null })).toEqual({ ok: false, soft: false, text: '見つかりません', note: null, fix: null, fixCommand: 'brew install tmux' });
    expect(toolLine(ja, 'claude', { path: '/x/claude', ok: false, problem: 'notExecutable', version: null })).toMatchObject({ ok: false, text: '/x/claude には実行権がありません', fix: 'claude コマンドの絶対パスを入れてください' });
    expect(toolLine(ja, 'claude', { path: '/x', ok: false, problem: 'notFile', version: null })).toMatchObject({ text: '/x はファイルではありません' });
    expect(toolLine(ja, 'claude', { path: '/x/claude', ok: false, problem: 'missing', version: null })).toMatchObject({ text: '/x/claude が見つかりません' });
  });
  it('code は無くても動くので、弱い印にして一言添える', () => {
    expect(toolLine(ja, 'code', READY.tools.code)).toEqual({ ok: false, soft: true, text: '見つかりません', note: '無くても動きます', fix: 'VS Code から code コマンドを入れてください', fixCommand: null });
  });
  it('Node の設定が空なら、自動で見つけた Node だと添える', () => {
    expect(toolLine(ja, 'node', READY.tools.node)).toEqual({ ok: true, soft: false, text: '/opt/homebrew/bin/node', note: 'v22.9.0、自動で見つけました', fix: null, fixCommand: null });
  });
  it('ワークスペースは、登録したプロジェクトの数を出し、0 件なら理由を言う', () => {
    expect(workspaceLine(ja, { ...READY.workspace, projectCount: 12 })).toEqual({ ok: true, soft: false, text: '/Users/me/workspace', note: 'プロジェクト 12 件', fix: null, fixCommand: null });
    expect(workspaceLine(ja, READY.workspace)).toMatchObject({ ok: false, text: '直下に、Claude のセッションがあるディレクトリがありません' });
    expect(workspaceLine(ja, { ...READY.workspace, exists: false })).toMatchObject({ ok: false, text: '/Users/me/workspace が見つかりません' });
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
  });
  it('Windows では、tmux が無いときに psmux の入れ方を出す', () => {
    const missing = { path: null, ok: false, problem: 'unset' as const, version: null };
    expect(toolLine(ja, 'tmux', missing, 'win32').fixCommand).toBe('winget install marlocarlo.psmux');
    expect(toolLine(ja, 'tmux', missing, 'darwin').fixCommand).toBe('brew install tmux');
  });
  it('英語：日本語を出さず、プロジェクトの数は単数と複数を使い分ける', () => {
    expect(toolLine(en, 'node', READY.tools.node)).toMatchObject({ note: 'v22.9.0, Found automatically' });
    expect(toolLine(en, 'code', READY.tools.code)).toEqual({ ok: false, soft: true, text: 'Not found', note: 'Works without it', fix: 'Install the code command from VS Code', fixCommand: null });
    expect(toolLine(en, 'claude', { path: '/x/claude', ok: false, problem: 'notExecutable', version: null }).text).toBe('/x/claude is not executable');
    expect(workspaceLine(en, { ...READY.workspace, projectCount: 1 }).note).toBe('1 project');
    expect(workspaceLine(en, { ...READY.workspace, projectCount: 12 }).note).toBe('12 projects');
    expect(workspaceLine(en, READY.workspace).text).toBe('No directory with Claude sessions directly inside it');
  });
});

const ja = translator('ja');
const en = translator('en');
const withCompat = (over: Partial<ReadinessDto['compat']>): ReadinessDto => ({ ...READY, compat: { ...READY.compat, ...over } });
const ALL_OK: ReadinessDto = { ...READY, workspace: { ...READY.workspace, projectCount: 12 }, mcp: { ...READY.mcp, registered: true }, statusline: { ...READY.statusline, installed: true } };
const noTmux: ReadinessDto = { ...READY, tools: { ...READY.tools, tmux: { path: null, ok: false, problem: 'unset', version: null } } };

describe('始める前の確認の帯の群（設計書 2.11.4）', () => {
  it('6 つ中の済んだ数を錠剤に、直すものの数を件数に、済んだ割合を進みに持つ', () => {
    const b = presentReadiness(READY, ja)!;
    expect(b.group).toMatchObject({ id: 'readiness', label: 'セットアップの確認', countText: '6 つ中 3 つ', count: 3, progress: 50, tone: 'warn', morning: true, summary: '設定の残り 3 件' });
    // 直すものが残っているので、済んだように読める ✓ ではなく、注意の印にする。
    expect(b.group.icon).toBe('alert');
  });
  it('直すものだけを 1 行ずつ。必須を先に、任意は「任意」の札を付けて後ろに置く', () => {
    const b = presentReadiness(READY, ja)!;
    expect(b.group.rows.map((r) => [r.key, r.name, r.badge ?? null])).toEqual([
      ['ready:workspace', 'プロジェクトの親フォルダ', null],
      ['ready:mcp', 'MCP サーバー', '任意'],
      ['ready:statusline', 'ステータスライン', '任意'],
    ]);
    expect(b.group.rows[0]).toMatchObject({ lead: { kind: 'check', tone: 'ng', label: '準備できていません' }, text: '/Users/me/workspace の直下に、Claude のセッションがあるフォルダがありません', detail: null });
    expect(b.group.rows[1]).toMatchObject({ lead: { kind: 'check', tone: 'soft', label: '未設定' }, detail: 'hangar mcp install' });
  });
  it('右端のボタンは 1 つ。親フォルダは設定を開き、MCP と statusline は命令をコピーする', () => {
    const rows = presentReadiness(READY, ja)!.group.rows;
    expect(rows.map((r) => r.actions.map((a) => [a.label, a.primary, a.send]))).toEqual([
      [['設定を開く', true, { type: 'nav.go', to: { name: 'settings' } }]],
      [['コマンドをコピー', false, { type: 'clipboard.copy', text: 'hangar mcp install' }]],
      [['コマンドをコピー', false, { type: 'clipboard.copy', text: 'hangar statusline install' }]],
    ]);
    expect(rows[1]!.actions[0]!.ariaLabel).toBe('コマンドをコピー、MCP サーバー');
  });
  it('済んだものは 1 行に畳み、開くと見つかった場所を出す。互換の未確認の版も済んだものに数える', () => {
    const b = presentReadiness(withCompat({ localVersion: '2.1.300' }), ja)!;
    expect(b.group.fold!.text).toBe('tmux、claude、Claude Code との互換性は準備完了');
    expect(b.group.fold!.rows.map((r) => [r.name, r.text, r.lead])).toEqual([
      ['tmux', '/opt/homebrew/bin/tmux（3.4）', { kind: 'check', tone: 'ok', label: '準備できています' }],
      ['claude', '/Users/me/.local/bin/claude（2.3.1）', { kind: 'check', tone: 'ok', label: '準備できています' }],
      ['Claude Code との互換性', '2.1.300（確認済みのバージョンは 2.1.292）', { kind: 'check', tone: 'info', label: '未確認のバージョン' }],
    ]);
    expect(b.group.countText).toBe('6 つ中 3 つ');
  });
  it('帯の文は、tmux と claude がそろっていれば始められると言い、欠けていればあればと言う', () => {
    expect(presentReadiness(READY, ja)!.note).toBe('もう始められます。設定の残りは 3 件です');
    expect(presentReadiness(noTmux, ja)!.note).toBe('始めるには tmux と claude が必要です。設定の残りは 4 件です');
  });
  it('英語の帯の文は、残りが 1 件なら単数、2 件以上なら複数で言う', () => {
    const one: ReadinessDto = { ...READY, mcp: { ...READY.mcp, registered: true }, statusline: { ...READY.statusline, installed: true } };
    const two: ReadinessDto = { ...READY, statusline: { ...READY.statusline, installed: true } };
    const b1 = presentReadiness(one, en)!;
    expect(b1.group.summary).toBe('1 item left to set up');
    expect(b1.note).toBe('You can start now. 1 item left to set up');
    const b2 = presentReadiness(two, en)!;
    expect(b2.group.summary).toBe('2 items left to set up');
    expect(b2.note).toBe('You can start now. 2 items left to set up');
    expect(presentReadiness({ ...noTmux, mcp: { ...READY.mcp, registered: true }, statusline: { ...READY.statusline, installed: true } }, en)!.note).toBe('You need tmux and claude to start. 2 items left to set up');
  });
  it('tmux が無ければ入れる命令をコピーさせる。パスはあるのに使えないなら設定を開く', () => {
    const row = presentReadiness(noTmux, ja, 'darwin')!.group.rows[0]!;
    expect(row).toMatchObject({ name: 'tmux', text: '見つかりません', detail: 'brew install tmux', lead: { tone: 'ng' } });
    expect(row.actions[0]).toMatchObject({ label: 'コマンドをコピー', send: { type: 'clipboard.copy', text: 'brew install tmux' } });
    expect(presentReadiness(noTmux, ja, 'win32')!.group.rows[0]!.detail).toBe('winget install marlocarlo.psmux');
    const broken: ReadinessDto = { ...READY, tools: { ...READY.tools, tmux: { path: '/x/tmux', ok: false, problem: 'notExecutable', version: null } } };
    const r2 = presentReadiness(broken, ja)!.group.rows[0]!;
    expect(r2).toMatchObject({ text: '/x/tmux には実行権限がありません', detail: null });
    expect(r2.actions[0]).toMatchObject({ label: '設定を開く', send: { type: 'nav.go', to: { name: 'settings' } } });
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
    expect(b.group.rows.map((r) => [r.key, r.badge ?? null, r.text])).toEqual([['ready:compat', null, 'ずれが 2 件あります。無効にした機能は設定で確認できます']]);
    expect(b.group.rows[0]!.actions[0]).toMatchObject({ label: '設定を開く' });
    expect(b.group.countText).toBe('6 つ中 5 つ');
  });
  it('compat の無い古いサーバの答えでは、互換の行を出さずに 5 つで数える', () => {
    const { compat: _drop, ...older } = READY;
    const b = presentReadiness(older as ReadinessDto, ja)!;
    expect(b.group.countText).toBe('5 つ中 2 つ');
    expect(b.group.rows.map((r) => r.key)).not.toContain('ready:compat');
  });
  it('statusline のスクリプトが無ければ、先に作るよう言う', () => {
    const r = presentReadiness({ ...READY, statusline: { command: null, scriptPath: null, installed: false } }, ja)!.group.rows.find((x) => x.key === 'ready:statusline')!;
    expect(r.text).toBe('Claude Code の /statusline でスクリプトを作ってから、次を実行してください');
  });
  it('文は辞書の言語で引く', () => {
    const b = presentReadiness(READY, en)!;
    expect(b.group).toMatchObject({ label: 'Setup check', countText: '3 of 6', summary: '3 items left to set up' });
    expect(b.group.rows.map((r) => r.badge ?? null)).toEqual([null, 'Optional', 'Optional']);
    expect(b.group.fold!.text).toBe('tmux, claude, Claude Code compatibility: ready');
    expect(b.note).toBe('You can start now. 3 items left to set up');
  });
});
