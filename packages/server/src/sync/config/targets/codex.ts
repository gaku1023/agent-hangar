import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigExecMark, ConfigItemKind } from '@agent-hangar/shared';
import { fileItem, readRegular, walk as walkFiles } from '../fileMemo.ts';
import { execMarksOfLazy, type Blocked, type Collected, type LocalItem, type UnsentCandidate } from '../collect.ts';
import { CODEX_CONFIG_FILE, CODEX_FILE_PREFIX, CODEX_TOML_PREFIX, codexFileId, codexTomlId, kindOfCodexRel, parseCodexItemId } from '../ids.ts';
import { findSecret } from '../secrets.ts';
import { canonicalJson, type DroppedKey } from '../settingsSort.ts';
import { needsApprovalPath, profileIsClean, sortCodexToml, hasAbsolutePath } from './codexKeys.ts';
import { planCodex, planCodexOps, writeCodex } from './codexWrite.ts';
import { CODEX_STORE } from './stores.ts';
import type { ConfigTarget, TargetContext } from './types.ts';

export { planCodexFiles, writeCodex, type CodexApplyOptions } from './codexWrite.ts';

/**
 * Codex（`$CODEX_HOME`、既定 `~/.codex`）。設計書 2・3・4 章。
 *
 * - `codex:file:<相対>`：AGENTS.md、AGENTS.override.md、rules/*.rules（default.rules を除く）、skills/**（.system を除く）、<名前>.config.toml、hooks.json。
 *   Codex が書く状態（default.rules、skills/.system、installation_id、tmp/）と、Windows 固有の .sandbox*、auth.json、sessions/ は、運ぶ形の外なので集めない。
 * - `codex:toml:<鍵の道>`：config.toml の好みの鍵 1 つ。値は JSON にして運ぶ。仕分けは codexKeys.ts。
 * - `[mcp_servers.*]`（`codex:mcp:`）は別の対象の持ち分（S7）で、ここでは読まない。
 *
 * 入切は設定の configTargets と、その PC で Codex が有効か。有効でない PC では何も集めない。
 * 書き戻しは codexWrite.ts。CLI と殻の適用の口に繋ぐのは S11 で、ここは関数まで。
 */

export const CODEX_TARGET_NAME = 'codex';

const MAX_ITEMS = 5000;
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', '.trash', '.system']);
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const toPosix = (p: string): string => p.split(path.sep).join('/');
const dotted = (p: readonly string[]): string => p.join('.');

/** dir の下のファイルを、リンクを辿らず集める。リンクと読めないディレクトリは onLink へ渡す。 */
const walk = (dir: string, onLink: (abs: string) => void): string[] => walkFiles(dir, onLink, EXCLUDE_DIRS);

function marksOf(rel: string, get: () => Buffer): ConfigExecMark[] {
  if (rel === 'hooks.json') return ['hooks'];
  return execMarksOfLazy(rel, get);
}

