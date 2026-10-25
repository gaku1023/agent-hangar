/**
 * pty の閉じ方。
 *
 * Windows では、node-pty の kill を直には呼ばない。理由は 2 つある。
 * 1 つ目に、kill は子のコンソールの一覧を取る補助のプロセス（conpty_console_list_agent）を起こし、その直後に pseudoconsole を閉じる。
 * 補助が子のコンソールにつなぐ（AttachConsole）より先にコンソールが無くなると、補助は "Error: AttachConsole failed" のスタックトレースを標準エラーへ出す。
 * 補助の標準エラーは親から引き継がれるので、サーバのログにそのまま残る。すでに終わった子を閉じ直したときも、同じ失敗になる。
 * 2 つ目に、子が先に終わって pid が使い回されると、補助は呼んだ側のコンソールの一覧を取り、kill はこのプロセス自身を止めうる。
 *
 * かといって子のプロセスだけを終わらせると、node-pty は「子が自分で終わった」経路に入る。
 * node-pty 1.2.0-beta.15（上流の beta.18 も同じ作り）のこの経路は、出力の socket を閉じるだけで、pseudoconsole（conhost）も conout の Worker も放さない。
 * native の側は子が終わると pty の表から baton を消すので、その後に native の kill を呼んでも何もしない。
 * このため閉じるたびに、スレッドが 1 本、私用メモリが約 16MB、ハンドルが約 14 残り、開け閉めを繰り返すとサーバが heap out of memory で落ちた。
 *
 * そこで Windows では、子の pid が決まっていれば、まず解放（release）を呼ぶ。
 * 解放は node-pty の内側から、native の kill（ClosePseudoConsole と pipe の後始末）と conout の Worker の dispose だけを呼ぶ（nodePty.ts の releaseConpty）。
 * pseudoconsole が閉じると conhost が終わり、つながっている子（tmux attach、孫を持たない）も終わる。補助のプロセスは起こさない。
 * 子が終われば node-pty が終了を見て、出力の socket を閉じ、終了を知らせる。
 * 待っても終わらないときは子の pid を止め、さらに待っても終わらないときだけ、元の kill に落とす。
 * 解放できない（node-pty の内側の形が違う）ときは、今までどおり子の pid を止めて待ち、元の kill に落とす。
 *
 * 子の pid は閉じる時に読む。node-pty 1.2 の Windows は、子を pseudoconsole につないだ後（ready）で pid を決め、それまでは 0 を返す。
 * Windows の process.kill(0) は呼んだプロセス自身を終わらせるので、0 のうちは解放も子の pid も呼ばず、元の kill に任せる。
 * node-pty の kill は、つなぐ前なら後回しにし、つなぐ途中の後始末もする。
 */
export type PtyCloser = {
  /** 閉じる。何度呼んでも 1 回だけ働き、投げない。 */
  close(): void;
  /** 子が終わったことを知らせる。以後の close は何もしない。 */
  markExited(): void;
};

export function createPtyCloser(o: {
  /** 子の pid。関数なら閉じる時に呼ぶ。0 以下はまだ決まっていない。 */
  pid: number | (() => number);
  /** node-pty の kill。 */
  hardKill: () => void;
  /** 子のプロセスだけを終わらせる。 */
  killPid: (pid: number) => void;
  /** Windows で、pseudoconsole と conout の Worker を放す。放せなかった（内側の形が違う）ときは false を返す。 */
  release?: () => boolean;
  platform?: NodeJS.Platform;
  /** Windows で、子の終わりを待つ上限。解放の後と、子の pid を止めた後に、それぞれこれだけ待つ。 */
  graceMs?: number;
}): PtyCloser {
  const platform = o.platform ?? process.platform;
  const graceMs = o.graceMs ?? 5000;
  let exited = false;
  let closing = false;
  let timer: NodeJS.Timeout | null = null;
  const later = (f: () => void): void => {
    timer = setTimeout(() => { timer = null; if (!exited) f(); }, graceMs);
    timer.unref();
  };
  const hard = (): void => {
    try { o.hardKill(); } catch { /* 既に終わっている */ }
  };
  // 終わらせるのは子だけ。既に無くて投げたときは、終了の通知がもうすぐ届くので、待ちの後に確かめる。
  const stopChild = (pid: number): void => {
    try { o.killPid(pid); } catch { /* 既に終わっている */ }
    later(hard);
  };
  return {
    close() {
      if (exited || closing) return;
      closing = true;
      if (platform !== 'win32') { hard(); return; }
      const pid = typeof o.pid === 'function' ? o.pid() : o.pid;
      if (!(pid > 0)) { hard(); return; }
      let released = false;
      try { released = o.release?.() ?? false; } catch { released = false; }
      if (released) later(() => stopChild(pid));
      else stopChild(pid);
    },
    markExited() {
      exited = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
