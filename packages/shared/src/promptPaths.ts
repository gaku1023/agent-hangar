/**
 * 初期プロンプトにファイルのパスを書くときの規則。
 * PC の画面（指示欄の添付と端末へのドロップ）と、スマホからの起動を受ける PC のサーバが同じ形を使う。
 * 並びが違うと、promptMentionsDrops（置き場の読み許可の判断）が画面の形だけを数えるので、サーバ側でも同じ形にそろえる。
 */

const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/;

/** Windows の形のパスか。ドライブ（`C:`）、UNC（`\\server`）、`~\`、`\` を含む相対パスを Windows の形とみる。 */
export function isWindowsPath(p: string): boolean {
  if (DRIVE.test(p) || p.startsWith('\\\\')) return true;
  if (p.startsWith('/') || p.startsWith('~/')) return false;
  return p.includes('\\');
}

/**
 * 空白や引用符を含むパスは引用符で囲む。ほかの端末へ落としたときと同じ形なので、Claude Code がパスとして読める。
 * macOS と Linux のパスは、POSIX のシェルの単引用符で囲む。
 * Windows のパスは、ペインで動く claude と PowerShell（シェルタブは powershell.exe、psmux の既定のシェルも PowerShell）に向けて囲む。
 * Windows の名前に " は使えないので二重引用符で囲めば足り、Windows Terminal へ落としたときと同じ形になる。cmd でも同じに読める。
 * ただし PowerShell は二重引用符の中の $ と ` を展開するので、それを含むパスは単引用符で囲み、中の単引用符は 2 つにする。
 */
export function quotePath(p: string): string {
  if (isWindowsPath(p)) {
    if (/^[\p{L}\p{N}\\/._+\-:=]+$/u.test(p)) return p;
    return /[$`]/.test(p) ? `'${p.replaceAll("'", "''")}'` : `"${p}"`;
  }
  return /^[\p{L}\p{N}/._+\-@:,%=]+$/u.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`;
}

/** 本文の後に空行を置き、パスを 1 行ずつ足す。パスが無ければ本文を整えて返す。本文が空ならパスだけ。 */
export function appendPaths(body: string, paths: string[]): string {
  const text = body.trim();
  if (!paths.length) return text;
  const lines = paths.map(quotePath).join('\n');
  return text ? `${text}\n\n${lines}` : lines;
}
