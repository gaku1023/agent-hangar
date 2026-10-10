/**
 * pty の閉じ方。
 *
 * node-pty は Windows で pty を閉じるとき（kill）、子のコンソールの一覧を取る補助のプロセス（conpty_console_list_agent）を起こし、
 * その直後に pseudoconsole を閉じる。補助が子のコンソールにつなぐ（AttachConsole）より先にコンソールが無くなると、
 * 補助は "Error: AttachConsole failed" のスタックトレースを標準エラーへ出す。
 * 補助の標準エラーは親から引き継がれるので、サーバのログにそのまま残る。画面には何も出ない。
 * すでに終わった子を閉じ直したときも、同じ失敗になる。
 *
 * そこで Windows では、先に子のプロセスだけを終わらせる。
 * 子（tmux attach）は孫を持たないので、一覧を取る必要はない。
 * 子が終われば node-pty が終了を見て自分で後始末をする（通常の終わり方と同じ経路）。
 * 待っても終わらないときだけ、元の kill に落とす。
 */
export type PtyCloser = {
  /** 閉じる。何度呼んでも 1 回だけ働き、投げない。 */
  close(): void;
  /** 子が終わったことを知らせる。以後の close は何もしない。 */
  markExited(): void;
};

export function createPtyCloser(o: {
  pid: number;
  /** node-pty の kill。 */
  hardKill: () => void;
  /** 子のプロセスだけを終わらせる。 */
  killPid: (pid: number) => void;
  platform?: NodeJS.Platform;
  /** Windows で、子の終わりを待つ上限。 */
  graceMs?: number;
}): PtyCloser {
  const platform = o.platform ?? process.platform;
  const graceMs = o.graceMs ?? 5000;
  let exited = false;
  let closing = false;
  let timer: NodeJS.Timeout | null = null;
  const hard = (): void => {
    timer = null;
    if (exited) return;
    try { o.hardKill(); } catch { /* 既に終わっている */ }
  };
  return {
    close() {
      if (exited || closing) return;
      closing = true;
      if (platform !== 'win32') { hard(); return; }
      // 終わらせるのは子だけ。既に無くて投げたときは、終了の通知がもうすぐ届くので、待ちの後に確かめる。
      try { o.killPid(o.pid); } catch { /* 既に終わっている */ }
      timer = setTimeout(hard, graceMs);
      timer.unref();
    },
    markExited() {
      exited = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
