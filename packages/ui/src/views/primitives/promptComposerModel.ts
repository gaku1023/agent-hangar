import { appendPaths, type PromptCommandDto, type PromptCommandSource, type Translate } from '@agent-hangar/shared';
import { baseName, splitLast } from '../../lib/paths.ts';
import { byteBase } from '../../presenters/bytes.ts';

/** 候補を出すきっかけ。start は、きっかけの記号（/ か @）の位置。 */
export type Trigger = { kind: '/' | '@'; query: string; start: number };

/**
 * カーソルの位置で、候補を出すきっかけがあるかを見る。
 * / も @ も、先頭か空白（改行を含む）の直後だけ。語の途中の記号（パスや URL の /、メールアドレスの @）で候補を出さないためである。
 * / は文の途中でも出す。Claude Code が直にコマンドとして開くのは先頭の / だけだが、途中の /名前 も本文として渡り、Claude が Skill で呼ぶ（docs/design.md の「初期プロンプト欄」）。
 * どちらも、記号から空白までの語にカーソルがある間だけきっかけになる。/ の語の中の @ は、/ のきっかけとして読む。
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)([/@])(\S*)$/.exec(before);
  if (!m) return null;
  const kind = m[1] as '/' | '@';
  const query = m[2]!;
  return { kind, query, start: before.length - query.length - 1 };
}

/** 候補の行の右に出す、出どころの名前。 */
export const sourceLabel = (t: Translate, source: PromptCommandSource): string => t(`composer.source.${source}`);
const groupTitle = (t: Translate, source: PromptCommandSource): string => t(`composer.group.${source}`);
const GROUP_ORDER: PromptCommandSource[] = ['project', 'user', 'plugin', 'builtin'];
/** 「よく使う」に置く件数。 */
export const FREQUENT_COUNT = 5;

export type CommandSection = { title: string | null; items: PromptCommandDto[] };

/**
 * 候補を並べる。
 * 打つ前は群にする。自分では打たないスキルが多いので、最初の一言になった回数の多いものを先頭の「よく使う」に出す。
 * 打ったら群を解く。一致した行が群ごとに散らばると、探し直すことになるためである（Listbox と同じ）。
 */
export function arrangeCommands(t: Translate, commands: PromptCommandDto[], query: string): CommandSection[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    // sort は安定なので、回数が同じものはもとの並びを保つ。
    const frequent = commands.filter((c) => c.uses > 0).sort((a, b) => b.uses - a.uses).slice(0, FREQUENT_COUNT);
    const taken = new Set(frequent.map((c) => c.name));
    const sections: CommandSection[] = [{ title: t('composer.group.frequent'), items: frequent }, ...GROUP_ORDER.map((s) => ({ title: groupTitle(t, s), items: commands.filter((c) => c.source === s && !taken.has(c.name)) }))];
    return sections.filter((s) => s.items.length > 0);
  }
  const rank = (c: PromptCommandDto): number => { const n = c.name.toLowerCase(); return n.startsWith(q) ? 0 : n.includes(q) ? 1 : c.description.toLowerCase().includes(q) ? 2 : 3; };
  const hit = commands.map((c) => ({ c, r: rank(c) })).filter((x) => x.r < 3).sort((a, b) => a.r - b.r || b.c.uses - a.c.uses).map((x) => x.c);
  return hit.length ? [{ title: null, items: hit }] : [];
}

/**
 * 候補を確定したときの文とカーソル。きっかけからカーソルまでを置き換え、後ろに空白を 1 つ置く。
 * カーソルの後ろの文は、ひとつも消さない。「ファイル」や「スキル」の釦はカーソルの前に記号だけを入れるので、後ろには利用者が打った文が続いている。
 * 日本語の文では「語」が文の残り全部になりうるため、語の末尾まで置き換えると、打った文を黙って消すことになる（ユーザーが打った文を黙って消さないため）。
 * 後ろがすでに空白で始まるなら足さない。そこにカーソルを置く。
 */
export function acceptText(text: string, caret: number, trigger: Trigger, value: string): { text: string; caret: number } {
  const kept = text.slice(caret);
  // 空白を含むパスは、そのままでは @ の語が空白で切れてしまう。Claude Code の書き方（@"…"）で囲む。/ の名前は囲まない。
  const word = trigger.kind === '@' && /\s/.test(value) ? `"${value}"` : value;
  const head = `${text.slice(0, trigger.start)}${trigger.kind}${word}`;
  const sep = /^\s/.test(kept) ? '' : ' ';
  return { text: head + sep + kept, caret: head.length + 1 };
}

/** 初期プロンプトに添えるファイル。size は、殻から届いたもの（大きさが分からない）では null。 */
export type Attachment = { path: string; name: string; size: number | null };

/**
 * 起動のときに claude へ渡す文。本文の後に空行を置き、添付のパスを 1 行ずつ足す。
 * 起動の API は変えず、パスを文に書く。Claude はパスを見てファイルを読む（仕様書の「確かめたこと」）。
 * 置き場の名前は空白を含まないが、フォルダを落としたときは元のパスがそのまま来るので、端末へのドロップと同じ規則で囲む。
 */
export function composePrompt(body: string, attachments: Attachment[]): string {
  // 並べ方は shared の appendPaths（スマホから起動を受けるサーバも同じ形で足す）。
  return appendPaths(body, attachments.map((a) => a.path));
}

// 置き場は HANGAR_HOME の下の drops だが、UI は HANGAR_HOME を知らない。
// 場所を決め打ちすると、HANGAR_HOME を変えた環境で札の絵が出なくなるので、親のフォルダが drops かどうかで見る。
// 当てが外れても、サーバが置き場の外を 404 にし、札が拡張子の印へ替わる。
// Windows のパス（`C:\…\drops\名前`）も、同じく親のフォルダで見る。
/** 置き場のファイルらしければ、その名前（GET /api/drops/:name に渡す）。親が drops でないものや、さらに下のフォルダは null。 */
export function dropFileName(path: string): string | null {
  const { dir, base } = splitLast(path);
  if (!base) return null;
  const parent = splitLast(dir.slice(0, -1));
  // 親の手前にも区切りがあること（`drops/名前` のような相対の形は数えない）。
  return parent.base === 'drops' && parent.dir !== '' ? base : null;
}

/** 殻から届いたパスを添付にする。置き場の名前の頭（時刻と連番）は、札に出す名前から落とす。 */
export function attachmentFromPath(path: string): Attachment {
  const base = baseName(path);
  const name = dropFileName(path) ? base.replace(/^\d+-\d+-/, '') : base;
  return { path, name: name || base, size: null };
}

export const isImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(name);

/** 添付の大きさ。割る単位は byteBase（OS のファイルの画面にそろえる）。 */
export function formatSize(bytes: number, k: number = byteBase()): string {
  return bytes > k * k ? `${(bytes / (k * k)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / k))} KB`;
}
