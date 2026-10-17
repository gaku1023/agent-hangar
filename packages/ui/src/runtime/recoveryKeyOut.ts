import { createDesktopBridge } from './desktop.ts';

/**
 * リカバリーキーを画面の外へ出す 2 つの口（設定のクラウド同期の節、試作 D2）。
 * ファイルに保存は、殻の中なら殻の保存のダイアログ（save_recovery_key）に頼み、ブラウザならダウンロードにする。
 * 殻の UI は 127.0.0.1:4177 の頁を WKWebView で開いているので、Blob のダウンロードでは保存されないことがある。
 * コピーは、60 秒たってクリップボードが写した値のままなら空にする。
 */

/** ブラウザのダウンロードの名前。殻の保存のダイアログの既定の名前（src-tauri/src/recoveryfile.rs）とそろえる。 */
export const RECOVERY_FILE_NAME = 'hangar-recovery-key.txt';

/** コピーからクリップボードを空にするまでの間（ms）。 */
export const CLIPBOARD_CLEAR_MS = 60_000;

/** 4 行の文字列をファイルとして保存させる（ブラウザのダウンロード）。 */
function download(text: string, doc: Document): void {
  const url = URL.createObjectURL(new Blob([text.endsWith('\n') ? text : `${text}\n`], { type: 'text/plain;charset=utf-8' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = RECOVERY_FILE_NAME;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // ダウンロードが URL を読み終える間を置いてから捨てる。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * リカバリーキーをファイルに保存する。殻の中なら保存のダイアログ、ブラウザならダウンロード。
 * 殻で取り消したら cancelled を返し、書けなければ投げる。ブラウザのダウンロードは結果が分からないので saved とみなす。
 */
export async function saveRecoveryKeyFile(text: string, win: Window = window): Promise<'saved' | 'cancelled'> {
  const bridge = createDesktopBridge(win);
  if (bridge?.saveRecoveryKey) return bridge.saveRecoveryKey(text);
  download(text, win.document);
  return 'saved';
}

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 写した値を、60 秒たってクリップボードがそのままなら空にする。
 * 欄を閉じても消えないよう、画面の部品ではなくここで時を数える。押し直したら数え直す。
 * 読めない（権限が無い、クリップボードの API が無い）ときは何もしない。利用者が別のものを写していたら触らない。
 */
export function clearClipboardLater(text: string): void {
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (!clip || typeof clip.readText !== 'function') return;
    clip.readText().then((now) => (now === text ? clip.writeText('') : undefined)).catch(() => {});
  }, CLIPBOARD_CLEAR_MS);
}
