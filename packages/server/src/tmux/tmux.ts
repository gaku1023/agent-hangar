import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export type TmuxResult = { code: number; stdout: string; stderr: string; failed: boolean };

/** tmux を起こす口。試験では差し替える。 */
export type TmuxExec = (file: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };

const realExec: TmuxExec = (file, args) => {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

/** 外の端末が拡張キーを送れることを tmux に知らせる terminal-features の項目。 */
const EXTKEYS_FEATURE = 'xterm*:extkeys';

/** マウスで選んだ範囲を渡すコマンド。tmux は copy-command をシェルで走らせるので、ロケールを前に置ける。 */
const COPY_COMMAND = 'LC_CTYPE=UTF-8 pbcopy';

/** hangar の run のセッション名（hangar-<id>）に当たる書式。シェルタブ（hangar-<id>-t<n>）は外れる。 */
const RUN_SESSION_FORMAT = '#{m/r:^hangar-[0-9a-f]+$,#{session_name}}';

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
  private readonly platform: NodeJS.Platform;
  private readonly exec: TmuxExec;

  constructor(opts: { tmuxPath: string; socketName?: string; socketPath?: string; platform?: NodeJS.Platform; exec?: TmuxExec }) {
    this.tmuxPath = opts.tmuxPath;
    this.socketName = opts.socketName;
    this.socketPath = opts.socketPath;
    this.platform = opts.platform ?? process.platform;
    this.exec = opts.exec ?? realExec;
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
    const r = this.exec(this.tmuxPath, this.args(...a));
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, failed: r.error != null };
  }

  /**
   * 切り離した状態でセッションを作る。command は `--` の後ろにそのまま並べる。
   * tmux は `-c` のディレクトリが無くても黙ってホームに落ちて成功するため、先に自分で確かめて投げる。
   */
  /**
   * env は新しいセッションの環境に足す変数である。
   * tmux の新しいセッションは、起こしたプロセスではなくサーバの環境を継ぐので、シェルの変数を渡すにはここで -e を付ける。
   */
  newSession(opts: { name: string; cwd: string; command: string[]; width?: number; height?: number; env?: Record<string, string> }): void {
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
      ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
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
    return r.stdout.split(/\r?\n/).filter(Boolean);
  }

  killSession(name: string): void {
    this.run('kill-session', '-t', `=${name}`);
  }

  setOption(name: string, key: string, value: string): void {
    this.run('set-option', '-t', `=${name}:`, key, value);
  }

  /**
   * 中のアプリが OSC 52 で写したものを、attach している端末（UI の xterm）へ通す。
   * 既定の external では tmux のコピーモードの写しだけが外へ出て、アプリの OSC 52 は捨てられる。
   * set-clipboard はサーバ全体の設定なので、同じサーバにある利用者自身のセッションにも効く。
   * 利用者が off にしているときは覆さない。
   * サーバが動いていなければ show-options が失敗するので、何もしない。set-option だけではサーバを起こさない。
   */
  enableClipboard(): void {
    const cur = this.run('show-options', '-s', '-v', 'set-clipboard');
    if (cur.code !== 0) return;
    const v = cur.stdout.trim();
    if (v === 'on' || v === 'off') return;
    this.run('set-option', '-s', 'set-clipboard', 'on');
  }

  /**
   * 外の端末（iTerm2 など）からつなぐための設定を入れる。どれもサーバ全体の設定なので、利用者の値は覆さない。
   * copy-command：iTerm2 は既定で OSC 52 の書き込みを許さないので、マウスで選んだ範囲を pbcopy で直接クリップボードへ渡す。
   * pbcopy はロケールで文字コードを決める。tmux サーバの環境には LANG が無いことが多く、そのままでは日本語を写すとクリップボードが空になる。
   * extended-keys と terminal-features：外の端末から Shift+Enter を区別して受ける。
   * S-Enter：tmux は CSI u の Shift+Enter を素の CR に潰すので、hangar の run でだけ、Claude Code が改行と読む ESC CR に変える。
   * シェルタブ（hangar-<id>-t<n>）と利用者自身のセッションには Shift+Enter のまま送る。
   * サーバが動いていなければ何もしない。set-option だけではサーバを起こさない。
   */
  ensureTerminalOptions(): void {
    // ここから下は、macOS の外の端末（iTerm2 など）から tmux へつなぐための調整である。
    // Windows の psmux には入れない。pbcopy は無く、Shift+Enter は Windows Terminal からそのまま通る。
    if (this.platform === 'win32') return;
    const show = (key: string) => this.run('show-options', '-s', '-v', key);
    const copy = show('copy-command');
    if (copy.code !== 0) return;
    const cur = copy.stdout.trim();
    // 素の pbcopy は前の版が入れた値なので、hangar のものとして置き換える。
    if ((cur === '' || cur === 'pbcopy') && this.platform === 'darwin') this.run('set-option', '-s', 'copy-command', COPY_COMMAND);
    if (show('extended-keys').stdout.trim() === 'off') {
      this.run('set-option', '-s', 'extended-keys', 'on');
      this.run('set-option', '-s', 'extended-keys-format', 'csi-u');
    }
    if (!show('terminal-features').stdout.includes(EXTKEYS_FEATURE)) this.run('set-option', '-as', 'terminal-features', EXTKEYS_FEATURE);
    const bound = this.run('list-keys', '-T', 'root', 'S-Enter');
    if (bound.code === 0 && bound.stdout.trim() !== '' && !bound.stdout.includes(RUN_SESSION_FORMAT)) return;
    this.run('bind-key', '-n', 'S-Enter', 'if-shell', '-F', RUN_SESSION_FORMAT, 'send-keys Escape Enter', 'send-keys S-Enter');
  }

  sendKeys(name: string, ...keys: string[]): void {
    this.run('send-keys', '-t', `=${name}:`, ...keys);
  }

  /** ペインにいま見えている文字だけを返す。色や属性は落とす。 */
  capturePane(name: string): string {
    return this.run('capture-pane', '-p', '-t', `=${name}:`).stdout.replace(/\r\n/g, '\n');
  }

  /**
   * node-pty に渡す引数。target は他のメソッドと同じく完全一致にする。
   * 素の名前だと tmux が前方一致に落ちるので、終了した run の `hangar-abc12` が
   * そのシェルタブ `hangar-abc12-t1` に当たり、利用者が Claude のつもりで自分のシェルに打鍵してしまう。
   */
  attachArgs(name: string): string[] {
    return this.args('attach', '-t', `=${name}`);
  }

  /**
   * サーバごと落とす。試験の後始末にだけ使う。
   * Windows の psmux では呼ばない。psmux の kill-server は名前空間を越えて全部のセッションを落とすからである。
   */
  killServer(): void {
    if (this.platform === 'win32') throw new Error('kill-server は Windows では呼ばない。kill-session で名指しして止める');
    this.run('kill-server');
  }
}
