import { createDesktopBridge } from './desktop.ts';

/**
 * リカバリーキーを画面の外へ出す 2 つの口（設定のクラウド同期の節、試作 D2）。
 * ファイルに保存は、殻の中なら殻の保存のダイアログ（save_recovery_key）に頼み、ブラウザならダウンロードにする。
 * 殻の UI は 127.0.0.1:4177 の頁を WKWebView で開いているので、Blob のダウンロードでは保存されないことがある。
 * コピーの後にクリップボードを読み直して空にすることはしない。WKWebView では操作の外の読み取りが「ペースト」の吹き出しを出すため。
 */

/** ブラウザのダウンロードの名前。殻の保存のダイアログの既定の名前（src-tauri/src/recoveryfile.rs）とそろえる。 */
export const RECOVERY_FILE_NAME = 'hangar-recovery-key.txt';

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
