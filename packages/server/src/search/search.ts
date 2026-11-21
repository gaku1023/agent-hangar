import { matchesStopFilter, splitFtsTokens, toFtsQuery, type LiveFilter, type StopReason, type SearchHitDto, type SearchParamsDto, type SearchResultDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { stripFtsTail } from './ftsTail.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SNIPPETS_PER_HIT = 3;
/**
 * 1 文字の語だけの検索は like の全走査になるので、集計に回す行数をここで打ち切る。
 * 行数がこれを超えると件数と順位が不完全になるが、コストを抑える方を選ぶ。
 */
const LIKE_ONLY_SCAN_CAP = 5000;
/** like 経路の抜粋で、当たった語の前後を合わせて残す文字数。 */
const LIKE_SNIPPET_CHARS = 60;

/**
 * 2 文字の語を、event_fts の語彙（fts5vocab）から引いた trigram の OR にして、text の列の MATCH 式にする。
 * 2 文字を含む行は、その 2 文字で始まる trigram を必ず 1 つ持つ。本文の最後の 2 文字も、末尾に足した区切り（ftsTail.ts）との trigram を持つ。
 * 語彙は並んでいるので、範囲で引けばミリ秒で済む。like の全走査は数秒かかり、主スレッドを止める。
 * 当たる trigram が 1 つも無ければ null（どの行にも当たらない）。
 */
const vocabReady = new WeakSet<Db>();
function bigramMatch(db: Db, token: string): string | null {
  if (!vocabReady.has(db)) {
    db.exec('create virtual table if not exists temp.event_fts_vocab using fts5vocab(main, event_fts, row)');
    vocabReady.add(db);
  }
  const lower = token.toLowerCase();
  const rows = db.prepare('select term from temp.event_fts_vocab where term >= ? and term <= ?').all(lower, lower + '\u{10FFFF}') as { term: string }[];
  const terms = rows.map((r) => r.term).filter((t) => [...t].length === 3 && t.startsWith(lower));
  if (terms.length === 0) return null;
  return 'text : (' + terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ') + ')';
}

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
 * MATCH の経路の抜粋（snippet()）が、検索語を 1 つも丸ごと含まないときは、本文から最初の長い語の前後を切り出し直す。
 * snippet() の窓は trigram の 12 トークン（14 文字ほど）で、当たりが列の頭に近いと列の頭から切るので、語が途中で切れる。
 * 短い依頼で起きやすく、14 文字を超える語はいつでも起きうる。
 * 画面は抜粋の中の検索語に印を付ける（ui の markTerms）ので、語が切れると印が付かない。
 * 比べ方は画面の印と同じく、引用符を外し、大文字と小文字を問わない。どれか 1 つでも含めば、snippet() の抜粋をそのまま返す。
 */
