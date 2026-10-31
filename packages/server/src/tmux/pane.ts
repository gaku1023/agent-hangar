import { muxServersOf, type MuxServers } from './servers.ts';
import type { Tmux } from './tmux.ts';

/** 名前で送るキー。文字として送れないものだけを挙げる。 */
export type PaneKey = 'ctrl+o' | 'enter';

/**
 * run とシェルタブが動く画面（ペイン）に触る口。
 * RunManager はこの口だけを通して画面を作り、見張り、止める。
 * いまの裏は tmux で、Windows では別の実装に替える。
 * なので、名前と引数に裏の道具の言葉を出さない。
 * name は呼び手が決める画面の名前で、どの操作も完全一致で当てる。
 */
export interface PaneOps {
  /**
   * 画面を作り、その中で command を起こす。作れなかったら投げる。
   * env は、その画面の中のプロセスに足す環境変数である。
   */
  open(opts: { name: string; cwd: string; command: string[]; env?: Record<string, string> }): void;
  /** 画面を閉じ、中のプロセスを止める。無い名前は黙って通す。 */
  close(name: string): void;
  /**
   * いま在る画面の名前の一覧。観測できなかったときは null を返す。
   * 空の一覧（1 つも無い）と null（分からない）は別である。
   */
  list(): string[] | null;
  /** list の、イベントループを止めない版。持たない裏（試験の偽物など）は list で代える。 */
  listAsync?(): Promise<string[] | null>;
  /** 画面にいま見えている文字。色や属性は落とす。 */
  capture(name: string): string;
  /**
   * 端末の幅で折り返した行をつないだ画面。裏がつなげないときは折り返したままの画面と、その幅（width）を返す。つないだときの width は null。
   * Remote Control の URL を拾うのに使う（mobile/remoteUrl.ts）。持たない裏（試験の偽物など）は capture で代える。
   */
  captureUnwrapped?(name: string): { text: string; width: number | null } | Promise<{ text: string; width: number | null }>;
  /** 文字をそのまま打ち込む。キーの名前としては読ませない。 */
  sendText(name: string, text: string): void;
  /**
   * 文字列を 1 回の貼り付けとして届ける。複数行でも 1 つの入力になり、途中の改行で確定されない。
   * 確定はしない（確定は sendKey の enter）。届けられなかったら投げる。
   */
  pasteText?(name: string, text: string): void;
  /** 名前の付いたキーを 1 つ送る。 */
  sendKey(name: string, key: PaneKey): void;
  /**
   * 外の端末（利用者のターミナル）からこの画面につなぐ人のための設定を確かめる。
   * 裏の道具の全体に効く設定なので、利用者の値は覆さない。要らない裏では何もしない。
   */
  prepareForOutsideTerminals(): void;
}

/** tmux と psmux のキーの名前。 */
const MUX_KEYS: Record<PaneKey, string> = { 'ctrl+o': 'C-o', enter: 'Enter' };

/**
 * tmux と psmux に共通の口。画面 1 つを、切り離したセッション 1 つにする。
 * 新しい画面は hangar の専用のサーバに作り、既存の画面にはそれが居るサーバで触る（servers.ts）。
 */
function muxPaneOps(mux: MuxServers): Omit<PaneOps, 'prepareForOutsideTerminals'> {
  const at = (name: string) => mux.serverOf(name);
  return {
    open(opts) {
      mux.own.newSession(opts);
      // hangar の画面は UI の端末に埋めるので、状態の行は出さない。
      mux.own.setOption(opts.name, 'status', 'off');
    },
    // サーバごとは落とさない。名指しの kill-session だけである。
    // psmux の kill-server は別の名前空間のセッションまで落とすので、どちらの裏でもここでは使わない。
    close: (name) => at(name).killSession(name),
    list: () => mux.list(),
    listAsync: () => mux.listAsync(),
    capture: (name) => at(name).capturePane(name),
    captureUnwrapped: (name) => at(name).captureUnwrapped(name),
    // -l を付けて 1 文字として送る。{ や q をキー名として読ませない。
    sendText: (name, text) => at(name).sendKeys(name, '-l', text),
    pasteText: (name, text) => at(name).pasteText(name, text),
    sendKey: (name, key) => at(name).sendKeys(name, MUX_KEYS[key]),
  };
}

/**
 * tmux を裏にした PaneOps。外の端末（iTerm2 など）から attach する人のための設定も確かめる。
 * その設定はサーバ全体に効くので、hangar の専用のサーバにだけ入れる。利用者の既定のサーバには入れない。
 */
export function tmuxPaneOps(tmux: Tmux | MuxServers): PaneOps {
  const mux = muxServersOf(tmux);
  return { ...muxPaneOps(mux), prepareForOutsideTerminals: () => mux.own.ensureTerminalOptions() };
}

/**
 * psmux（Windows）を裏にした PaneOps。
 * 画面の作り方、止め方、文字とキーの送り方は tmux と同じ口で通る（psmux 3.3.8 の実機で確かめた。psmux.win.test.ts が CI で見張る）。
 * 違うのは、外の端末のための設定を何も入れないことである。
 * copy-command の pbcopy は Windows に無く、Shift+Enter は Windows Terminal からそのまま通る。
 */
export function psmuxPaneOps(tmux: Tmux | MuxServers): PaneOps {
  return { ...muxPaneOps(muxServersOf(tmux)), prepareForOutsideTerminals: () => {} };
}

/** 動いている OS に合う PaneOps。Windows は psmux、それ以外は tmux。 */
export function paneOpsFor(tmux: Tmux | MuxServers, platform: NodeJS.Platform = process.platform): PaneOps {
  return platform === 'win32' ? psmuxPaneOps(tmux) : tmuxPaneOps(tmux);
}
