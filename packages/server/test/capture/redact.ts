import path from 'node:path';
import { mangleCwd } from '../../src/provider/claude-code/discover.ts';
import { PLACEHOLDER } from './scenario.ts';

type Rec = Record<string, unknown>;
const basename = (p: string): string => path.basename(p);
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 伏せる値。採る道具が、その場の環境と auth status から集める。
 * claudeDir は実際に使った設定の置き場（CLAUDE_CONFIG_DIR か ~/.claude）、tmpRoot はその機械の一時ディレクトリの置き場（os.tmpdir()）とその実体、
 * user は OS のユーザー名である。
 */
export type Secrets = {
  tmp: string; tmpReal: string; tmpRoot: string; tmpRootReal: string;
  home: string; claudeDir: string; user: string; host: string;
  email: string | null; orgName: string | null; orgId: string | null;
  /** 利用者の CLAUDE.md の行（前後の空白を除いて 20 文字以上のもの）。見本に残っていたら伏せ残しとする。値は出さない。 */
  contextLines: string[];
};
export type Pairs = [string, string][];

/**
 * 置き換えの組。長いものから当てる（短いものが長いものの一部を先に崩さないように）。
 * 一時ディレクトリとホームは、そのままの形と、Claude Code がプロジェクトの置き場の名前にする形（英数字以外を - にしたもの）の両方を当てる。
 * 設定の置き場は、ホームの下にあることが多いので、ホームより長いものとして先に当たる。置き場の名前の形も当てる。
 * 一時ディレクトリの置き場（macOS なら /var/folders/…/T）は、一時ディレクトリそのものとは別に /tmp へ置き換える。
 * 3 文字より短い値は当てない。ありふれた文字列を崩さないためである。
 * ユーザー名は置き換えない。ありふれた語を崩すので、残っていないかを leaks で見るだけにする。
 */
export function replacements(s: Secrets): Pairs {
  const pairs: Pairs = [
    [s.tmpReal, PLACEHOLDER.tmp], [s.tmp, PLACEHOLDER.tmp],
    [mangleCwd(s.tmpReal), mangleCwd(PLACEHOLDER.tmp)], [mangleCwd(s.tmp), mangleCwd(PLACEHOLDER.tmp)],
    [s.tmpRootReal, '/tmp'], [s.tmpRoot, '/tmp'],
    [mangleCwd(s.tmpRootReal), mangleCwd('/tmp')], [mangleCwd(s.tmpRoot), mangleCwd('/tmp')],
    [s.claudeDir, PLACEHOLDER.claudeDir], [mangleCwd(s.claudeDir), mangleCwd(PLACEHOLDER.claudeDir)],
    [s.home, PLACEHOLDER.home], [mangleCwd(s.home), mangleCwd(PLACEHOLDER.home)],
    [s.host, PLACEHOLDER.host],
  ];
  if (s.email) pairs.push([s.email, PLACEHOLDER.email]);
  if (s.orgName) pairs.push([s.orgName, PLACEHOLDER.orgName]);
  if (s.orgId) pairs.push([s.orgId, PLACEHOLDER.orgId]);
  return pairs.filter(([from]) => from.length >= 3).sort((a, b) => b[0].length - a[0].length);
}

/** 名前の部分（@ の前）に使える字。 */
const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
/** @ の後ろ。@ の直後の位置に固定して当てる。 */
const EMAIL_DOMAIN = /[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y;

/**
 * メールアドレスらしい文字列の位置（start から end の手前まで）。置き換え（redactText）と伏せ残しの見つけ方（leaks）が同じものを使う。
 * 拾う範囲は、正規表現 /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g で左から順に重ならずに拾うのと同じにする。
 * その正規表現をそのまま使うと、@ の無い長い連なりで、連なりのどの位置からも試し直して時間が長さの 2 乗に増える（10 万文字で数秒）。
 * そこで @ を 1 つずつ探し、名前の部分は @ から前へ（前に拾った所の終わりまで）、後ろは @ の直後に固定した正規表現で読む。
 * 名前の部分は @ で切れるので、どの字も前へ読むのは 1 度だけで、時間は長さに比例する。
 */
export function emailSpans(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    let start = at;
    while (start > from && EMAIL_LOCAL.test(text.charAt(start - 1))) start--;
    if (start === at) continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    const m = EMAIL_DOMAIN.exec(text);
    if (m === null) continue;
    const end = at + 1 + m[0].length;
    out.push({ start, end });
    from = end;
  }
  return out;
}

/** メールアドレスらしい文字列をどれも to にする。 */
function replaceEmails(text: string, to: string): string {
  const spans = emailSpans(text);
  if (spans.length === 0) return text;
  let out = '';
  let last = 0;
  for (const { start, end } of spans) { out += text.slice(last, start) + to; last = end; }
  return out + text.slice(last);
}

/**
 * 置き換えの組を当て、そのあとメールアドレスらしい文字列をどれも PLACEHOLDER.email にする。
 * 会話の文脈（利用者の CLAUDE.md、コミットの署名の指示など）には、組にない別のアドレスが入りうるためである。
 */
