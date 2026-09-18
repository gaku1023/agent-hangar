import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export type TmuxResult = { code: number; stdout: string; stderr: string };

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** tmux を絶対パスで呼ぶ薄い層。socketName を付けるとテスト専用のサーバで動く。 */
export class Tmux {
  readonly tmuxPath: string;
  private readonly socketName: string | undefined;

  constructor(opts: { tmuxPath: string; socketName?: string }) {
    this.tmuxPath = opts.tmuxPath;
    this.socketName = opts.socketName;
  }

  args(...a: string[]): string[] {
    return this.socketName ? ['-L', this.socketName, ...a] : a;
  }

  /** 同期で tmux を呼ぶ。終了コードが 0 でなくても投げず、呼び手が判断する。 */
  run(...a: string[]): TmuxResult {
    const r = spawnSync(this.tmuxPath, this.args(...a), { encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /**
   * 切り離した状態でセッションを作る。command は `--` の後ろにそのまま並べる。
   * tmux は `-c` のディレクトリが無くても黙ってホームに落ちて成功するため、先に自分で確かめて投げる。
   */
  newSession(opts: { name: string; cwd: string; command: string[]; width?: number; height?: number }): void {
    if (!isDirectory(opts.cwd)) throw new Error(`tmux new-session failed: cwd not found: ${opts.cwd}`);
    const r = this.run(
      'new-session',
      '-d',
      '-s',
      opts.name,
      '-c',
      opts.cwd,
      '-x',
      String(opts.width ?? 120),
      '-y',
      String(opts.height ?? 40),
      '--',
      ...opts.command,
    );
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  }

  hasSession(name: string): boolean {
    return this.run('has-session', '-t', `=${name}`).code === 0;
  }

  listSessions(): string[] {
    const r = this.run('list-sessions', '-F', '#{session_name}');
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  }

  killSession(name: string): void {
    this.run('kill-session', '-t', `=${name}`);
  }

  setOption(name: string, key: string, value: string): void {
    this.run('set-option', '-t', `=${name}:`, key, value);
  }

  sendKeys(name: string, ...keys: string[]): void {
    this.run('send-keys', '-t', `=${name}:`, ...keys);
  }

  /** node-pty に渡す引数。attach のときだけはセッション名をそのまま使う。 */
  attachArgs(name: string): string[] {
    return this.args('attach', '-t', name);
  }

  killServer(): void {
    this.run('kill-server');
  }
}
