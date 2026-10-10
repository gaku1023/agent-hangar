import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigExecMark, ConfigItemKind, ConfigUnsentKind } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { MAX_ITEM_BYTES } from './bundle.ts';
import { fileId, kindOfRel, memoryId, settingsId, slugOfPath } from './ids.ts';
import { findSecret } from './secrets.ts';
import { canonicalJson, sortSettings, type DroppedKey } from './settingsSort.ts';

/**
 * 手元の ~/.claude から、運ぶ項目を集める（設定の同期の設計書の 3 章）。
 * 読むだけで、何も書かない。
 *
 * 運ぶもの：CLAUDE.md、keybindings.json、settings.json の鍵（sortSettings が仕分ける）、
 * skills、commands、agents、~/.claude/memory、プロジェクトのメモリ（hangar のプロジェクトの id で運ぶ）。
 * シンボリックリンクは辿らず、大きすぎるファイルと除外の名前は拾わない（旧実装と同じ決まり）。
 *
 * 秘密らしい文字列のある項目は withheld にして返す。送る側は送らないが、手元に有ることは 3 方向の判定に要るので、項目としては残す。
 */

/** 項目の数の上限。想定外に大きな木（skills に何かを展開した、など）で束が膨らまないようにする。 */
const MAX_ITEMS = 5000;

export type LocalItem = {
  id: string;
  kind: ConfigItemKind;
  /** 画面に出す名前。ファイルは相対パス（プロジェクトのメモリは memory/ の下）、settings は鍵。 */
  label: string;
  sha256: string;
  size: number;
  marks: ConfigExecMark[];
  content: Buffer;
  /** 手元の更新時刻（ファイルの mtime。settings の鍵は settings.json の mtime）。競合の札に出す。 */
  mtime: number | null;
  /** 書き込み先。ファイルは設定の入れ物からの相対パス、settings は `settings.json#<鍵>`。 */
  target: string;
  /** 秘密らしい文字列があって送らない項目は 'secret'。 */
  withheld: 'secret' | null;
};

/** 送らなかった項目の候補。allowed は「それでも送る」が効いていること。 */
export type UnsentCandidate = {
  id: string;
  kind: ConfigUnsentKind;
  itemId: string;
  label: string;
  /** `absolute-path`、または `secret:<見つけた形の名前>`。 */
  reason: string;
  contentSha256: string;
  allowed: boolean;
};

/**
 * 手元にあるが運べないものの id。リンク、大きすぎるファイル、読めないファイル、件数の上限を超えたもの、リンクのディレクトリの下、読めない settings.json。
 * これらは項目として集められないので、相手から同名の項目が届いても「手元に無い」と見て create と判定してはいけない（適用すると手元を上書きする）。
 * ids は個別の id、prefixes は、その下の id を全部塞ぐ前置（`file:commands/`、`settings:`、`memory:<プロジェクトの id>/`）。
 */
export type Blocked = { ids: Set<string>; prefixes: string[] };
export const isBlocked = (b: Blocked, id: string): boolean => b.ids.has(id) || b.prefixes.some((p) => id.startsWith(p));

export type Collected = { items: LocalItem[]; dropped: DroppedKey[]; unsent: UnsentCandidate[]; blocked: Blocked };

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);
/** 実行されない、本文やデータの拡張子。これ以外のファイルは script の印を付ける。 */
const DATA_EXTS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf']);

/**
 * 実行の印。skills、commands、agents のファイルだけに付ける。
 * hooks はフロントマターの先頭の鍵、shell は本文の `!` で始まるコマンド実行、script は本文やデータでないファイル。
 */
export function execMarksOf(rel: string, content: Buffer): ConfigExecMark[] {
  const top = rel.split('/')[0];
  if (top !== 'skills' && top !== 'commands' && top !== 'agents') return [];
  const ext = path.posix.extname(rel).toLowerCase();
  if (!DATA_EXTS.has(ext)) return ['script'];
  if (ext !== '.md' && ext !== '.markdown') return [];
  const text = content.toString('utf8');
  const marks: ConfigExecMark[] = [];
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (fm && /^hooks[ \t]*:/m.test(fm[1]!)) marks.push('hooks');
  if (/!`[^`\n]+`/.test(text) || /^```!/m.test(text)) marks.push('shell');
  return marks;
}

