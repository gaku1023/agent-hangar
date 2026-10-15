/**
 * Windows で hangar が求める psmux の下限（issue #245）。
 * psmux 3.3.5〜3.3.8 は、前面がシェル以外のペインでホイール 1 回を ↑ 3 回に変えてアプリへ送る（psmux#548）。
 * Claude Code はこれをプロンプトの履歴の呼び出しとして受け取り、端末を上へスクロールできない。3.4.0 で直った（実機で確かめた）。
 * 古くてもセッションは動くので、始めるのは止めず、注意として知らせる。
 */
export const PSMUX_MIN_VERSION = '3.4.0';

/**
 * psmux を上げる 1 行（外の PowerShell で打つ）。
 * psmux が 1 つでも動いていると winget は psmux.exe を置き換えられずに失敗し（0x8a150003）、別名の pmux.exe だけが消えて止まる。
 * そのため先に psmux を全部止め、続けて上げ、最後に版を見せる。止めると、その中で動いている Claude のセッションも止まる。
 */
export const PSMUX_UPGRADE_COMMAND = 'Get-Process psmux -ErrorAction SilentlyContinue | Stop-Process -Force; winget upgrade marlocarlo.psmux; tmux -V';

/** `3.4`、`3.4.0`、`v3.3.8` だけを読む。それ以外の形（`next-3.5a`、`3.3.8a` など）は読めないとして null を返す。 */
function parse(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/**
 * psmux の版（`tmux -V` から読んだもの。psmux は 1 行目を `tmux 3.3.8` の形に保つ）が下限より古いか。
 * 誤って知らせないよう、版が無いときと読めない形のときは古いとしない。
 */
export function psmuxTooOld(version: string | null): boolean {
  if (!version) return false;
  const v = parse(version);
  const min = parse(PSMUX_MIN_VERSION)!;
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i]! < min[i]!;
  return false;
}
