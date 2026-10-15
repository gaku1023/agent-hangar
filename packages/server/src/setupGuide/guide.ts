import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayHomePath, setupGuidePrompt, translator, type Language, type SetupGuideDto } from '@agent-hangar/shared';

/**
 * セットアップのすゝめの md。
 * 正本はリポジトリの `docs/` にあり、配布物には同梱する（`apps/desktop/scripts/bundle-server.ts` が `server-dist/docs/` へ写す）。
 * サーバは起動のたびに、hangar の置き場（既定は `~/.agent-hangar`）へ写す。先頭が本編で、Claude Code に読ませるのはこれである。
 */
export const SETUP_GUIDE_FILES = ['setup-guide.md', 'setup-guide-habits.md'] as const;
/** Claude Code に読ませる本編。API の版とハッシュは、これのものである。 */
export const SETUP_GUIDE_MAIN = SETUP_GUIDE_FILES[0];

/** 本文の sha256（UTF-8 のバイト列）の先頭 8 桁。 */
export function guideSha(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 8);
}

/** 写した md の先頭に置く版とハッシュの行。md の表示には出ない HTML の注釈にする。 */
export function guideHeader(version: string, sha: string): string {
  return `<!-- hangar-setup-guide v${version} sha256:${sha} -->`;
}

/**
 * 写す中身。先頭に版の行を置き、改行 1 つの後に同梱の本文をそのまま続ける。
 * ハッシュは版の行を除いた本文（写した md の 2 行目から末尾まで）で計算する。
 * 版の行を含めて計算すると、行がハッシュ自身を含むので決まらないからである。
 */
export function stampGuide(body: string, version: string): { text: string; sha: string } {
  const sha = guideSha(body);
  return { text: `${guideHeader(version, sha)}\n${body}`, sha };
}

/**
 * 同梱の md を探す候補。
 * 配布物では束ねた server.mjs の隣の `docs/`、ソースから動かしているとき（npm run dev と試験）はリポジトリの `docs/` である。
 * どちらも、この module の場所（import.meta.url）から引く。
 */
function defaultCandidates(): string[] {
  return [
    fileURLToPath(new URL('./docs/', import.meta.url)),
    fileURLToPath(new URL('../../../../docs/', import.meta.url)),
  ].map((d) => path.resolve(d));
}

/** 同梱の md が揃っている最初のフォルダ。どの候補にも無ければ null。 */
export function bundledGuideDir(candidates: string[] = defaultCandidates()): string | null {
  return candidates.find((dir) => SETUP_GUIDE_FILES.every((name) => fs.existsSync(path.join(dir, name)))) ?? null;
}

export type GuideCopy = { file: string; sha: string; written: boolean };

/**
 * 同梱の md を置き場へ写す。中身が同じなら書かず、違えば上書きする。
 * 利用者が書き換えたものも上書きする（正本は同梱物で、Claude Code に読ませる版とハッシュを一言と合わせるため）。
 * 同梱の md を先に全部読み、1 つでも読めなければ何も書かずに投げる。
 */
export function syncSetupGuide(home: string, opts: { version: string; sourceDir: string }): GuideCopy[] {
  const stamped = SETUP_GUIDE_FILES.map((name) => ({ name, ...stampGuide(fs.readFileSync(path.join(opts.sourceDir, name), 'utf8'), opts.version) }));
  fs.mkdirSync(home, { recursive: true });
  return stamped.map(({ name, text, sha }) => {
    const file = path.join(home, name);
    let current: string | null = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
    if (current === text) return { file, sha, written: false };
    fs.writeFileSync(file, text);
    return { file, sha, written: true };
  });
}

export type ReadGuideOptions = {
  home: string; version: string; language: Language;
  /** 同梱の md の場所。省けば bundledGuideDir で探す。 */
  sourceDir?: string | null;
  /** 表示用のパスを縮めるホーム。省けば利用者のホーム。 */
  homeDir?: string;
  platform?: string;
};

/** 同梱の md が見つからない。配布物が壊れているときだけ起きる。 */
export class SetupGuideMissingError extends Error {}

/**
 * `GET /api/setup-guide` の答え。
 * 写しを確かめてから（利用者が消していても置き直す）、本編の場所、版、ハッシュ、言語に合わせた一言を返す。
 */
export function readSetupGuide(opts: ReadGuideOptions): SetupGuideDto {
  const sourceDir = opts.sourceDir === undefined ? bundledGuideDir() : opts.sourceDir;
  if (!sourceDir) throw new SetupGuideMissingError('setup guide is not bundled');
  const main = syncSetupGuide(opts.home, { version: opts.version, sourceDir })[0]!;
  const shown = displayHomePath(main.file, opts.homeDir ?? os.homedir(), opts.platform ?? process.platform);
  const info = { path: shown, version: opts.version, sha: main.sha };
  return { ...info, prompt: setupGuidePrompt(translator(opts.language), info) };
}

/** 写した本編の場所（エディタで開く先）。 */
export function setupGuideFile(home: string): string {
  return path.join(home, SETUP_GUIDE_MAIN);
}
