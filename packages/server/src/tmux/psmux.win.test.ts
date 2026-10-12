import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PSMUX, psmuxNamespace, psmuxTestEnv } from '../../test/psmux.ts';
import { waitFor } from '../../test/tmux.ts';
import { runCommand } from '../launch/command.ts';
import { ensureWrapperScript, runLogPath } from '../launch/wrapper.ts';
import { nodePtySpawn } from '../pty/nodePty.ts';
import { psmuxPaneOps } from './pane.ts';
import { MuxServers } from './servers.ts';
import { Tmux } from './tmux.ts';

// Windows の psmux を相手にした確かめ。macOS と Linux、psmux の無い Windows では丸ごと飛ぶ。
describe.skipIf(!PSMUX)('Tmux（実物の psmux）', () => {
  // describe の本体は飛ばすときにも走るので、置き場を作るのは psmux があるときだけにする。
  const env = PSMUX ? psmuxTestEnv() : {};
  const tmux = new Tmux({ tmuxPath: PSMUX ?? 'psmux', socketName: psmuxNamespace(), env });
  const made: string[] = [];
  const cwd = PSMUX ? fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-psmux-')) : os.tmpdir();
  const start = (name: string, command: string[], env?: Record<string, string>): void => {
    made.push(name);
    tmux.newSession({ name, cwd, command, env });
  };
  // 止めるのは自分が作ったセッションだけ。kill-server は呼ばない。
  afterEach(() => { while (made.length) tmux.killSession(made.pop()!); });

  it('サーバが無いうちは空の一覧を返す', () => {
    expect(new Tmux({ tmuxPath: PSMUX!, socketName: psmuxNamespace(), env }).listSessions()).toEqual([]);
  });

  // 試験が利用者の psmux に触れないことの確かめ。psmux を上げたら、まずこれを見る。
  it('置き場を分けたセッションは、利用者の置き場からは見えず、予備のサーバも残さない', async () => {
    start('hangar-iso', ['cmd.exe']);
    const ns = (tmux as unknown as { socketName: string }).socketName;
    const users = new Tmux({ tmuxPath: PSMUX!, socketName: ns });
    expect(users.hasSession('hangar-iso')).toBe(false);
    expect(fs.readdirSync(env.PSMUX_DATA_DIR!).some((f) => f.includes('hangar-iso'))).toBe(true);
    expect(fs.readdirSync(env.PSMUX_DATA_DIR!).some((f) => f.includes('__warm__'))).toBe(false);
    tmux.killSession('hangar-iso');
    made.pop();
    await waitFor(() => !fs.readdirSync(env.PSMUX_DATA_DIR!).some((f) => f.includes('hangar-iso')), 10_000);
  });

  // 前の版は psmux の既定の名前空間にセッションを作っていた。ここでは別の試験用の名前空間で模す。利用者の psmux には触れない。
  it('前の版の名前空間に残ったセッションは、専用の名前空間へ移った後もそこで扱い、新しい画面は専用の名前空間に作る', async () => {
    const legacy = new Tmux({ tmuxPath: PSMUX!, socketName: `${psmuxNamespace()}-old`, env });
    legacy.newSession({ name: 'hangar-0a0a', cwd, command: ['cmd.exe'] });
    try {
      const panes = psmuxPaneOps(new MuxServers(tmux, legacy));
      expect(panes.list()).toContain('hangar-0a0a');
      made.push('hangar-1b1b');
      panes.open({ name: 'hangar-1b1b', cwd, command: ['cmd.exe'] });
      expect(tmux.hasSession('hangar-1b1b')).toBe(true);
      expect(legacy.hasSession('hangar-1b1b')).toBe(false);
      panes.close('hangar-0a0a');
      await waitFor(() => !legacy.hasSession('hangar-0a0a'), 10_000);
    } finally {
      legacy.killSession('hangar-0a0a');
    }
  });

  it('切り離して作り、完全一致で見つけ、名指しで止める', async () => {
    start('hangar-a1', ['cmd.exe']);
    start('hangar-a1-t1', ['cmd.exe']);
    expect(tmux.hasSession('hangar-a1')).toBe(true);
    // 前方一致に落ちない。hangar-a は hangar-a1 に当たらない。
    expect(tmux.hasSession('hangar-a')).toBe(false);
    expect(tmux.listSessions()!.sort()).toEqual(['hangar-a1', 'hangar-a1-t1']);
    tmux.killSession('hangar-a1');
    await waitFor(() => !tmux.hasSession('hangar-a1'));
    expect(tmux.hasSession('hangar-a1-t1')).toBe(true);
  });

  it('作業フォルダと環境変数を渡す。日本語の値も壊さない', async () => {
    start('hangar-env', ['cmd.exe', '/k', 'echo [%HANGAR_NOTE%] & cd'], { HANGAR_NOTE: '日本語の値' });
    await waitFor(() => tmux.capturePane('hangar-env').includes('[日本語の値]'), 10_000);
    expect(tmux.capturePane('hangar-env').toLowerCase()).toContain(fs.realpathSync(cwd).toLowerCase());
  });

  it('文字をそのまま送り、画面から読む', async () => {
    start('hangar-keys', ['cmd.exe']);
    await waitFor(() => tmux.capturePane('hangar-keys').includes('>'), 10_000);
    tmux.sendKeys('hangar-keys', '-l', 'echo {q} 日本語');
    tmux.sendKeys('hangar-keys', 'Enter');
    await waitFor(() => tmux.capturePane('hangar-keys').split('\n').some((l) => l.trim() === '{q} 日本語'), 10_000);
  });

  // RunManager が使う口を、そのまま実物の psmux に通す。
  it('PaneOps 越しに、画面を作り、文字を送って読み、名指しで止める', async () => {
    const panes = psmuxPaneOps(tmux);
    made.push('hangar-pane');
    panes.open({ name: 'hangar-pane', cwd, command: ['cmd.exe', '/k', 'echo [%HANGAR_NOTE%]'], env: { HANGAR_NOTE: '日本語の値' } });
    expect(panes.list()).toContain('hangar-pane');
    await waitFor(() => panes.capture('hangar-pane').includes('[日本語の値]'), 10_000);
    panes.sendText('hangar-pane', 'echo {q} 日本語');
    // Enter は PaneOps の口には無い（文字としては送らない）。実績のある Tmux の口で押す。
    tmux.sendKeys('hangar-pane', 'Enter');
    await waitFor(() => panes.capture('hangar-pane').split('\n').some((l) => l.trim() === '{q} 日本語'), 10_000);
    // 外の端末のための設定は入れない。呼んでも失敗せず、psmux の状態も変えない。
    panes.prepareForOutsideTerminals();
    panes.close('hangar-pane');
    made.pop();
    await waitFor(() => !panes.list()!.includes('hangar-pane'), 10_000);
    // 無い名前を止めても黙って通る。
    panes.close('hangar-pane');
  }, 40_000);

  it('無い作業フォルダは、作る前に断る', () => {
    expect(() => tmux.newSession({ name: 'hangar-nocwd', cwd: path.join(cwd, 'nope'), command: ['cmd.exe'] })).toThrow(/cwd not found/);
    expect(tmux.hasSession('hangar-nocwd')).toBe(false);
  });

  // hangar の画面の端末は、接続ごとに node-pty で attach を起こす。2 つのタブで同じセッションを開ける必要がある。
  it('node-pty 越しに 2 つの口からつなぎ、片方が抜けてもセッションは残る', async () => {
    // 打ち始めるのは、両方の口が画面の中身（ATT_READY）を描いてからにする。
    // psmux の attach は、画面を描く前に、外の端末へ色の問い合わせ（OSC 10/11/4 など）を書き、最大 500ms のあいだ入力を答えとして読み捨てる。
    // node-pty は答えないので、その間に打った文字は消える。
    // 以前は何かが出たら（length > 0）打っていたが、最初に出るのは ConPTY の初めの制御列とその問い合わせなので、読み捨ての最中に打つことがあり、
    // from-a がどちらの口にも出ないまま 10 秒で時間切れになった（CI の windows で 10.6 秒の失敗が続いた。ふだんは全体で 2.5 秒）。
    const ATT_READY = 'att-ready';
    start('hangar-att', ['cmd.exe', '/k', `echo ${ATT_READY}`]);
    const open = () => {
      let out = '';
      const p = nodePtySpawn(tmux.tmuxPath, tmux.attachArgs('hangar-att'), { name: 'xterm-256color', cols: 100, rows: 30, cwd: os.homedir(), env: { ...process.env, ...env } });
      p.onData((d) => { out += d; });
      return { p, text: () => out };
    };
    const a = open();
    const b = open();
    try {
      await waitFor(() => a.text().includes(ATT_READY) && b.text().includes(ATT_READY), 10_000);
      a.p.write('echo from-a\r');
      await waitFor(() => a.text().includes('from-a') && b.text().includes('from-a'), 10_000);
      a.p.kill();
      await new Promise((r) => setTimeout(r, 1000));
      expect(tmux.hasSession('hangar-att')).toBe(true);
      b.p.write('echo from-b\r');
      await waitFor(() => b.text().includes('from-b'), 10_000);
    } finally {
      try { a.p.kill(); } catch { /* 既に終わっている */ }
      try { b.p.kill(); } catch { /* 既に終わっている */ }
    }
  }, 40_000);

  // hangar が claude を起こすときと同じ組み立てを、psmux の上で通す。
  it('Node の包み越しにコマンドを起こし、終了コードと HANGAR_RUN_ID を受け取る', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar home 空白-'));
    const out = path.join(home, 'got.json');
    const wrapper = ensureWrapperScript(home);
    const log = runLogPath(home, 'r1');
    const code = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify([process.argv.slice(1), process.env.HANGAR_RUN_ID]))`;
    const wrapped = runCommand({ runId: 'r1', wrapper, log, command: [process.execPath, '-e', code, '1 行目\n2 行目', 'a "b" c'] });
    start('hangar-wrap', wrapped.command, wrapped.env);
    await waitFor(() => fs.existsSync(out), 15_000);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual([['1 行目\n2 行目', 'a "b" c'], 'r1']);
    await waitFor(() => /exit=0/.test(fs.readFileSync(log, 'utf8')), 10_000);
    // 正常に終わった包みは Enter を待たずに閉じ、セッションも消える。
    await waitFor(() => !tmux.hasSession('hangar-wrap'), 10_000);
    made.pop();
  }, 40_000);
});
