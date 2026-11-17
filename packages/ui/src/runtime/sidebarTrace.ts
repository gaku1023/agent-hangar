/**
 * サイドバーの開閉を書いた経路の控え（#616）。
 * Windows で再起動のたびにサイドバーが閉じる原因はまだ分からないので、閉じる状態が保存された瞬間に、
 * 直前の入力（打鍵か押下か、無ければ画面の操作によらない書き込み）を localStorage の `sidebar.trace` に残す。
 * 打鍵の中身は文字を残さず、キーの名前と修飾キーだけにする。
 */
export const SIDEBAR_TRACE_KEY = 'sidebar.trace';

/** 直前の入力とみなす幅（ミリ秒）。 */
export const RECENT_INPUT_MS = 500;

export type LastInput = { kind: 'key' | 'pointer'; at: number; key?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; target?: string };
export type SidebarTrace = { at: number; collapsed: boolean; via: 'key' | 'pointer' | 'none'; key?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; target?: string };

let last: LastInput | null = null;

/** 打鍵と押下を捕まえて覚える。1 度だけ呼ぶ。document が無い環境では何もしない。 */
export function watchInputs(doc: Pick<Document, 'addEventListener'> | undefined, now: () => number): void {
  if (!doc) return;
  doc.addEventListener('keydown', (e) => {
    const k = e as KeyboardEvent;
    last = { kind: 'key', at: now(), key: k.key, ctrl: k.ctrlKey, meta: k.metaKey, shift: k.shiftKey, target: (k.target as Element | null)?.tagName?.toLowerCase() };
  }, true);
  doc.addEventListener('pointerdown', (e) => {
    last = { kind: 'pointer', at: now(), target: (e.target as Element | null)?.tagName?.toLowerCase() };
  }, true);
}

/** 保存の時点の控えを作る。直前の入力が無ければ via は none（画面の操作によらない書き込み）。 */
export function traceOf(collapsed: boolean, at: number, input: LastInput | null = last): SidebarTrace {
  if (!input || at - input.at > RECENT_INPUT_MS) return { at, collapsed, via: 'none' };
  const { kind, at: _a, ...rest } = input;
  return { at, collapsed, via: kind, ...rest };
}

/** テスト用。 */
export function resetSidebarTrace(): void { last = null; }
