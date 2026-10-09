import type { Tmux } from './tmux.ts';

/** 名前で送るキー。文字として送れないものだけを挙げる。 */
export type PaneKey = 'ctrl+o';

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
  /** 画面にいま見えている文字。色や属性は落とす。 */
  capture(name: string): string;
  /** 文字をそのまま打ち込む。キーの名前としては読ませない。 */
  sendText(name: string, text: string): void;
  /** 名前の付いたキーを 1 つ送る。 */
  sendKey(name: string, key: PaneKey): void;
  /**
   * 外の端末（利用者のターミナル）からこの画面につなぐ人のための設定を確かめる。
   * 裏の道具の全体に効く設定なので、利用者の値は覆さない。要らない裏では何もしない。
   */
  prepareForOutsideTerminals(): void;
}

/** tmux のキーの名前。 */
const TMUX_KEYS: Record<PaneKey, string> = { 'ctrl+o': 'C-o' };

/** tmux を裏にした PaneOps。画面 1 つを、切り離した tmux のセッション 1 つにする。 */
export function tmuxPaneOps(tmux: Tmux): PaneOps {
  return {
    open(opts) {
      tmux.newSession(opts);
      // hangar の画面は UI の端末に埋めるので、tmux の状態の行は出さない。
      tmux.setOption(opts.name, 'status', 'off');
    },
    close: (name) => tmux.killSession(name),
    list: () => tmux.listSessions(),
    capture: (name) => tmux.capturePane(name),
    // -l を付けて 1 文字として送る。{ や q を tmux のキー名として読ませない。
    sendText: (name, text) => tmux.sendKeys(name, '-l', text),
    sendKey: (name, key) => tmux.sendKeys(name, TMUX_KEYS[key]),
    prepareForOutsideTerminals: () => tmux.ensureTerminalOptions(),
  };
}