export function redactText(text: string, pairs: Pairs): string {
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return replaceEmails(out, PLACEHOLDER.email);
}

/** 値を深く辿り、文字列と鍵に置き換えを当てる。鍵にパスを持つ記録（file-history-snapshot など）があるためである。 */
export function redactDeep(v: unknown, pairs: Pairs): unknown {
  if (typeof v === 'string') return redactText(v, pairs);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, pairs));
  if (isRec(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactText(k, pairs), redactDeep(x, pairs)]));
  return v;
}

/** 中身を残す添付の種類。筋書きが作る、積んだ指示だけである。 */
const KEEP_ATTACHMENTS: ReadonlySet<string> = new Set(['queued_command']);

/** system-reminder の塊（閉じが無ければ文字列の末尾まで）。会話の文脈（利用者の CLAUDE.md など）が入る。 */
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>|<system-reminder>[\s\S]*$/g;
/** 塊の中身を伏せた形。hangar が本文の頭のタグで利用者の発言でないものを見分けるので、タグは残す。 */
const REMINDER_REDACTED = '<system-reminder>(redacted)</system-reminder>';

/** 値の文字列すべてに f を当てる（鍵には当てない）。 */
function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (isRec(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

/** assistant の本文の、考えの塊の中身を伏せる。考えは文脈を引用しうる。 */
function redactThinking(r: Rec): Rec {
  if (!isRec(r.message) || !Array.isArray(r.message.content)) return r;
  const content = r.message.content.map((b: unknown) => {
    if (!isRec(b)) return b;
    if (b.type === 'thinking') return { ...b, thinking: '(redacted)', ...('signature' in b ? { signature: '(redacted)' } : {}) };
    if (b.type === 'redacted_thinking') return { ...b, ...('data' in b ? { data: '(redacted)' } : {}) };
    return b;
  });
  return { ...r, message: { ...r.message, content } };
}

/** 数の値のときだけ to にする。数でない値や無い鍵は触らない。 */
function setIfNumber(r: Rec, keys: readonly string[], to: number): Rec {
  const out: Rec = { ...r };
  for (const k of keys) if (typeof out[k] === 'number') out[k] = to;
  return out;
}

/** cost-state の行の、累計の時間の鍵。 */
const COST_STATE_DURATIONS = ['totalAPIDuration', 'totalAPIDurationWithoutRetries', 'totalToolDuration', 'totalDuration'] as const;

/**
 * cost-state の行の費用（全体とモデルごと）と累計の時間を決まった値にする。実際の使用量だからである。
 * トークンの数、行の数、始めた時刻は残す。形の照合に使い、使用量の額を表さないためである。
 */
function redactCostState(r: Rec): Rec {
  if (r.type !== 'cost-state') return r;
  let out = setIfNumber(r, ['totalCostUSD'], PLACEHOLDER.costUsd);
  out = setIfNumber(out, COST_STATE_DURATIONS, PLACEHOLDER.durationMs);
  if (isRec(out.modelUsage)) {
    out.modelUsage = Object.fromEntries(Object.entries(out.modelUsage).map(([m, u]) => [m, isRec(u) ? setIfNumber(u, ['costUSD'], PLACEHOLDER.costUsd) : u]));
  }
  return out;
}

/**
 * トランスクリプトの 1 行を伏せる。
 * 添付は、積んだ指示のほかは種類だけを残す。添付には利用者の CLAUDE.md、スキルの一覧、MCP の道具、環境が入るためである。
 * 利用者の発言でない user の行（isMeta）も、本文を伏せる。
 * どの欄の文字列でも、system-reminder の塊は中身を伏せる（isMeta でない所にも文脈が差し込まれる）。考えの塊も中身を伏せる。
 * cost-state の行は、費用と累計の時間を決まった値にする。
 */
export function redactTranscriptLine(rec: unknown, pairs: Pairs): unknown {
  if (!isRec(rec)) return rec;
  let r: Rec = rec;
  if (r.type === 'attachment' && isRec(r.attachment) && !KEEP_ATTACHMENTS.has(String(r.attachment.type))) r = { ...r, attachment: { type: r.attachment.type } };
  if (r.type === 'user' && r.isMeta === true && isRec(r.message)) r = { ...r, message: { ...r.message, content: '(redacted)' } };
  r = redactThinking(r);
  r = redactCostState(r);
  return redactDeep(mapStrings(r, (t) => t.replace(REMINDER, REMINDER_REDACTED)), pairs);
}

/**
 * statusline の JSON を伏せる。使用率、戻る時刻、費用、累計の時間は実際の使用量なので、決まった値にする。戻る時刻の単位は保つ。
 * 累計の時間は cost-state の行と同じ値なので、片方だけ伏せても意味が無い。両方を伏せる。
 */
export function redactStatusline(rec: unknown, pairs: Pairs): unknown {
  const r = redactDeep(rec, pairs);
  if (!isRec(r)) return r;
  const out: Rec = { ...r };
  if (isRec(out.cost)) out.cost = setIfNumber(setIfNumber(out.cost, ['total_cost_usd'], PLACEHOLDER.costUsd), ['total_duration_ms', 'total_api_duration_ms'], PLACEHOLDER.durationMs);
  if (isRec(out.rate_limits)) {
    const rl: Rec = { ...out.rate_limits };
    for (const [k, w] of Object.entries(rl)) {
      if (!isRec(w)) continue;
      const next: Rec = { ...w };
      if (typeof w.used_percentage === 'number') next.used_percentage = PLACEHOLDER.usedPercent[k] ?? 1;
      if (typeof w.resets_at === 'number') {
        const sec = PLACEHOLDER.resetsAtSec[k] ?? 1_800_000_000;
        next.resets_at = w.resets_at > 1e11 ? sec * 1000 : sec;
      }
      rl[k] = next;
    }
    out.rate_limits = rl;
  }
  return out;
}

/** 登録を伏せる。pidDomain はその機械を指すので決まった値にする。 */
export function redactRegistry(rec: unknown, pairs: Pairs): unknown {
  const r = redactDeep(rec, pairs);
  return isRec(r) && typeof r.pidDomain === 'string' ? { ...r, pidDomain: PLACEHOLDER.pidDomain } : r;
}

/** auth status を伏せる。メールアドレス、組織名、組織の識別子、プランを決まった値にする。 */
export function redactAuth(rec: unknown, pairs: Pairs): unknown {
  const r = redactDeep(rec, pairs);
  if (!isRec(r)) return r;
  const out: Rec = { ...r };
  if (typeof out.email === 'string') out.email = PLACEHOLDER.email;
  if (typeof out.orgName === 'string') out.orgName = PLACEHOLDER.orgName;
  if (typeof out.orgId === 'string') out.orgId = PLACEHOLDER.orgId;
  if (typeof out.subscriptionType === 'string') out.subscriptionType = PLACEHOLDER.subscriptionType;
  // 置き場は、チルダの形（~/.claude-alt）で出る版でも置き場の名前が残らないように、直接決まった値にする。
  if (typeof out.configDirectory === 'string') out.configDirectory = PLACEHOLDER.claudeDir;
  if (typeof out.projectsDirectory === 'string') out.projectsDirectory = `${PLACEHOLDER.claudeDir}/projects`;
  return out;
}

/** agents --json から、その会話の行だけを残して伏せる。ほかの行は利用者の別の会話である。 */
export function redactAgents(rows: unknown, sessionId: string, pairs: Pairs): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => isRec(r) && r.sessionId === sessionId).map((r) => redactDeep(r, pairs));
}

