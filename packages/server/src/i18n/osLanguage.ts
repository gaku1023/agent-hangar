import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Language } from '@agent-hangar/shared';

/**
 * 言語の決め方の、Node の側の読み口。
 * サーバの設定の読み込み（config/paths.ts の loadSettings）と、Windows の CLI の入口（apps/desktop/scripts/launch-cli.ts）が使う。
 * 殻（apps/desktop/src-tauri/src/bootfail.rs）も同じ決め方を持ち、両方の試験が同じ表（language-cases.json）を読む。
 * このファイルは Node の組み込みのほかに依存を持たない（launch-cli.mjs へ 1 ファイルとして束ねるため）。
 *
 * 決め方は次の順である。
 * 1. settings.json に language（ja か en）があればそれ。
 * 2. settings.json はあるが language が無い（知らない値も含む）なら日本語。
 *    OS に合わせる前から使っている人は、これまで日本語で見ていたからである。
 * 3. settings.json が無い（初めての起動）か読めなければ、OS の表示言語。日本語なら ja、ほかと読めないときは en。
 * 初めての起動で決めた値は、最初に動いたもの（殻かサーバ）が settings.json に書く。以後は 1 で決まる。
 */

/** OS の表示言語の代わりに使う値（ja か en）。試験と、英語の OS を真似て画面を確かめるときに使う。殻も同じ名前を読む。 */
export const OS_LANGUAGE_ENV = 'HANGAR_OS_LANGUAGE';

/** 言語の名前（ja-JP、ja_JP.UTF-8 など）を ja か en に寄せる。日本語のほかは英語にする（辞書は 2 つだけである）。 */
export function languageOfTag(tag: string): Language {
  return tag.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** macOS の `defaults read -g AppleLanguages` の出力の先頭の言語。 */
export function fromAppleLanguages(out: string): Language | undefined {
  const first = out.split(/[(),"\s]+/).find((t) => t !== '');
  return first === undefined ? undefined : languageOfTag(first);
}

/** LC_ALL、LC_MESSAGES、LANG の値。C と POSIX と空では決めない。 */
export function fromLocale(v: string): Language | undefined {
  const t = v.trim();
  if (t === '' || t === 'C' || t === 'POSIX') return undefined;
  return languageOfTag(t);
}

/** 差し替えの変数の値。ja と en だけを受け取る。 */
export function fromOverride(v: string | undefined): Language | undefined {
  return v === 'ja' || v === 'en' ? v : undefined;
}

/** OS に聞く手立て。試験は run を差し替える。省けば本物のコマンドを起こす。 */
export type OsReaders = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run?: ((file: string, args: string[]) => string | undefined) | undefined;
};

const runCommand = (file: string, args: string[]): string | undefined => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};

/**
 * Windows の表示言語を読むコマンド。
 * CurrentUICulture は利用者の表示言語（GetUserDefaultUILanguage）で、地域の書式（Intl の既定の locale）とは別に決まる。
 * 英語の表示で地域だけ日本の人に、日本語の画面を出さないためである。
 */
const windowsUiLanguage = (env: NodeJS.ProcessEnv): [string, string[]] => [
  path.win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-Command', '[Globalization.CultureInfo]::CurrentUICulture.Name'],
];

/**
 * OS の表示言語。macOS は AppleLanguages の先頭、Windows は表示言語、ほかは LC_ALL、LC_MESSAGES、LANG。
 * 読めなければ undefined を返す（決めるのは decideLanguage）。
 * 差し替えの変数（HANGAR_OS_LANGUAGE）があれば OS には聞かない。
 */
export function osDisplayLanguage(sys: OsReaders = { platform: process.platform, env: process.env }): Language | undefined {
  const forced = fromOverride(sys.env[OS_LANGUAGE_ENV]);
  if (forced) return forced;
  const run = sys.run ?? runCommand;
  if (sys.platform === 'win32') {
    const [file, args] = windowsUiLanguage(sys.env);
    const name = run(file, args)?.trim();
    return name ? languageOfTag(name) : undefined;
  }
  if (sys.platform === 'darwin') {
    const out = run('/usr/bin/defaults', ['read', '-g', 'AppleLanguages']);
    return out === undefined ? undefined : fromAppleLanguages(out);
  }
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = sys.env[k];
    const l = v === undefined ? undefined : fromLocale(v);
    if (l) return l;
  }
  return undefined;
}

/** 言語をどこから決めたか。settings は設定の値、before-os は OS に合わせる前からの利用者の日本語、os は OS の表示言語。 */
export type LanguageFrom = 'settings' | 'before-os' | 'os';

/** OS に合わせる前の既定。settings.json はあるが language が無い人は、これまでこの言語で見ていた。 */
export const LANGUAGE_BEFORE_OS: Language = 'ja';
/** OS の表示言語が読めないときの言語。 */
export const LANGUAGE_UNKNOWN_OS: Language = 'en';

/**
 * settings.json の中身（無ければ undefined）から言語を決める。OS には、要るときにだけ聞く。
 * 中身がオブジェクトとして読めないときは、設定が無いときと同じく OS に合わせる（壊れたファイルには書かない）。
 */
export function decideLanguage(settingsText: string | undefined, os: () => Language | undefined): { language: Language; from: LanguageFrom } {
  if (settingsText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(settingsText);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const l = (parsed as { language?: unknown }).language;
      if (l === 'ja' || l === 'en') return { language: l, from: 'settings' };
      return { language: LANGUAGE_BEFORE_OS, from: 'before-os' };
    }
  }
  return { language: os() ?? LANGUAGE_UNKNOWN_OS, from: 'os' };
}
