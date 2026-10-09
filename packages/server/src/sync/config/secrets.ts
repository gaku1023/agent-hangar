/**
 * 秘密らしい文字列の検出（設定の同期の設計書の 5 章）。
 * 送る前に項目の本文を走査し、トークンの形があればその項目を送らない。
 *
 * 見つけた文字列そのものは返さない。返すのは種類の名前（`sk-ant-` など）だけである。
 * 呼び手はそれを「送らなかった項目」の理由に書く。本文の断片が一覧やログに出ないようにするためである。
 *
 * 形だけを説明した文章（「API キーは sk-ant- で始まる」）は通す。
 * 接頭辞に続く本物らしい長さの文字が無いと見つけない。誤検出で項目が送られなくなるのを避けるためである。
 */
const PATTERNS: readonly { label: string; re: RegExp }[] = [
  { label: 'sk-ant-', re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: 'ghp_', re: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{30,}/ },
  { label: 'github_pat_', re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{30,}/ },
  { label: 'AKIA', re: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/ },
  { label: '-----BEGIN', re: /-----BEGIN [A-Z0-9 ]{3,40}-----/ },
  { label: 'xox', re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/ },
];

/** 秘密らしい文字列があれば、その種類の名前を返す。無ければ null。 */
export function findSecret(text: string): string | null {
  for (const p of PATTERNS) if (p.re.test(text)) return p.label;
  return null;
}