const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** text に word が、前後を英数字に挟まれない形で、大文字小文字を問わず現れるか。語の一部（someone に対する someonelse や nosomeone）は数えない。 */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'i').test(text);
}

/** 利用者の CLAUDE.md の行を探す形。行そのものと、伏せた形（ホームのパスやアドレスが置き換わった形）。Secrets ごとに 1 度だけ作る。 */
const contextNeedleCache = new WeakMap<Secrets, string[]>();
function contextNeedles(s: Secrets): string[] {
  const cached = contextNeedleCache.get(s);
  if (cached) return cached;
  const pairs = replacements(s);
  // 伏せた形も、行と同じく 20 文字以上のものだけにする。短い形は見本のふつうの文字列にも当たるためである。
  const needles = [...new Set(s.contextLines.flatMap((l) => [l, redactText(l, pairs)]).filter((l) => l.length >= 20))];
  contextNeedleCache.set(s, needles);
  return needles;
}

/** 伏せ残しの名前（値そのものは出さない）。空なら書き出してよい。 */
export function leaks(text: string, s: Secrets): string[] {
  const named: [string, string | null][] = [
    ['一時ディレクトリ', s.tmp], ['一時ディレクトリの実体', s.tmpReal], ['一時ディレクトリの置き場の名前', mangleCwd(s.tmpReal)],
    ['ホーム', s.home], ['ホームの置き場の名前', mangleCwd(s.home)], ['ホスト名', s.host],
    ['メールアドレス', s.email], ['組織名', s.orgName], ['組織の識別子', s.orgId],
    // 設定の置き場の名前（.claude でないときだけ。.claude は置き換えの値にも出る）。
    ['設定の置き場の名前', basename(s.claudeDir) === '.claude' ? null : basename(s.claudeDir)],
  ];
  const out = named.filter(([, v]) => v !== null && v.length >= 3 && text.includes(v)).map(([label]) => label);
  // 利用者の CLAUDE.md の行（値は出さない）。伏せで形を変えた行も見る。
  if (contextNeedles(s).some((l) => text.includes(l))) out.push('利用者の CLAUDE.md の行');
  // ユーザー名は短くありふれた語になりうるので、語として現れたときだけ数える。
  if (s.user.length >= 3 && hasWord(text, s.user)) out.push('ユーザー名');
  if (emailSpans(text).some(({ start, end }) => text.slice(start, end) !== PLACEHOLDER.email)) out.push('メールアドレスらしい文字列');
  return out;
}
