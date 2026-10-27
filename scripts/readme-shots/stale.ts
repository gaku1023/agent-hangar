// 撮った記録（docs/images/shots.json）と、場面ごとの watch から、README の画像が古くなった場面を調べる。
// git の呼び出しは execFileSync だけで行う。撮影の道具（tmux、ffmpeg）は要らない。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './env.ts';
import type { Scene } from './kit.ts';
import { COMMON_WATCH, matcher } from './watch.ts';

export const SHOTS_JSON = path.join(REPO, 'docs/images/shots.json');

export type ShotRow = { commit: string; shotAt: string; file: string; bytes: number; dirty?: true };
export type Shots = Record<string, ShotRow>;

export const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export function readShots(): Shots {
  try { return JSON.parse(fs.readFileSync(SHOTS_JSON, 'utf8')) as Shots; } catch { return {}; }
}

export function writeShots(shots: Shots): void {
  const sorted = Object.fromEntries(Object.keys(shots).sort().map((k) => [k, shots[k]!]));
  fs.writeFileSync(SHOTS_JSON, `${JSON.stringify(sorted, null, 2)}\n`);
}

export const head = (): string => git('rev-parse', 'HEAD').trim();

/** 作業ツリーで変わっているファイル（画像と記録そのものは数えない）。untracked も含む。 */
export function dirtyFiles(): string[] {
  const parts = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    files.push(p.slice(3));
    if (p[0] === 'R' || p[0] === 'C') i++; // 改名と複製は、元の名前がもう 1 つ続く
  }
  return files.filter((f) => !f.startsWith('docs/images/'));
}

export const isDirty = (): boolean => dirtyFiles().length > 0;

export type StaleScene = { name: string; reason: string; files: string[] };

/** 古い場面を返す。 */
export function staleScenes(scenes: Pick<Scene, 'name' | 'kind' | 'watch'>[], shots: Shots): StaleScene[] {
  const common = matcher(COMMON_WATCH);
  const dirty = dirtyFiles();
  const out: StaleScene[] = [];
  const diffCache = new Map<string, string[] | null>();
  const changedSince = (commit: string): string[] | null => {
    if (!diffCache.has(commit)) {
      try { diffCache.set(commit, git('diff', '--name-only', commit).split('\n').filter(Boolean)); } catch { diffCache.set(commit, null); }
    }
    return diffCache.get(commit)!;
  };
  for (const s of scenes) {
    const row = shots[s.name];
    if (!row) { out.push({ name: s.name, reason: 'shots.json に行がない', files: [] }); continue; }
    if (!fs.existsSync(path.join(REPO, row.file))) { out.push({ name: s.name, reason: `出力が無い（${row.file}）`, files: [] }); continue; }
    const changed = changedSince(row.commit);
    if (!changed) { out.push({ name: s.name, reason: `commit ${row.commit.slice(0, 7)} が見つからない`, files: [] }); continue; }
    const own = matcher(s.watch);
    const files = [...new Set([...changed, ...dirty])].filter((f) => own(f) || common(f)).sort();
    if (files.length) out.push({ name: s.name, reason: `${row.commit.slice(0, 7)} から${row.dirty ? '（未コミットの状態で撮った行）' : ''}`, files });
  }
  return out;
}

export function printStale(stale: StaleScene[], total: number): void {
  if (!stale.length) { console.log(`古い場面はありません（${total} 場面）。`); return; }
  console.log(`古い場面 ${stale.length} / ${total}`);
  for (const s of stale) {
    console.log(`  ${s.name}  ${s.reason}`);
    for (const f of s.files.slice(0, 8)) console.log(`    ${f}`);
    if (s.files.length > 8) console.log(`    ほか ${s.files.length - 8} 件`);
  }
}

/** 撮った（または撮ったことにする）場面の行を書く。ほかの場面の行は残す。assumeClean は --record-only 用で、画像は今の HEAD の状態で撮ったものだとして dirty を付けない。 */
export function recordShot(scene: Pick<Scene, 'name' | 'kind'>, opts: { assumeClean?: boolean } = {}): void {
  const file = `docs/images/${scene.name}.${scene.kind === 'motion' ? 'webp' : 'png'}`;
  const abs = path.join(REPO, file);
  if (!fs.existsSync(abs)) throw new Error(`${file} がありません。撮ってから記録してください`);
  const shots = readShots();
  shots[scene.name] = { commit: head(), shotAt: (opts.assumeClean ? fs.statSync(abs).mtime : new Date()).toISOString(), file, bytes: fs.statSync(abs).size, ...(!opts.assumeClean && isDirty() ? { dirty: true as const } : {}) };
  writeShots(shots);
}
