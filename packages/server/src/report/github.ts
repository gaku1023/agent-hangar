// 作者への問い合わせの GitHub まわり。似た issue の検索と、下書きを埋めた新しい issue のページの URL。

/** 送り先。作者の公開リポジトリである。 */
export const REPORT_REPO = 'gaku1023/agent-hangar';

/** 新しい issue のページの URL の上限。GitHub は長い URL を断るので、余裕を見て 8,000 字に収める。 */
export const URL_MAX = 8_000;

/** 似た issue として返す件数。 */
const SIMILAR_MAX = 5;
/** 検索に使う語の数。多すぎると何も当たらない。 */
const TERMS_MAX = 6;
/** 検索を待つ長さ。下書きを長く止めない。 */
const SEARCH_TIMEOUT_MS = 5_000;

export type SimilarIssue = { number: number; title: string; url: string };
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 題名と本文を埋めた新しい issue のページの URL。
 * 上限を越えるときは本文を後ろから切り詰め、注記を足す。切り詰めは文字単位で行い、サロゲートの字を割らない。
 */
export function newIssueUrl(repo: string, title: string, body: string, truncatedNote: string, max = URL_MAX): { url: string; truncated: boolean } {
  const make = (b: string) => `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body: b }).toString()}`;
  const full = make(body);
  if (full.length <= max) return { url: full, truncated: false };
  const chars = [...body];
  // 符号化した長さは字ごとに違うので、収まる長さを二分探索で探す。
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (make(`${chars.slice(0, mid).join('').trimEnd()}\n\n${truncatedNote}`).length <= max) lo = mid;
    else hi = mid - 1;
  }
  return { url: make(`${chars.slice(0, lo).join('').trimEnd()}\n\n${truncatedNote}`), truncated: true };
}

/** 題名から検索の語を取る。頭の [bug] などの印、<project-1> などの伏せ字、記号を外す。 */
export function similarTerms(title: string): string[] {
  return title
    .replace(/^\s*\[[a-z]+\]/i, ' ')
    .replace(/<[a-z]+(?:-\d+)?>/gi, ' ')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TERMS_MAX);
}

/**
 * 開いている似た issue を、GitHub の公開の検索 API で引く。ログインは要らない。
 * 失敗したとき（回数の制限、オフライン、時間切れ）は null を返し、下書きは止めない。語が無ければ引かずに空を返す。
 */
export async function searchSimilar(fetchFn: FetchFn, repo: string, title: string): Promise<SimilarIssue[] | null> {
  const terms = similarTerms(title);
  if (terms.length === 0) return [];
  const q = `repo:${repo} is:issue is:open ${terms.join(' ')}`;
  try {
    const res = await fetchFn(`https://api.github.com/search/issues?${new URLSearchParams({ q, per_page: String(SIMILAR_MAX) }).toString()}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-hangar' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json() as { items?: { number: number; title: string; html_url: string }[] };
    return (json.items ?? []).slice(0, SIMILAR_MAX).map((i) => ({ number: i.number, title: i.title, url: i.html_url }));
  } catch {
    return null;
  }
}
