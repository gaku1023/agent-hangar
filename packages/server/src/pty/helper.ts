import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * node-pty の prebuild は spawn-helper に実行権限が無い状態で展開されることがある（フェーズ 0 で確認）。
 * そのままでは posix_spawnp failed で落ちるので、起動時に権限を確認して直す。
 */
export function fixSpawnHelpers(packageDir: string): string[] {
  const candidates: string[] = [];
  const prebuilds = path.join(packageDir, 'prebuilds');
  if (fs.existsSync(prebuilds)) for (const d of fs.readdirSync(prebuilds)) candidates.push(path.join(prebuilds, d, 'spawn-helper'));
  candidates.push(path.join(packageDir, 'build', 'Release', 'spawn-helper'));
  const fixed: string[] = [];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const mode = fs.statSync(f).mode & 0o777;
    if ((mode & 0o111) !== 0o111) { fs.chmodSync(f, 0o755); fixed.push(f); }
  }
  return fixed;
}

/** node-pty のパッケージディレクトリを解決して spawn-helper を直す。解決できなければ何もしない。 */
export function ensureSpawnHelper(): string[] {
  try {
    const pkg = createRequire(import.meta.url).resolve('node-pty/package.json');
    return fixSpawnHelpers(path.dirname(pkg));
  } catch { return []; }
}
