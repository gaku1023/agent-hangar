import fs from 'node:fs';
import path from 'node:path';
import type { ConfigVcsTool } from '@agent-hangar/shared';

/**
 * 設定の入れ物が git や dotfiles の道具で管理されているかの検出（SPEC 8 章、D8）。
 * 表示のためだけで、同期を止めない。読むだけで何も書かず、何があっても投げない。
 * 重くならないよう、親は入れ物のホームまでしか辿らず、読む数に上限を置き、結果は短く覚える。
 */

const TTL_MS = 60_000;
const MAX_CHILDREN = 64;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 8;

const exists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };
const realOf = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };

/** home の中なら home からの相対の成分。外や home そのものなら null。 */
function relUnder(dir: string, home: string): string[] | null {
  const rel = path.relative(home, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.length > MAX_DEPTH ? null : parts;
}

/** dir から上へ、ホーム（含む）までに .git があるか。ホームの外の dir は dir だけ見る。 */
function hasGit(dir: string, home: string): boolean {
  let cur = dir;
  const inHome = relUnder(dir, home) !== null;
  for (let i = 0; i <= MAX_DEPTH + 1; i++) {
    if (exists(path.join(cur, '.git'))) return true;
    if (!inHome || cur === home) return false;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  return false;
}

/** chezmoi のソースの名前の接頭辞（private_、exact_ など）を外す。 */
const CHEZMOI_PREFIX = /^(?:(?:private|executable|readonly|exact|symlink|empty|encrypted|external|create|modify|remove|once|onchange|run|after|before)_)+/;
function chezmoiName(entry: string): string {
  return entry.replace(CHEZMOI_PREFIX, '');
}

function hasChezmoi(dir: string, home: string): boolean {
  const parts = relUnder(dir, home);
  if (!parts) return false;
  for (const root of [path.join(home, '.local', 'share', 'chezmoi'), path.join(home, '.chezmoi')]) {
    let cur = root;
    let ok = true;
    for (const part of parts) {
      const want = part.startsWith('.') ? `dot_${part.slice(1)}` : part;
      let hit: string | null = null;
      try { hit = fs.readdirSync(cur).find((e) => chezmoiName(e) === want || chezmoiName(e) === part) ?? null; } catch { hit = null; }
      if (!hit) { ok = false; break; }
      cur = path.join(cur, hit);
    }
    if (ok) return true;
  }
  return false;
}

/** yadm の索引（git の index）は経路を平文で持つので、入れ物の相対パスが載っているかを見る。 */
function hasYadm(dir: string, home: string): boolean {
  const parts = relUnder(dir, home);
  if (!parts) return false;
  const index = path.join(home, '.local', 'share', 'yadm', 'repo.git', 'index');
  try {
    if (fs.statSync(index).size > MAX_INDEX_BYTES) return false;
    return fs.readFileSync(index).includes(Buffer.from(`${parts.join('/')}/`));
  } catch { return false; }
}

/**
 * stow は印を残さないので、形で見る。
 * 入れ物（か、その中の項目）が相対のシンボリックリンクで、行き先が `<stow の置き場>/<パッケージ>/<入れ物の相対パス>` の形のとき。
 */
function hasStow(dir: string, home: string): boolean {
  const parts = relUnder(dir, home);
  if (!parts) return false;
  const suffix = path.sep + parts.join(path.sep);
  const points = (link: string, shown: string): boolean => {
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) return false;
      if (path.isAbsolute(fs.readlinkSync(link))) return false;
      const real = realOf(link);
      if (!real) return false;
      if (!real.endsWith(shown)) return false;
      // <stow の置き場>/<パッケージ> の 2 段が、入れ物の相対パスの前にあること
      return real.slice(0, real.length - shown.length).split(path.sep).filter(Boolean).length >= 2 && !real.startsWith(dir + path.sep);
    } catch { return false; }
  };
  if (points(dir, suffix)) return true;
  let names: string[];
  try { names = fs.readdirSync(dir).slice(0, MAX_CHILDREN); } catch { return false; }
  return names.some((n) => points(path.join(dir, n), suffix + path.sep + n));
}

/** 入れ物 dir を管理している道具の名前（git、chezmoi、yadm、stow の順）。印が無ければ空。 */
export function detectVcs(dir: string, home: string): ConfigVcsTool[] {
  try {
    const out: ConfigVcsTool[] = [];
    // 入れ物がシンボリックリンクなら、リンク先（dotfiles のリポジトリ）の .git も見る。
    const real = realOf(dir);
    if (hasGit(dir, home) || (real && real !== dir && hasGit(real, real.startsWith(home + path.sep) ? home : real))) out.push('git');
    if (hasChezmoi(dir, home)) out.push('chezmoi');
    if (hasYadm(dir, home)) out.push('yadm');
    if (hasStow(dir, home)) out.push('stow');
    return out;
  } catch { return []; }
}

const cache = new Map<string, { at: number; tools: ConfigVcsTool[] }>();
export function clearVcsCache(): void { cache.clear(); }

/** detectVcs を TTL（60 秒）だけ覚える。状態の表示は何度も呼ばれるため。 */
export function detectVcsCached(dir: string, home: string, now: number = Date.now()): ConfigVcsTool[] {
  const key = `${home}\0${dir}`;
  const hit = cache.get(key);
  if (hit && now - hit.at >= 0 && now - hit.at < TTL_MS) return hit.tools;
  const tools = detectVcs(dir, home);
  cache.set(key, { at: now, tools });
  return tools;
}
