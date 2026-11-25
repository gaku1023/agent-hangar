// 「このフォルダを信頼するか」の確認の画面を読む。
// hangar が起こした claude が、新しいフォルダで会話の前に出す。登録も本文も無いので、画面だけが手がかりである。
// 番号の無い形（カーソルの初期位置は No, exit）と、番号付きの形（2.1.295 ごろ）の両方を受ける。

/** 信頼する側の選択肢の key。画面に番号があってもなくても、Yes を 1、No を 2 とする。 */
export const TRUST_YES = '1';
export const TRUST_NO = '2';
export type TrustKey = typeof TRUST_YES | typeof TRUST_NO;

export type TrustOption = { key: TrustKey; /** 画面の行のラベルそのまま（カーソルと番号は除く）。 */ label: string };
export type TrustDialog = {
  /** 画面に出ているフォルダのパス。読めなければ空。 */
  path: string;
  /** 画面に出ている順の選択肢。 */
  options: TrustOption[];
  /** カーソルのある行（options の添字）。読めなければ null。 */
  cursor: number | null;
};

const ROW = /^\s*(?:([❯›>])\s*)?(?:\d+[.)]\s*)?(Yes\b.*|No\b.*?)\s*$/;
const YES_TRUST = /^Yes\b.*\btrust/i;
const NEAR = 2;
const HEAD = /Accessing workspace/i;
const BODY_START = /Quick safety check|Is this a project you created|Do you trust/i;

/** 画面から信頼の確認を読む。確認でなければ null。Yes（trust を含む行）と、その近くの No の行がそろったときだけ確認とみなす。 */
export function parseTrustDialog(screen: string): TrustDialog | null {
  const lines = screen.replace(/\r/g, '').split('\n');
  const rows = lines.map((l) => ROW.exec(l));
  let iy = -1;
  for (let i = rows.length - 1; i >= 0 && iy === -1; i--) if (rows[i] && YES_TRUST.test(rows[i]![2]!)) iy = i;
  if (iy === -1) return null;
  let ino = -1;
  for (let d = 1; d <= NEAR + 1 && ino === -1; d++) {
    for (const i of [iy + d, iy - d]) {
      const m = rows[i];
      if (m && /^No\b/i.test(m[2]!)) { ino = i; break; }
    }
  }
  if (ino === -1) return null;
  const found = [iy, ino].sort((a, b) => a - b);
  const options = found.map((i): TrustOption => ({ key: i === iy ? TRUST_YES : TRUST_NO, label: rows[i]![2]!.trim() }));
  const marked = found.findIndex((i) => rows[i]![1] !== undefined);
  return { path: pathOf(lines, found[0]!), options, cursor: marked === -1 ? null : marked };
}

/** 見出し（Accessing workspace:）から本文の頭までの間の行をつなぐ。画面の幅で折り返されたパスも 1 つになる。見出しが無ければ空。 */
function pathOf(lines: string[], before: number): string {
  let head = -1;
  for (let i = before - 1; i >= 0 && head === -1; i--) if (HEAD.test(lines[i]!)) head = i;
  if (head === -1) return '';
  const out: string[] = [];
  for (let i = head + 1; i < before; i++) {
    const t = lines[i]!.trim();
    if (t === '') { if (out.length > 0) break; continue; }
    if (BODY_START.test(t)) break;
    out.push(t);
  }
  return out.join('');
}

/** key の行へ、カーソルをどちらへ何回動かすか。カーソルが読めないか、行が無ければ null。 */
export function trustMoves(d: TrustDialog, key: string): { key: 'up' | 'down'; count: number } | null {
  const to = d.options.findIndex((o) => o.key === key);
  if (to === -1 || d.cursor === null) return null;
  return { key: to >= d.cursor ? 'down' : 'up', count: Math.abs(to - d.cursor) };
}
