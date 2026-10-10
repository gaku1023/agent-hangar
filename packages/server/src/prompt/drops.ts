import fs from 'node:fs';
import path from 'node:path';
import type { DropDto } from '@agent-hangar/shared';

/** 添付 1 件の上限。 */
export const MAX_DROP_BYTES = 20 * 1024 * 1024;
/** 置いたファイルを残す期間。殻（filedrop.rs の KEEP_FOR）と同じ 7 日。 */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const UNSAFE = new Set([...'\'"\\`$!*?;&|<>(){}[]#~/']);

/**
 * 置く先の名前に使えない文字を _ にする。殻の filedrop.rs の sanitize と同じ規則である。
 * 空白や引用符を落としておくと、起動の文にパスをそのまま書ける。日本語は残す。
 */
export function sanitizeDropName(name: string): string {
  // U+FEFF は文字そのものではなく escape で書く。見えない文字なので、整形ツールが黙って落とすと規則が変わってしまうからである。
  // Rust の is_control は C0・DEL・C1（U+0080 から U+009F）。is_whitespace は Unicode の White_Space で、JS の \s と違い U+FEFF を含まない。
  // eslint-disable-next-line no-control-regex
  const s = [...name].map((c) => ((/\s/.test(c) && c !== '\uFEFF') || /[\u0000-\u001f\u007f-\u009f]/.test(c) || UNSAFE.has(c) ? '_' : c)).join('');
  return s === '' || [...s].every((c) => c === '.') ? 'file' : s;
}

/** 置き場に 1 件置く。同じ名前があれば連番を進め、上書きしない。 */
export function saveDrop(dir: string, name: string, bytes: Uint8Array, now = Date.now()): DropDto {
  fs.mkdirSync(dir, { recursive: true });
  const safe = sanitizeDropName(name);
  for (let i = 0; ; i++) {
    const dest = path.join(dir, `${now}-${i}-${safe}`);
    try {
      // wx：すでにあれば失敗させる。別の添付を上書きしないためである。
      fs.writeFileSync(dest, bytes, { flag: 'wx' });
      return { path: dest, name: name || 'file', size: bytes.byteLength };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 999) throw e;
    }
  }
}

/** 置き場の中のファイルの名前を絶対パスにする。区切りを含む名前、外へ抜ける名前、無いもの、フォルダは null。 */
export function resolveDrop(dir: string, name: string): string | null {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const file = path.join(dir, name);
  if (path.dirname(file) !== path.resolve(dir)) return null;
  // lstat：リンクは辿らない。置き場の中から外のファイルを指すリンクは、通常のファイルではないので null になる。
  try { return fs.lstatSync(file).isFile() ? file : null; } catch { return null; }
}

/**
 * 初期プロンプトが、置き場の直下のファイルを添付として挙げているか。
 * 画面は添付のパスを 1 件 1 行で末尾に足す（空白などを含むものは単一引用符で包む）。
 * その形の行だけを数え、文の途中に書かれたパスや、置き場そのもの・サブフォルダ・接頭辞だけ同じ別のフォルダは数えない。
 * 置き場は呼び手が使っている文字列そのもので比べる。パスを整える工夫はしない。
 */
export function promptMentionsDrops(prompt: string | undefined, dropsDir: string): boolean {
  if (!prompt) return false;
  // Windows の置き場（\ を含む）では、\ と / のどちらも区切りである。
  // macOS と Linux では \ は名前に使える字なので区切りにしない。
  const seps = dropsDir.includes('\\') ? ['\\', '/'] : ['/'];
  for (const raw of prompt.split(/\r?\n/)) {
    let line = raw.trim();
    // 引用符で包んだ行は、空白を含んでよい。包んでいない行は、空白が出たらそこから先は文なので数えない。
    // 画面は macOS と Linux のパスを単引用符で、Windows のパスを二重引用符で包む（ui の quotePath）。
    const quoted = line.length >= 2 && ((line.startsWith("'") && line.endsWith("'")) || (line.startsWith('"') && line.endsWith('"')));
    if (quoted) line = line.slice(1, -1);
    if (!line.startsWith(dropsDir) || !seps.includes(line[dropsDir.length] ?? '')) continue;
    const name = line.slice(dropsDir.length + 1);
    if (name !== '' && !seps.some((s) => name.includes(s)) && (quoted || !/\s/.test(name))) return true;
  }
  return false;
}

/** 残す期間を過ぎたファイルを消す。 */
export function pruneDrops(dir: string, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    try { const st = fs.statSync(p); if (st.isFile() && now - st.mtimeMs > KEEP_MS) fs.unlinkSync(p); } catch { /* 消せなかったものは次の回に任せる */ }
  }
}
