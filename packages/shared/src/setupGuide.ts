import type { Translate } from './i18n/t.ts';

/**
 * セットアップのすゝめ（`docs/setup-guide.md`）の写し。
 * サーバは同梱の md を起動のたびに hangar の置き場へ写し、`GET /api/setup-guide` でこの形を返す。
 * path は表示用に縮めた写しの場所（`~/.agent-hangar/setup-guide.md`、Windows は `%USERPROFILE%\.agent-hangar\setup-guide.md`）。
 * version はアプリの版、sha は写した本文（版の行を除く）の sha256 の先頭 8 桁、prompt は Claude Code に貼る一言である。
 */
export type SetupGuideDto = { path: string; version: string; sha: string; prompt: string };

/**
 * Claude Code に貼る一言。
 * サーバ（`GET /api/setup-guide` の prompt）と画面が同じ文を作る。
 * 画面は自分の言語で作り直すので、設定で言語を変えても、取り直さずに一言が替わる。
 */
export function setupGuidePrompt(t: Translate, info: Pick<SetupGuideDto, 'path' | 'version' | 'sha'>): string {
  return t('setupGuide.prompt.line', { path: info.path, version: info.version, sha: info.sha });
}

/**
 * ホームの下のパスを、表示用に縮める。
 * macOS と Linux は `~`、Windows は `%USERPROFILE%` にする（どちらも Claude Code が読める書き方である）。
 * Windows は大文字と小文字を区別しない。ホームの外のパスと、名前の頭だけが同じフォルダ（/Users/meg と /Users/me）はそのまま返す。
 */
export function displayHomePath(file: string, homeDir: string, platform: string): string {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const home = homeDir.endsWith(sep) ? homeDir.slice(0, -1) : homeDir;
  if (home === '') return file;
  const same = win ? file.toLowerCase().startsWith(home.toLowerCase()) : file.startsWith(home);
  if (!same) return file;
  const rest = file.slice(home.length);
  if (rest !== '' && !rest.startsWith(sep)) return file;
  return `${win ? '%USERPROFILE%' : '~'}${rest}`;
}
