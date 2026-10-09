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

export function redactText(text: string, pairs: Pairs): string {
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
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

/**
 * トランスクリプトの 1 行を伏せる。
 * 添付は、積んだ指示のほかは種類だけを残す。添付には利用者の CLAUDE.md、スキルの一覧、MCP の道具、環境が入るためである。
 * 利用者の発言でない user の行（isMeta）も、本文を伏せる。
 */
export function redactTranscriptLine(rec: unknown, pairs: Pairs): unknown {
  if (!isRec(rec)) return rec;
  let r: Rec = rec;
  if (r.type === 'attachment' && isRec(r.attachment) && !KEEP_ATTACHMENTS.has(String(r.attachment.type))) r = { ...r, attachment: { type: r.attachment.type } };
  if (r.type === 'user' && r.isMeta === true && isRec(r.message)) r = { ...r, message: { ...r.message, content: '(redacted)' } };
  return redactDeep(r, pairs);
}

/** statusline の JSON を伏せる。使用率、戻る時刻、費用は実際の使用量なので、決まった値にする。戻る時刻の単位は保つ。 */
export function redactStatusline(rec: unknown, pairs: Pairs): unknown {
  const r = redactDeep(rec, pairs);
  if (!isRec(r)) return r;
  const out: Rec = { ...r };
  if (isRec(out.cost) && typeof out.cost.total_cost_usd === 'number') out.cost = { ...out.cost, total_cost_usd: PLACEHOLDER.costUsd };
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

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** text に word が、前後を英数字に挟まれない形で、大文字小文字を問わず現れるか。語の一部（someone に対する someonelse や nosomeone）は数えない。 */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'i').test(text);
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
  // ユーザー名は短くありふれた語になりうるので、語として現れたときだけ数える。
  if (s.user.length >= 3 && hasWord(text, s.user)) out.push('ユーザー名');
  if ([...text.matchAll(EMAIL)].some((m) => m[0] !== PLACEHOLDER.email)) out.push('メールアドレスらしい文字列');
  return out;
}
