/**
 * 設定の書き戻しの失敗。
 * 失敗したら何も書かない（関数は文字列を返すだけで、ファイルには触れない）。
 * 呼ぶ側はこの例外を捕まえて、その項目を「書けなかった」として扱う。
 */
export type ConfigEditErrorCode =
  /** 入力が TOML・JSON として読めない。line は 1 から数えた行（分かるとき）。 */
  | 'parse'
  /** この道具が扱わない形（表の配列をまたぐ道、根が入れ物でない文書など）。 */
  | 'unsupported'
  /** 道の途中が値で、その下に足せない。 */
  | 'conflict'
  /** TOML・JSON にできない値（undefined、null、関数、NaN など）。 */
  | 'invalid-value'
  /** 書いた結果を読み直すと、狙った中身にならなかった（道具の不具合）。 */
  | 'verify';

export class ConfigEditError extends Error {
  readonly code: ConfigEditErrorCode;
  readonly line?: number;
  constructor(code: ConfigEditErrorCode, message: string, line?: number) {
    super(line === undefined ? message : `${message}（${line} 行目）`);
    this.name = 'ConfigEditError';
    this.code = code;
    if (line !== undefined) this.line = line;
  }
}

export function lineOf(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

export function detectEol(src: string): string {
  return src.includes('\r\n') ? '\r\n' : '\n';
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}
