import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 試験の git のリポジトリ。名前とメールは試験だけの値で、改行の変換と署名は切る（Windows の CI でも同じ差分になるように）。

const BASE = ['-c', 'user.name=hangar-test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...BASE, ...args], { cwd, encoding: 'utf8', windowsHide: true });
}

/** git が使えるか。無い機械では git の試験を飛ばす。 */
export const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
})();

/** 中身のあるリポジトリを作る。files は相対パスと中身で、全部をコミットする。 */
export function makeRepo(dir: string, files: Record<string, string> = { 'a.txt': 'one\ntwo\nthree\n' }): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/**
 * 持ち主の違うリポジトリ（git の dubious ownership）を装って fn を走らせる。
 * git の試験用の GIT_TEST_ASSUME_DIFFERENT_OWNER を立て、safe.directory が入っていない設定で読ませる（CI の機械の全体の設定に左右されないため）。
 * 空の設定のファイルは dir に置く。
 */
export async function asDifferentOwner<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const keys = ['GIT_TEST_ASSUME_DIFFERENT_OWNER', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
  const before = keys.map((k) => process.env[k]);
  const empty = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(empty, '');
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = empty;
  try { return await fn(); } finally {
    keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; });
  }
}
