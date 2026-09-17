import { splitFtsTokens, toFtsQuery, type SearchHitDto, type SearchParamsDto, type SearchResultDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SNIPPETS_PER_HIT = 3;
/**
 * 短い語だけの検索は like の全走査になるので、集計に回す行数をここで打ち切る。
 * 行数がこれを超えると件数と順位が不完全になるが、コストを抑える方を選ぶ。
 */
const LIKE_ONLY_SCAN_CAP = 5000;
/** like 経路の抜粋で、当たった語の前後を合わせて残す文字数。 */
const LIKE_SNIPPET_CHARS = 60;

/** like の部分一致に使う文字列を作る。ワイルドカードと逃げ文字は逃がす。 */
function likePattern(s: string): string {
  return '%' + s.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
}

/** 本文から、最初に token が現れる位置の前後を切り出す。切った側には省略記号を置く。 */
export function likeSnippet(text: string, token: string): string {
  const chars = [...text];
  const lowerText = chars.map((c) => c.toLowerCase());
  const lowerToken = [...token.toLowerCase()];
  let at = -1;
  for (let i = 0; i + lowerToken.length <= lowerText.length; i++) {
    if (lowerToken.every((c, j) => lowerText[i + j] === c)) { at = i; break; }
  }
  if (at < 0) return chars.slice(0, LIKE_SNIPPET_CHARS).join('') + (chars.length > LIKE_SNIPPET_CHARS ? '…' : '');
  const before = Math.floor((LIKE_SNIPPET_CHARS - lowerToken.length) / 3);
  const start = Math.max(0, at - before);
  const end = Math.min(chars.length, start + LIKE_SNIPPET_CHARS);
  return (start > 0 ? '…' : '') + chars.slice(start, end).join('') + (end < chars.length ? '…' : '');
}

/**
 * event_fts を全文検索し、session_id ごとに件数と抜粋をまとめて返す。
 * 3 文字以上の語は toFtsQuery で MATCH に載せ、複数語は AND になる。
 * 3 文字未満の語は trigram に当たらないので、行の text への like で補う。
 * running の判定は DB に無いので、実行中の provider_session_id の集合を第三引数で受ける。
 */
export function searchSessions(db: Db, params: SearchParamsDto, runningIds: Set<string> = new Set()): SearchResultDto {
  const { long, short } = splitFtsTokens(params.q);
  const match = long.length > 0 ? toFtsQuery(params.q) : null;
  if (!match && short.length === 0) return { hits: [], total: 0 };
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // 行の本文に対する条件。MATCH と like を組み合わせ、抜粋の取得でも同じものを使う。
  const textWhere: string[] = [];
  const textArgs: unknown[] = [];
  if (match) { textWhere.push('f.text match ?'); textArgs.push(match); }
  for (const t of short) { textWhere.push("f.text like ? escape '\\'"); textArgs.push(likePattern(t)); }

  const where: string[] = ['s.deleted_at is null'];
  const args: unknown[] = [];
  if (params.projectId) { where.push('s.project_id = ?'); args.push(params.projectId); }
  if (params.since !== undefined) { where.push('s.last_activity_at >= ?'); args.push(params.since); }
  if (params.until !== undefined) { where.push('s.last_activity_at < ?'); args.push(params.until); }
  if (params.file) {
    where.push("exists (select 1 from event_index e where e.session_id = s.id and e.file_path like ? escape '\\')");
    args.push(likePattern(params.file));
  }
  // MATCH があれば索引で候補が絞れるので event_fts を直接結合する。
  // like だけのときは全走査になるので、集計に回す行数を LIKE_ONLY_SCAN_CAP で打ち切ってから結合する。
  const source = match
    ? `event_fts f join sessions s on s.id = f.session_id where ${[...textWhere, ...where].join(' and ')}`
    : `(select session_id from event_fts f where ${textWhere.join(' and ')} limit ${LIKE_ONLY_SCAN_CAP}) f join sessions s on s.id = f.session_id where ${where.join(' and ')}`;
  const sql = `select s.id sid, s.provider_session_id psid, count(*) n from ${source} group by s.id order by n desc, s.last_activity_at desc`;
  let rows = db.prepare(sql).all(...textArgs, ...args) as { sid: string; psid: string; n: number }[];
  if (params.running !== undefined) rows = rows.filter((r) => runningIds.has(r.psid) === params.running);
  const total = rows.length;

  // snippet() は MATCH した問い合わせでしか使えないので、like だけの経路は本文を取って切り出す。
  const column = match ? "snippet(event_fts, 4, '', '', '…', 12) text" : 'text';
  const snip = db.prepare(`select seq, role, ${column} from event_fts f where f.session_id = ? and ${textWhere.join(' and ')} limit ${SNIPPETS_PER_HIT}`);
  const hits: SearchHitDto[] = rows.slice(0, limit).map((r) => {
    const snippets = snip.all(r.sid, ...textArgs) as SearchHitDto['snippets'];
    return {
      sessionId: r.sid,
      matchCount: r.n,
      snippets: match ? snippets : snippets.map((s) => ({ ...s, text: likeSnippet(s.text, short[0]!) })),
    };
  });
  return { hits, total };
}
