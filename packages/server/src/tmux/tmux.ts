import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export type TmuxResult = { code: number; stdout: string; stderr: string; failed: boolean };

/** tmux サーバがまだ起きていないときの list-sessions の言い分。これは「動いていない」であって失敗ではない。 */
const NO_SERVER = /no server running/i;

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** tmux を絶対パスで呼ぶ薄い層。socketName か socketPath を付けるとテスト専用のサーバで動く。 */
export class Tmux {
  readonly tmuxPath: string;
  private readonly socketName: string | undefined;
  private readonly socketPath: string | undefined;

  constructor(opts: { tmuxPath: string; socketName?: string; socketPath?: string }) {
    this.tmuxPath = opts.tmuxPath;
    this.socketName = opts.socketName;
    this.socketPath = opts.socketPath;
  }

  args(...a: string[]): string[] {
    if (this.socketPath) return ['-S', this.socketPath, ...a];
    return this.socketName ? ['-L', this.socketName, ...a] : a;
  }

  /**
   * 同期で tmux を呼ぶ。終了コードが 0 でなくても投げず、呼び手が判断する。
   * tmux を起こせなかったとき（パスが消えた、実行できない）は failed が真になる。
   * spawnSync はこの場合も status を null にするだけなので、終了コードでは区別できない。
   */
  run(...a: string[]): TmuxResult {
    const r = spawnSync(this.tmuxPath, this.args(...a), { encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', failed: r.error != null };
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

  /**
   * セッション名の一覧。観測できなかったときは null を返す。
   * tmux のバイナリが一瞬でも消えれば呼び出しは失敗するので、これを空の一覧と同じに扱うと、
   * 動いている run を全部「終了した」と見なして閉じてしまう。
   * サーバがまだ起きていないだけのときは、本当に 1 つも無いので空配列を返す。
   */
  listSessions(): string[] | null {
    const r = this.run('list-sessions', '-F', '#{session_name}');
    if (r.failed) return null;
    if (r.code !== 0) return NO_SERVER.test(r.stderr) ? [] : null;
    return r.stdout.split('\n').filter(Boolean);
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

  /**
   * node-pty に渡す引数。target は他のメソッドと同じく完全一致にする。
   * 素の名前だと tmux が前方一致に落ちるので、終了した run の `hangar-abc12` が
   * そのシェルタブ `hangar-abc12-t1` に当たり、利用者が Claude のつもりで自分のシェルに打鍵してしまう。
   */
  attachArgs(name: string): string[] {
    return this.args('attach', '-t', `=${name}`);
  }

  killServer(): void {
    this.run('kill-server');
  }
}