function collectCodex(ctx: TargetContext): Collected {
  const blocked: Blocked = { ids: new Set(), prefixes: [] };
  const empty: Collected = { items: [], dropped: [], unsent: [], blocked };
  if (!ctx.codexEnabled) return empty;
  const root = ctx.codexHome;
  const maxItems = ctx.maxItems ?? MAX_ITEMS;
  const items = new Map<string, LocalItem>();
  const unsent: UnsentCandidate[] = [];
  const dropped: DroppedKey[] = [];

  const add = (id: string, kind: ConfigItemKind, label: string, target: string, content: Buffer, marks: ConfigExecMark[], mtime: number | null): void => {
    if (items.has(id)) return;
    if (items.size >= maxItems) { blocked.ids.add(id); return; }
    const hash = sha256(content);
    let withheld: 'secret' | null = null;
    if (!content.includes(0)) {
      const found = findSecret(content.toString('utf8'));
      if (found) {
        const uid = `secret:${id}`;
        const allowed = ctx.allowedUnsent.get(uid) === hash;
        unsent.push({ id: uid, kind: 'secret', itemId: id, label, reason: `secret:${found}`, contentSha256: hash, allowed });
        if (!allowed) withheld = 'secret';
      }
    }
    items.set(id, { id, kind, label, sha256: hash, size: content.length, marks, content, mtime, target, withheld });
  };
  const unknownKey = (itemId: string, label: string): void => {
    dropped.push({ key: `codex:${label}`, reason: 'unknown' });
    unsent.push({ id: `unknown-key:codex:${label}`, kind: 'unknown-key', itemId, label, reason: 'unknown-key', contentSha256: sha256(label), allowed: false });
  };

  const blockRel = (rel: string): void => { blocked.ids.add(codexFileId(rel)); blocked.prefixes.push(`${codexFileId(rel)}/`); };
  const addFile = (rel: string, abs: string): void => {
    if (!kindOfCodexRel(rel)) return;
    const f = readRegular(abs);
    if (f === 'absent') return;
    if (f === 'blocked') { blocked.ids.add(codexFileId(rel)); return; }
    if (rel.endsWith('.config.toml')) {
      // <名前>.config.toml は config.toml と同じ仕分けを通す。運べない鍵が 1 つでもあれば、ファイルごと運ばない。
      let sorted: ReturnType<typeof sortCodexToml>;
      try { sorted = sortCodexToml(f.read().toString('utf8')); } catch { blocked.ids.add(codexFileId(rel)); return; }
      if (sorted.unknown.length > 0) { blocked.ids.add(codexFileId(rel)); unknownKey(codexFileId(rel), `file:${rel}`); return; }
      if (sorted.dropped.length > 0) { blocked.ids.add(codexFileId(rel)); dropped.push({ key: `codex:file:${rel}`, reason: sorted.dropped.some((d) => d.reason === 'machine') ? 'machine' : 'path' }); return; }
    }
    const id = codexFileId(rel);
    if (items.has(id)) return;
    if (items.size >= maxItems) { blocked.ids.add(id); return; }
    items.set(id, fileItem(f, { id, kind: 'codex-file', label: rel, target: rel, marks: f.marks(rel, (get) => marksOf(rel, get)), allowedUnsent: ctx.allowedUnsent, unsent }));
  };

  // 直下のファイル。
  let top: string[] = [];
  try { top = fs.readdirSync(root); } catch { /* 入れ物が無い */ }
  for (const name of top.sort()) if (kindOfCodexRel(name)) addFile(name, path.join(root, name));
  // rules/ と skills/。入れ物の途中がリンクなら、その先は読まず、同名の項目が届いても上書きしないよう塞ぐ。
  for (const dirName of ['rules', 'skills']) {
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(root, dirName)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') blockRel(dirName); continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) { blockRel(dirName); continue; }
    const relOf = (abs: string): string => toPosix(path.relative(root, abs));
    for (const abs of walk(path.join(root, dirName), (link) => blockRel(relOf(link))).sort()) addFile(relOf(abs), abs);
  }

  // config.toml の鍵。
  const cfg = readRegular(path.join(root, CODEX_CONFIG_FILE));
  if (cfg === 'blocked') blocked.prefixes.push(CODEX_TOML_PREFIX);
  else if (cfg !== 'absent') {
    let sorted: ReturnType<typeof sortCodexToml> | null = null;
    try { sorted = sortCodexToml(cfg.read().toString('utf8')); } catch { blocked.prefixes.push(CODEX_TOML_PREFIX); }
    if (sorted) {
      for (const c of sorted.carry) {
        const id = codexTomlId(c.path);
        add(id, 'codex-config', dotted(c.path), `${CODEX_CONFIG_FILE}#${dotted(c.path)}`, Buffer.from(canonicalJson(c.value)), c.path[0] === 'hooks' ? ['hooks'] : [], cfg.mtime);
      }
      for (const d of sorted.dropped) {
        dropped.push({ key: `codex:${dotted(d.path)}`, reason: d.reason });
        // 手元にあるが運べない鍵。届いた同名の項目で上書きしないよう塞ぐ。
        if (parseCodexItemId(codexTomlId(d.path))) blocked.ids.add(codexTomlId(d.path));
      }
      for (const u of sorted.unknown) unknownKey(codexTomlId(u), dotted(u));
    }
  }

  const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  unsent.sort(byId);
  return { items: [...items.values()].sort(byId), dropped, unsent, blocked };
}

/** 承認が要る Codex のファイル：rules、skills、hooks.json、profile の設定（SPEC 4 章）。 */
function fileNeedsApproval(rel: string): boolean {
  const top = rel.split('/')[0]!;
  return rel === 'hooks.json' || top === 'rules' || top === 'skills' || rel.endsWith('.config.toml');
}

export const codexTarget: ConfigTarget = {
  name: CODEX_TARGET_NAME,
  owns: (id) => id.startsWith(CODEX_FILE_PREFIX) || id.startsWith(CODEX_TOML_PREFIX),
  parseId: (id) => parseCodexItemId(id),
  enabled: (ctx) => ctx.codexEnabled && ctx.switches?.[CODEX_TARGET_NAME] === true,
  collect: collectCodex,
  planWrite: (o) => planCodex(o),
  write: (o) => writeCodex(o),
  planOps: (o, read) => planCodexOps(o, read),
  store: CODEX_STORE,
  // 承認の仕方の設定（each か auto）に従う。権限を広げうる設定は、消去も承認に掛ける。
  needsApproval: (item, approval) => {
    if (approval !== 'each') return false;
    const parsed = parseCodexItemId(item.id);
    if (!parsed) return false;
    if (parsed.ref.type === 'codex-file') return fileNeedsApproval(parsed.ref.rel);
    return parsed.ref.type === 'codex-toml' && needsApprovalPath(parsed.ref.path);
  },
  // 絶対パスを値に持つ鍵と、運べない鍵を持つ profile は、この PC では使えない。届いても適用しない。
  isMachineBound: (item) => {
    const parsed = parseCodexItemId(item.id);
    if (!parsed) return false;
    if (parsed.ref.type === 'codex-toml') {
      try { return hasAbsolutePath(JSON.parse(item.content.toString('utf8'))); } catch { return true; }
    }
    return parsed.ref.type === 'codex-file' && parsed.ref.rel.endsWith('.config.toml') && !profileIsClean(item.content);
  },
};
