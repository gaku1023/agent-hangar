// 作者への問い合わせの本文から、私的な情報を伏せる。公開リポジトリの issue になるためである。

export type RedactContext = {
  home: string;
  user: string;
  host: string;
  /** 登録済みのプロジェクト。並びで番号を振る。 */
  projects: { name: string; path: string }[];
};

export type Redacted = { text: string; count: number };

/** 名前とユーザー名の下限。これより短いものは、ふつうの語を壊すので伏せない。 */
const MIN_NAME = 3;

/**
 * 名前としては伏せない語。報告の題材そのものなので、伏せると読めなくなる。
 * hangar の作者や貢献者は agent-hangar 自身をプロジェクトに登録している。パスは伏せる。
 */
const PUBLIC_NAMES = new Set(['agent-hangar', 'hangar', 'claude', 'claude-code']);

type Rule = { re: RegExp; to: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** パスを、区切り（/ と \）の違いと大文字小文字の違いを越えて当てる式にする。末尾の区切りは外す。 */
function pathPattern(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]+/).map(escape).join('[\\\\/]');
}

/** 語の境目でだけ当てる。英数と _ と - の並びの途中では当てない（日本語の文の中では当てる）。 */
const word = (s: string) => `(?<![\\w-])${escape(s)}(?![\\w-])`;

/** 決まった形の秘密。順に当てる。 */
const FIXED: Rule[] = [
  { re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, to: '<email>' },
  { re: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, to: '<token>' },
  { re: /\bsk-ant-[A-Za-z0-9_-]+/g, to: '<token>' },
  { re: /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]+/g, to: '<token>' },
  { re: /\b[0-9a-fA-F]{32,}\b/g, to: '<token>' },
];

/**
 * 伏せ手を作る。番号はプロジェクトの並びで決まるので、同じ伏せ手で題名と本文を伏せれば同じものに同じ番号が付く。
 * 長いものから順に置き換える。プロジェクトのパスはホームより長いので先に当たり、ホームを先に ~ にして一致しなくなることを防ぐ。
 */
export function makeRedactor(ctx: RedactContext): (text: string) => Redacted {
  const named: { pattern: string; to: string; len: number }[] = [];
  ctx.projects.forEach((p, i) => {
    const to = `<project-${i + 1}>`;
    if (p.path.trim()) named.push({ pattern: pathPattern(p.path), to, len: p.path.length });
    const base = p.path.split(/[\\/]+/).filter(Boolean).pop() ?? '';
    for (const n of new Set([p.name, base])) {
      if ([...n].length >= MIN_NAME && !PUBLIC_NAMES.has(n.toLowerCase())) named.push({ pattern: word(n), to, len: n.length });
    }
  });
  if (ctx.home.trim()) named.push({ pattern: pathPattern(ctx.home), to: '~', len: ctx.home.length });
  if ([...ctx.host].length >= MIN_NAME) named.push({ pattern: word(ctx.host), to: '<host>', len: ctx.host.length });
  if ([...ctx.user].length >= MIN_NAME) named.push({ pattern: word(ctx.user), to: '<user>', len: ctx.user.length });
  named.sort((a, b) => b.len - a.len);
  const rules: Rule[] = [...FIXED, ...named.map((n) => ({ re: new RegExp(n.pattern, 'gi'), to: n.to }))];
  return (text) => {
    let count = 0;
    let out = text;
    for (const r of rules) out = out.replace(r.re, () => { count++; return r.to; });
    return { text: out, count };
  };
}
