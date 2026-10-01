/**
 * Hangar.app の殻から届く、ファイルを落とした知らせ（`hangar:drop`）。
 * 殻は落とされたファイルを `~/.agent-hangar/drops/` に写し、写した先のパスと落とした位置（CSS の px）を送ってくる。
 * 撮影直後のスクリーンショットは保護された一時フォルダにあり、落とした先のアプリにしか読めないので、写した先を渡す。
 */
export const FILE_DROP_EVENT = 'hangar:drop';

type Drop = { paths: string[]; x: number; y: number };

function parse(detail: unknown): Drop | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as { paths?: unknown; x?: unknown; y?: unknown };
  if (!Array.isArray(d.paths) || d.paths.length === 0 || !d.paths.every((p) => typeof p === 'string' && p !== '')) return null;
  if (typeof d.x !== 'number' || typeof d.y !== 'number' || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return null;
  return { paths: d.paths as string[], x: d.x, y: d.y };
}

/** 空白や引用符を含むパスは単引用符で囲む。ほかの端末へ落としたときと同じ形なので、Claude Code がパスとして読める。 */
export function quotePath(p: string): string {
  return /^[\p{L}\p{N}/._+\-@:,%=]+$/u.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`;
}

/** 端末にファイルを落としたときと同じく、パスを空白で区切って末尾に空白を 1 つ付ける。 */
export function dropText(paths: string[]): string {
  return `${paths.map(quotePath).join(' ')} `;
}

/** 落とした位置にある端末へパスを貼り付ける。端末の外に落としたときは何もしない。 */
export function handleFileDrop(detail: unknown, deps: { hit: (x: number, y: number) => Element | null; paste: (tabId: string, text: string) => void; focus: (tabId: string) => void }): boolean {
  const d = parse(detail);
  if (!d) return false;
  const tabId = deps.hit(d.x, d.y)?.closest<HTMLElement>('.term-host')?.dataset.tab;
  if (!tabId) return false;
  deps.paste(tabId, dropText(d.paths));
  deps.focus(tabId);
  return true;
}
