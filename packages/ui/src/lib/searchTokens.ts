import type { SearchFilter, StatusFilter } from '@agent-hangar/shared';

/**
 * Home の検索欄のトークン（★）。
 * 欄を正とし、タブと絞り込みはその表示である。読むのは parseQuery、書くのは formatQuery で、どちらも純粋な関数にする。
 * 読めないトークン（打ち間違い、当たらないプロジェクト）は捨てずに語として残し、badTokens が知らせる。
 * 黙って捨てると、利用者には絞り込みが効いたように見えて、実は全件を見ていることになるからである。
 */

/** チップ 1 つが受け持つ絞り込みの項目。 */
export type QueryKey = 'status' | 'live' | 'days' | 'projectId' | 'file';
/** 欄の中のチップ。token は欄に書く綴りそのもの。 */
export type QueryToken = { key: QueryKey; token: string };
/** project: を名前で引くための、プロジェクトの id と名前。 */
export type QueryProject = { id: string; name: string };

const STATUS_WORDS: readonly string[] = ['paused', 'done', 'archived', 'active', 'proposed'];
const LIVE_WORDS: readonly string[] = ['running', 'waiting'];
/** since: で受ける日数の上限。打ち間違いの桁あふれを通さない。 */
const MAX_DAYS = 3650;
/** key:"空白を含む値"、key:値、ただの語の 3 つ。 */
const PART = /([A-Za-z]+):"([^"]*)"|([A-Za-z]+):(\S+)|(\S+)/g;
/** 読めなければ知らせる鍵。ほかの鍵のコロン（URL や時刻）は、ただの語である。 */
const KNOWN_KEY = /^(is|since|project|file):/i;

/** 名前の比べ方。macOS のフォルダ名は濁点を分けた NFD で来ることがあるので、NFC にそろえてから小文字で比べる。 */
const fold = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * project: の値に当たるプロジェクト。
 * 名前がそのまま同じものを先に取り、無ければ前方一致のうち名前の短いもの（同じ長さなら名前の順）を取る。
 */
function resolveProject(prefix: string, projects: readonly QueryProject[]): string | null {
  const p = fold(prefix);
  if (p === '') return null;
  const exact = projects.find((x) => fold(x.name) === p);
  if (exact) return exact.id;
  const hits = projects.filter((x) => fold(x.name).startsWith(p)).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return hits[0]?.id ?? null;
}

/** 1 つのトークンを filter に書く。読めたら true。同じ項目は後に書いたものが勝つ。 */
function readToken(key: string, value: string, filter: Partial<SearchFilter>, projects: readonly QueryProject[]): boolean {
  switch (key) {
    case 'is': {
      const v = value.toLowerCase();
      if (STATUS_WORDS.includes(v)) { filter.status = v as StatusFilter; return true; }
      if (LIVE_WORDS.includes(v)) { filter.live = v as 'running' | 'waiting'; return true; }
      return false;
    }
    case 'since': {
      const m = /^(\d{1,4})d$/i.exec(value);
      const n = m ? Number(m[1]) : 0;
      if (n < 1 || n > MAX_DAYS) return false;
      filter.days = n;
      return true;
    }
    case 'project': {
      const id = resolveProject(value, projects);
      if (id === null) return false;
      filter.projectId = id;
      return true;
    }
    case 'file':
      if (value === '') return false;
      filter.file = value;
      return true;
    default:
      return false;
  }
}

function scan(input: string, projects: readonly QueryProject[]): { text: string; filter: Partial<SearchFilter>; bad: string[] } {
  const words: string[] = [];
  const bad: string[] = [];
  const filter: Partial<SearchFilter> = {};
  for (const m of input.matchAll(PART)) {
    const [raw, qKey, qVal, bKey, bVal, plain] = m;
    if (plain !== undefined) {
      // is: のように値の無いものは、ここに落ちる。
      if (KNOWN_KEY.test(plain)) bad.push(plain);
      words.push(plain);
      continue;
    }
    if (readToken((qKey ?? bKey)!.toLowerCase(), (qVal ?? bVal)!, filter, projects)) continue;
    if (KNOWN_KEY.test(raw)) bad.push(raw);
    words.push(raw);
  }
  return { text: words.join(' '), filter, bad };
}

/**
 * 欄の文字列を、検索語と絞り込みに分ける。
 * projects を渡さなければ project: は読めず、語として残る。
 */
export function parseQuery(text: string, projects: readonly QueryProject[] = []): { text: string; filter: Partial<SearchFilter> } {
  const r = scan(text, projects);
  return { text: r.text, filter: r.filter };
}

/** 読めなかったトークン。欄の下で、語として本文を探していることを知らせるのに使う。 */
export function badTokens(text: string, projects: readonly QueryProject[] = []): string[] {
  return scan(text, projects).bad;
}

/** 空白か二重引用符を含む値は引用符で包む。値の中の二重引用符は書けないので落とす。 */
const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

/**
 * 絞り込みをチップの並びにする。並びは状態、動き、期間、プロジェクト、ファイルの順。
 * 動きの終了（ended）と期間の終わり（until）はトークンを持たないので出さない。条件の行と「条件をクリア」で外せる。
 * 見つからないプロジェクトは名前の代わりに id を書く。読み直しても当たらないので、欄の下に知らせが出る。
 */
export function queryTokens(filter: Partial<SearchFilter>, projects: readonly QueryProject[] = []): QueryToken[] {
  const out: QueryToken[] = [];
  if (filter.status) out.push({ key: 'status', token: `is:${filter.status}` });
  if (filter.live === 'running' || filter.live === 'waiting') out.push({ key: 'live', token: `is:${filter.live}` });
  if (filter.days) out.push({ key: 'days', token: `since:${filter.days}d` });
  if (filter.projectId) out.push({ key: 'projectId', token: `project:${quote(projects.find((p) => p.id === filter.projectId)?.name ?? filter.projectId)}` });
  if (filter.file) out.push({ key: 'file', token: `file:${quote(filter.file)}` });
  return out;
}

/** 検索語と絞り込みを、欄に書く 1 本の文字列にする。トークンを先に、語を後ろに置く。 */
export function formatQuery(text: string, filter: Partial<SearchFilter>, projects: readonly QueryProject[] = []): string {
  return [...queryTokens(filter, projects).map((t) => t.token), text].filter((s) => s !== '').join(' ');
}
