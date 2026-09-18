import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readArgs, writeFakeClaude } from '../../test/fake-claude.ts';
import { TMUX, removeTestSocket, testSocketPath, waitFor } from '../../test/tmux.ts';
import { Tmux } from '../tmux/tmux.ts';
import { ensureWrapperScript, runLogPath, wrapperScript } from './wrapper.ts';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-wrap-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('ensureWrapperScript', () => {
  it('bin/hangar-run.sh を実行可能で書き、同じ内容なら書き直さない', () => {
    const p = ensureWrapperScript(home);
    expect(p).toBe(path.join(home, 'bin', 'hangar-run.sh'));
    expect(fs.statSync(p).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(p, 'utf8')).toBe(wrapperScript());
    const before = fs.statSync(p).mtimeMs;
    ensureWrapperScript(home);
    expect(fs.statSync(p).mtimeMs).toBe(before);
    expect(runLogPath(home, 'r1')).toBe(path.join(home, 'logs', 'run-r1.log'));
  });
});

describe('ラッパーの引用（bash を直接呼ぶ）', () => {
  it('空白と引用符を含むログのパスとコマンドの引数を、そのまま渡す', () => {
    // 引用が抜けると、ログは別々のファイルに散り、引数は単語に割れて claude に届く。
    const wrapper = ensureWrapperScript(home);
    const log = path.join(home, 'ログ の 置き場', 'run "x" it\'s.log');
    const fake = writeFakeClaude(home, { sleepSec: 0, exitCode: 0 });
    const args = ['a b', "it's", '"quoted"', '$HOME', '*', 'tab\there'];
    const r = spawnSync('bash', [wrapper, log, fake.bin, ...args], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    // 記録された最後の要素は HANGAR_RUN_ID（ここでは未設定なので空）である。
    expect(readArgs(fake.argsFile).slice(0, -1)).toEqual(args);
    expect(fs.existsSync(log)).toBe(true);
    const body = fs.readFileSync(log, 'utf8');
    expect(body).toContain(`cmd=${fake.bin}`);
    expect(body).toMatch(/exit=0/);
    // ログの置き場が単語に割れていれば、別の名前のファイルが増える。
    expect(fs.readdirSync(path.dirname(log))).toEqual([path.basename(log)]);
  });

  it('空白を含むログのパスでも、標準エラーを 1 つのファイルに複写する', async () => {
    const wrapper = ensureWrapperScript(home);
    const log = path.join(home, 'ログ dir', 'run 1.log');
    const r = spawnSync('bash', [wrapper, log, 'sh', '-c', 'echo "駄目でした" >&2; exit 0'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    // tee はプロセス置換の中で動くので、bash が終わった時点ではまだ書き終えていないことがある。
    await waitFor(() => fs.readFileSync(log, 'utf8').includes('駄目でした'));
  });
});

describe.skipIf(!TMUX)('ラッパー（tmux 上）', () => {
  const socketPath = testSocketPath();
  const tmux = new Tmux({ tmuxPath: TMUX ?? 'tmux', socketPath });
  afterAll(() => {
    tmux.killServer();
    removeTestSocket(socketPath);
  });

  it('正常終了ではすぐ閉じ、ログに exit=0 と引数が残る', async () => {
    const wrapper = ensureWrapperScript(home);
    const fake = writeFakeClaude(home, { sleepSec: 0, exitCode: 0 });
    const log = runLogPath(home, 'ok');
    tmux.newSession({
      name: 'hangar-wrap-ok',
      cwd: home,
      command: ['env', 'HANGAR_RUN_ID=ok', 'bash', wrapper, log, fake.bin, '--session-id', 'u1', 'prompt'],
    });
    await waitFor(() => !tmux.hasSession('hangar-wrap-ok'));
    expect(fs.readFileSync(log, 'utf8')).toMatch(/exit=0/);
    // 偽の claude は引数と HANGAR_RUN_ID を NUL 区切りで記録し、readArgs が配列に戻す。
    expect(readArgs(fake.argsFile)).toEqual(['--session-id', 'u1', 'prompt', 'ok']);
  });

  it('異常終了では Enter を待ってから閉じる', async () => {
    const wrapper = ensureWrapperScript(home);
    const fake = writeFakeClaude(home, { sleepSec: 0, exitCode: 3 });
    const log = runLogPath(home, 'bad');
    tmux.newSession({ name: 'hangar-wrap-bad', cwd: home, command: ['bash', wrapper, log, fake.bin] });
    await waitFor(() => fs.existsSync(log) && /exit=3/.test(fs.readFileSync(log, 'utf8')));
    expect(tmux.hasSession('hangar-wrap-bad')).toBe(true);
    tmux.sendKeys('hangar-wrap-bad', 'Enter');
    await waitFor(() => !tmux.hasSession('hangar-wrap-bad'));
  });

  it('標準エラーをログに複写する', async () => {
    const wrapper = ensureWrapperScript(home);
    const log = runLogPath(home, 'err');
    tmux.newSession({
      name: 'hangar-wrap-err',
      cwd: home,
      command: ['bash', wrapper, log, 'sh', '-c', 'echo oops >&2; exit 0'],
    });
    await waitFor(() => !tmux.hasSession('hangar-wrap-err'));
    await waitFor(() => /oops/.test(fs.readFileSync(log, 'utf8')));
  });
});
