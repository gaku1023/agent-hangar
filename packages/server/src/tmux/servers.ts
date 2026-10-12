import { Tmux, type TmuxExec } from './tmux.ts';

/**
 * hangar の run とシェルタブが動く tmux（Windows は psmux）のサーバの名前。
 * 利用者の既定のサーバと分けるので、`tmux -L hangar ls` で hangar のセッションだけが見える。
 * サーバ全体のオプション（set-clipboard、copy-command、extended-keys、terminal-features）も、このサーバにだけ入れる。
 * 利用者の ~/.tmux.conf は、このサーバが起きるときにも読まれる。
 */
export const HANGAR_SOCKET = 'hangar';

/**
 * hangar の画面の名前。run は hangar-<16 桁の 16 進>、そのシェルタブは末尾に -t<n> が付く。
 * 既定のサーバの中で、前の版の hangar が作ったものを見分けるのに使う。利用者自身のセッションは当たらない。
 */
const HANGAR_PANE = /^hangar-[0-9a-f]+(?:-t\d+)?$/;

/**
 * hangar の画面が居るサーバの組。
 * 新しい画面は専用のサーバ（own、`-L hangar`）に作る。
 * 前の版は利用者の既定のサーバ（legacy）に作っていたので、更新の時点で動いていた run とシェルタブはそこに残る。
 * それらは終わるまで既定のサーバで扱う（閉じる、読む、送る、attach、生きているかの確かめ）。
 * どの画面が既定のサーバに居るかは、既定のサーバの一覧から覚える。DB には書かない（runs は端末をまたいで同期する表なので、端末の中の事情を載せない）。
 * サーバが再起動しても、同じ一覧から同じように覚え直せる。
 * 既定のサーバに hangar の画面が 1 つも無いと分かったら、それからは既定のサーバを読まない。
 * 新しい画面は既定のサーバに作らないので、一度居なくなれば戻らない。
 */
export class MuxServers {
  /** 既定のサーバに居ると分かっている hangar の画面。 */
  private legacyNames = new Set<string>();
  /** 既定のサーバを一度でも読んだか。 */
  private observed = false;
  /** 既定のサーバをまだ見張るか。 */
  private watching: boolean;

  /** legacy が null なら移行の相手を持たない（試験と、Tmux 1 つから作った口）。 */
  constructor(
    readonly own: Tmux,
    readonly legacy: Tmux | null,
  ) {
    this.watching = legacy !== null;
  }

  /**
   * hangar の画面の名前の一覧。観測できなかったときは null を返す。
   * 専用のサーバのセッションは全部入れる（そこには hangar のものしか無い）。
   * 既定のサーバからは hangar の画面の名前だけを入れる。利用者自身のセッションは入れない。
   * 既定のサーバを読めなければ、古い run の生死が分からないので、全体を null にする。
   */
  list(): string[] | null {
    const mine = this.own.listSessions();
    if (mine === null) return null;
    if (!this.legacy || !this.watching) return mine;
    const theirs = this.legacy.listSessions();
    if (theirs === null) return null;
    const ownSet = new Set(mine);
    const left = theirs.filter((n) => HANGAR_PANE.test(n) && !ownSet.has(n));
    this.legacyNames = new Set(left);
    this.observed = true;
    if (left.length === 0) this.watching = false;
    return [...mine, ...left];
  }

  /** その画面が居るサーバ。既定のサーバに居ると分かっているものだけが legacy で、ほかは own。 */
  serverOf(name: string): Tmux {
    if (this.legacy && this.watching && !this.observed) this.list();
    return this.legacy && this.legacyNames.has(name) ? this.legacy : this.own;
  }
}

/** Tmux 1 つか、サーバの組か。どちらを受けても組にそろえる。 */
export function muxServersOf(t: Tmux | MuxServers): MuxServers {
  return t instanceof MuxServers ? t : new MuxServers(t, null);
}

/**
 * hangar が使う tmux（psmux）の口。新しい画面は `-L hangar` のサーバに作り、前の版の画面は既定のサーバで扱い続ける。
 * exec と platform と env は試験が差し替える。
 */
export function hangarMux(tmuxPath: string, o: { exec?: TmuxExec; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): MuxServers {
  return new MuxServers(new Tmux({ tmuxPath, socketName: HANGAR_SOCKET, ...o }), new Tmux({ tmuxPath, ...o }));
}