export function fitSnippet(snippet: string, full: string, tokens: { long: string[]; short: string[] }): string {
  const terms = [...tokens.long, ...tokens.short].map((t) => t.replace(/"/g, '')).filter((t) => t !== '');
  const lower = snippet.toLowerCase();
  if (terms.length === 0 || terms.some((t) => lower.includes(t.toLowerCase()))) return snippet;
  const anchor = tokens.long.map((t) => t.replace(/"/g, '')).find((t) => t !== '') ?? terms[0]!;
  return likeSnippet(full, anchor);
}

/**
 * event_fts を全文検索し、session_id ごとに件数と抜粋をまとめて返す。
 * 3 文字以上の語は toFtsQuery で MATCH に載せ、複数語は AND になる。
 * 3 文字未満の語は trigram に当たらないので、行の text への like で補う。
 * 検索語が無くても触ったファイルがあれば、そのファイルを触ったセッションを新しい順に返す。
 * このときの件数はそのファイルに触れたイベントの数で、抜粋は持たない。
 * total は条件に合う全件の数で、hits は offset から limit 件だけを持つ。
 * セッションの状態（Active・Paused・Done・Archived、提案）は session_states で絞る。Active は状態が無いもので、行の無いセッションも Active である。
 * 動き（実行中、入力待ち、終了）の判定は DB に無いので、hangar の id と provider_session_id から状態を返す関数を第三引数で受ける。
 * 渡されなければ、どのセッションも終了とみなす。
 */
export function searchSessions(db: Db, params: SearchParamsDto, liveOf: (sessionId: string, providerSessionId: string) => LiveFilter = () => 'ended', stopOf: (sessionId: string, providerSessionId: string) => StopReason | null = () => null): SearchResultDto {
  const { long, short } = splitFtsTokens(params.q);
  // 2 文字の語は語彙から引いた trigram の MATCH にし、1 文字の語だけ like で補う。
  const bigrams = short.filter((t) => [...t].length === 2);
  const singles = short.filter((t) => [...t].length < 2);
  const bigramParts = bigrams.map((t) => bigramMatch(db, t));
  const noBigramHit = bigramParts.includes(null);
  const matchParts = [...(long.length > 0 ? [toFtsQuery(params.q)!] : []), ...bigramParts.filter((p): p is string => p !== null)];
  const match = matchParts.length > 0 ? matchParts.join(' AND ') : null;
  const hasText = long.length > 0 || short.length > 0;
  if (!hasText && !params.file) return { hits: [], total: 0 };
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(params.offset ?? 0, 0);

  // 行の本文に対する条件。MATCH と like を組み合わせ、抜粋の取得でも同じものを使う。
  const textWhere: string[] = [];
  const textArgs: unknown[] = [];
  if (match) { textWhere.push('f.text match ?'); textArgs.push(match); }
  for (const t of singles) { textWhere.push("f.text like ? escape '\\'"); textArgs.push(likePattern(t)); }

  const where: string[] = ['s.deleted_at is null'];
  const args: unknown[] = [];
  if (params.projectId) { where.push('s.project_id = ?'); args.push(params.projectId); }
  if (params.since !== undefined) { where.push('s.last_activity_at >= ?'); args.push(params.since); }
  if (params.until !== undefined) { where.push('s.last_activity_at < ?'); args.push(params.until); }
  if (params.file) {
    where.push("exists (select 1 from event_index e where e.session_id = s.id and e.file_path like ? escape '\\')");
    args.push(likePattern(params.file));
  }
  // 状態と提案を両方持つ行は、状態を正として提案は無いものとする（spec の「失敗の扱い」。states.ts の visibleCandidate と同じ読み方）。
  const stateIs = (cond: string) => `exists (select 1 from session_states st where st.session_id = s.id and st.deleted_at is null and ${cond})`;
  const visibleCandidate = 'st.status is null and st.candidate_at is not null and st.candidate_status is not null and st.candidate_source is not null';
  if (params.status === 'paused' || params.status === 'done' || params.status === 'archived') { where.push(stateIs('st.status = ?')); args.push(params.status); }
  if (params.status === 'proposed') where.push(stateIs(visibleCandidate));
  // Active は状態が無いもの。提案だけの行と、手で Active に戻した行（status が null の行）も入る。
  if (params.status === 'active') where.push(`not ${stateIs('st.status is not null')}`);
  // 「すべて」のタブで条件を入れたときは、Archived（試し・失敗）を除く。
  if (params.hideArchived && params.status === undefined) where.push(`not ${stateIs("st.status = 'archived'")}`);
  // 動きの絞り込みは、呼ぶ側の liveOf で決める。無ければ liveOf を呼ばない。
  // 止まっている理由（許可待ち、使用制限）も同じく、呼ぶ側の stopOf で決める。
  const keep = (r: { sid: string; psid: string }) => (params.live === undefined || liveOf(r.sid, r.psid) === params.live)
    && (params.stop === undefined || matchesStopFilter(stopOf(r.sid, r.psid), params.stop));
  if (!hasText) {
    // 本文の条件が無いので、セッションを直接並べる。件数はそのファイルに触れたイベントの数にする。
    const sql = `select s.id sid, s.provider_session_id psid, (select count(*) from event_index e where e.session_id = s.id and e.file_path like ? escape '\\') n from sessions s where ${where.join(' and ')} order by s.last_activity_at desc`;
    let rows = db.prepare(sql).all(likePattern(params.file!), ...args) as { sid: string; psid: string; n: number }[];
    rows = rows.filter(keep);
    return { hits: rows.slice(offset, offset + limit).map((r) => ({ sessionId: r.sid, matchCount: r.n, snippets: [] })), total: rows.length };
  }
  // トランスクリプト（event_fts）の当たり。
  // MATCH があれば索引で候補が絞れるので event_fts を直接結合する。
  // like だけのときは全走査になるので、集計に回す行数を LIKE_ONLY_SCAN_CAP で打ち切ってから結合する。
  // 名前と要約の照合は打ち切らない（下）。
  const source = match
    ? `event_fts f join sessions s on s.id = f.session_id where ${[...textWhere, ...where].join(' and ')}`
    : `(select session_id from event_fts f where ${textWhere.join(' and ')} limit ${LIKE_ONLY_SCAN_CAP}) f join sessions s on s.id = f.session_id where ${where.join(' and ')}`;
  const sql = `select s.id sid, s.provider_session_id psid, s.last_activity_at la, count(*) n from ${source} group by s.id`;
  // 2 文字の語に当たる trigram が無ければ、トランスクリプトのどの行にも当たらない。
  const transcript = noBigramHit ? [] : db.prepare(sql).all(...textArgs, ...args) as { sid: string; psid: string; la: number | null; n: number }[];

  // 名前と要約の当たり。語は 3 文字以上も未満も like で引き、名前の組、要約の組のそれぞれの中で全部の語を満たす行を当たりとする。
  // 名前の組をまたいで（名前に 1 語、要約に 1 語のように）満たす行は当たりにしない。
  const tokens = [...long, ...short];
  const hayOf = (cols: string[]) => '(' + cols.map((c) => `coalesce(${c}, '')`).join(" || char(10) || ") + ')';
  const allLike = (hay: string) => tokens.map(() => `${hay} like ? escape '\\'`).join(' and ');
  // 名前の照合は、一覧に出す表示名と同じ優先順の 1 つだけを引く（db/queries.ts の displayName）。
  // 隠れた列だけに当たった行が「名前に一致」に混ざると、見える名前に語が無いのに名前の一致に見えるからである。
  // 空の文字列は無いものとして飛ばし、first_prompt は先頭の 40 字（SQLite の substr は文字数で数える）である。
  // 実行中の Claude Code が持つ利用者の名前（nameSource が user の live 名）は DB に無いので、ここでは使えない。
  const nameHay = "coalesce(nullif(s.custom_title, ''), nullif(n.name, ''), nullif(s.ai_title, ''), substr(s.first_prompt, 1, 40), '')";
  const summaryHay = hayOf(['m.title', 'm.one_liner', 'm.body']);
  const tokenArgs = tokens.map(likePattern);
  const nameSql = `select * from (select s.id sid, s.provider_session_id psid, s.last_activity_at la, case when ${allLike(nameHay)} then 1 else 0 end nm, case when ${allLike(summaryHay)} then 1 else 0 end sm from sessions s left join session_notes n on n.session_id = s.id and n.deleted_at is null left join session_summaries m on m.session_id = s.id and m.deleted_at is null where ${where.join(' and ')}) where nm = 1 or sm = 1`;
  const named = db.prepare(nameSql).all(...tokenArgs, ...tokenArgs, ...args) as { sid: string; psid: string; la: number | null; nm: number; sm: number }[];

  // 2 つの当たりを 1 行にまとめる。重なった行は 1 件に数える。
  type Row = { sid: string; psid: string; la: number; n: number; nm: boolean; sm: boolean };
  const merged = new Map<string, Row>();
  for (const r of transcript) merged.set(r.sid, { sid: r.sid, psid: r.psid, la: r.la ?? 0, n: r.n, nm: false, sm: false });
  for (const r of named) {
    const cur = merged.get(r.sid);
    if (cur) { cur.nm = r.nm === 1; cur.sm = r.sm === 1; }
    else merged.set(r.sid, { sid: r.sid, psid: r.psid, la: r.la ?? 0, n: 0, nm: r.nm === 1, sm: r.sm === 1 });
  }
  // 並び：名前か要約に当たった行（トランスクリプトにも当たった行を含む）を先に、トランスクリプトだけの行が続く。
  // 先の組は名前に当たった行、要約だけの行の順で、組の中は新しい順。後の組は件数の多い順、同じなら新しい順。
  // 最後は id で決める。時刻と件数が同じ行があっても offset をまたいで並びが揺れないようにするためである。
  const head = (r: Row) => r.nm || r.sm;
  const rows = [...merged.values()].filter(keep).sort((a, b) =>
    Number(head(b)) - Number(head(a))
    || (head(a) ? Number(b.nm) - Number(a.nm) : b.n - a.n)
    || b.la - a.la
    || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  const total = rows.length;

  // 3 文字以上の語だけのときは snippet() で切り、抜粋が語を丸ごと含まないときに切り出し直すため本文も取る（fitSnippet）。
  // 2 文字の語があるときは、snippet() をかけない。語彙から引いた何百もの trigram を行ごとに探すので、150 行で 2 秒かかる。
  // like だけの経路と同じく、本文を取って likeSnippet で切り出す。
  const useSnippet = match !== null && bigrams.length === 0;
  const column = useSnippet ? "snippet(event_fts, 4, '', '', '…', 12) text, text body" : 'text';
  const anchor = long[0] ?? bigrams[0] ?? singles[0]!;
  // seq は主線とサブエージェントで別々に振るので、どの線の行かを agentId で添える（主線は null）。
  // 並びは主線を先に、seq の順にする。決めないと、跳び先（J1）に使う最初の抜粋が挿入の順で揺れる。
  // 抜粋は、この頁の当たりのセッション全部を 1 回の問い合わせで取り、セッションごとに SNIPPETS_PER_HIT 件までにする。
  const page = rows.slice(offset, offset + limit);
  const bySession = new Map<string, (SearchHitDto['snippets'][number] & { body?: string })[]>();
  const withText = page.filter((r) => r.n > 0).map((r) => r.sid);
  if (withText.length > 0) {
    const win = (cols: string) => `select ${cols}, row_number() over (partition by f.session_id order by (f.agent_id is not null), cast(f.seq as integer)) rn from event_fts f where f.session_id in (select value from json_each(?)) and ${textWhere.join(' and ')}`;
    // snippet() は窓関数の中では使えないので、使うときは内側で行（rowid）を選び、外側で MATCH しなおして抜粋を取る。
    const sql = useSnippet
      ? `select f.session_id sid, seq, role, agent_id agentId, ${column} from event_fts f where f.text match ? and f.rowid in (select rowid from (${win('f.rowid rowid')}) where rn <= ${SNIPPETS_PER_HIT}) order by f.session_id, (f.agent_id is not null), cast(f.seq as integer)`
      : `select sid, seq, role, agentId, text from (${win('f.session_id sid, f.seq seq, f.role role, f.agent_id agentId, f.text text')}) where rn <= ${SNIPPETS_PER_HIT} order by sid, rn`;
    const snipRows = db.prepare(sql).all(...(useSnippet ? [match] : []), JSON.stringify(withText), ...textArgs) as ((SearchHitDto['snippets'][number] & { body?: string }) & { sid: string })[];
    for (const { sid, ...raw } of snipRows) {
      // 索引の末尾の区切りは、画面に出さない。
      const s = { ...raw, text: stripFtsTail(raw.text), ...(raw.body !== undefined ? { body: stripFtsTail(raw.body) } : {}) };
      const list = bySession.get(sid) ?? [];
      list.push(s);
      bySession.set(sid, list);
    }
  }
  const hits: SearchHitDto[] = page.map((r) => {
    const matched: NonNullable<SearchHitDto['matched']> = [];
    if (r.nm) matched.push('name');
    if (r.sm) matched.push('summary');
    if (r.n > 0) matched.push('transcript');
    if (r.n === 0) return { sessionId: r.sid, matchCount: 0, snippets: [], matched };
    const got = bySession.get(r.sid) ?? [];
    const snippets: SearchHitDto['snippets'] = got.map(({ body, ...s }) => ({ ...s, text: useSnippet ? fitSnippet(s.text, body ?? s.text, { long, short }) : likeSnippet(s.text, anchor) }));
    return {
      sessionId: r.sid,
      matchCount: r.n,
      snippets,
      matched,
    };
  });
  return { hits, total };
}