const isBinary = (b: Buffer): boolean => b.includes(0);

/** 読めたら中身。無い（ENOENT）は 'absent'、あるのに運べない（リンク、普通のファイルでない、大きすぎる、読めない）は 'blocked'。 */
function readRegular(abs: string): { content: Buffer; mtime: number } | 'absent' | 'blocked' {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'blocked'; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_ITEM_BYTES) return 'blocked';
  try { return { content: fs.readFileSync(abs), mtime: Math.floor(st.mtimeMs) }; } catch { return 'blocked'; }
}

/**
 * dir の下のファイルの絶対パスを、リンクを辿らず、除外の名前を降りずに集める。
 * リンクは辿らずに onLink へ渡す（ファイルかディレクトリかは辿らないと分からないので、どちらの id も塞げるように呼び手へ任せる）。
 * 読めないディレクトリも onLink へ渡す（中に何があるか分からない）。
 */
function walk(dir: string, onLink: (abs: string) => void, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onLink(dir); return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) { onLink(abs); continue; }
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(abs, onLink, out); } else out.push(abs);
  }
  return out;
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

export function collectLocal(o: { db: Db; deviceId: string; claudeDir: string; allowedUnsent: ReadonlyMap<string, string>; /** 項目の数の上限。試験が小さくするために使う。 */ maxItems?: number }): Collected {
  const { claudeDir } = o;
  const maxItems = o.maxItems ?? MAX_ITEMS;
  const blocked: Blocked = { ids: new Set(), prefixes: [] };
  /** 設定の入れ物の中のパス（ファイルかディレクトリか分からない）を塞ぐ。 */
  const blockRel = (rel: string): void => { blocked.ids.add(fileId(rel)); blocked.prefixes.push(`${fileId(rel)}/`); };
  const items = new Map<string, LocalItem>();
  const unsent: UnsentCandidate[] = [];
  const dropped: DroppedKey[] = [];

  const add = (id: string, kind: ConfigItemKind, label: string, target: string, content: Buffer, marks: ConfigExecMark[], mtime: number | null): void => {
    if (items.has(id)) return;
    // 上限を超えたものは運ばないが、手元にあることは覚える。
    if (items.size >= maxItems) { blocked.ids.add(id); return; }
    const hash = sha256(content);
    let withheld: 'secret' | null = null;
    if (!isBinary(content)) {
      const found = findSecret(content.toString('utf8'));
      if (found) {
        const uid = `secret:${id}`;
        const allowed = o.allowedUnsent.get(uid) === hash;
        unsent.push({ id: uid, kind: 'secret', itemId: id, label, reason: `secret:${found}`, contentSha256: hash, allowed });
        if (!allowed) withheld = 'secret';
      }
    }
    items.set(id, { id, kind, label, sha256: hash, size: content.length, marks, content, mtime, target, withheld });
  };

  const addFile = (rel: string, abs: string): void => {
    const kind = kindOfRel(rel);
    if (!kind) return;
    const f = readRegular(abs);
    if (f === 'absent') return;
    if (f === 'blocked') { blocked.ids.add(fileId(rel)); return; }
    add(fileId(rel), kind, rel, rel, f.content, execMarksOf(rel, f.content), f.mtime);
  };

  const relOf = (abs: string): string => toPosix(path.relative(claudeDir, abs));
  for (const rel of ['CLAUDE.md', 'keybindings.json']) addFile(rel, path.join(claudeDir, rel));
  for (const top of ['skills', 'commands', 'agents', 'memory']) {
    // 入れ物の途中がリンクなら、その先は読まない。ただし、そこに同名の項目が届いて上書きされないよう、塞ぎに入れる。
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(claudeDir, top)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') blockRel(top); continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) { blockRel(top); continue; }
    for (const abs of walk(path.join(claudeDir, top), (link) => blockRel(relOf(link))).sort()) addFile(relOf(abs), abs);
  }

  // プロジェクトのメモリ。この PC のルートのパスから slug を作り、projects/<slug>/memory/ に当てる。
  const slugs = new Map<string, string>();
  const roots = o.db.prepare(`select r.project_id id, r.path path from project_roots r join projects p on p.id = r.project_id
    where r.device_id = ? and r.deleted_at is null and p.deleted_at is null order by r.project_id`).all(o.deviceId) as { id: string; path: string }[];
  for (const r of roots) { const s = slugOfPath(r.path); if (!slugs.has(s)) slugs.set(s, r.id); }
  for (const [slug, projectId] of slugs) {
    const memDir = path.join(claudeDir, 'projects', slug, 'memory');
    const blockProject = (): void => { blocked.prefixes.push(memoryId(projectId, '')); };
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(claudeDir, 'projects', slug)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') blockProject(); continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) { blockProject(); continue; }
    try { if (fs.lstatSync(memDir).isSymbolicLink()) { blockProject(); continue; } } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') blockProject(); continue; }
    // メモリの下のリンクは、そのプロジェクトのメモリ全部を塞ぐ（相対パスの対応が取れない）。
    const memLink = (link: string): void => { const id = memoryId(projectId, toPosix(path.relative(memDir, link))); blocked.ids.add(id); blocked.prefixes.push(`${id}/`); };
    for (const abs of walk(memDir, memLink).sort()) {
      const rel = toPosix(path.relative(memDir, abs));
      // 名前の検査は、ids.ts の物差し（memory:<id>/<rel>）に通す。通らない名前は運ばない。
      if (kindOfRel(`memory/${rel}`) !== 'memory') continue;
      const f = readRegular(abs);
      if (f === 'blocked') blocked.ids.add(memoryId(projectId, rel));
      else if (f !== 'absent') add(memoryId(projectId, rel), 'memory', rel, `projects/${slug}/memory/${rel}`, f.content, [], f.mtime);
    }
  }

  // settings.json。鍵ごとの項目に分け、運ばない鍵と落とした規則を記録する。
  let json: unknown = null;
  const settingsRead = readRegular(path.join(claudeDir, 'settings.json'));
  const rawSettings = typeof settingsRead === 'object' ? settingsRead : null;
  // リンク、大きすぎる、読めない、JSON でない、オブジェクトでない settings.json には、相手の鍵を書き込めない。
  if (settingsRead === 'blocked') blocked.prefixes.push('settings:');
  if (rawSettings) {
    try { json = JSON.parse(rawSettings.content.toString('utf8')); } catch { json = null; }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) { json = null; blocked.prefixes.push('settings:'); }
  }
  const allowedRules = new Set<string>();
  const allowedRuleIds = new Map<string, string>();
  const ruleId = (list: string, rule: string): string => `rule:${list}:${sha256(rule).slice(0, 16)}`;
  for (const [uid, hash] of o.allowedUnsent) if (uid.startsWith('rule:')) allowedRuleIds.set(uid, hash);
  const sorted = sortSettings(json, { allowedRules: new Set() });
  // 「それでも送る」が効いている規則は、仕分けを通し直して残す。
  for (const d of sorted.droppedRules) if (allowedRuleIds.get(ruleId(d.list, d.rule)) === sha256(d.rule)) allowedRules.add(d.rule);
  const final = allowedRules.size > 0 ? sortSettings(json, { allowedRules }) : sorted;
  dropped.push(...final.dropped);
  for (const s of final.items) add(settingsId(s.key), 'settings', s.key, `settings.json#${s.key}`, Buffer.from(canonicalJson(s.value)), [], rawSettings?.mtime ?? null);
  for (const d of sorted.droppedRules) {
    const allowed = allowedRules.has(d.rule);
    unsent.push({ id: ruleId(d.list, d.rule), kind: 'permission-rule', itemId: settingsId(`permissions.${d.list}`), label: d.rule, reason: 'absolute-path', contentSha256: sha256(d.rule), allowed });
  }

  unsent.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items: [...items.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), dropped, unsent, blocked };
}
