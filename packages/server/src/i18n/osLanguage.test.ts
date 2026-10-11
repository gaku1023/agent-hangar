import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { decideLanguage, fromAppleLanguages, fromLocale, fromOverride, languageOfTag, OS_LANGUAGE_ENV, osDisplayLanguage, type OsReaders } from './osLanguage.ts';

type Lang = 'ja' | 'en';
type Cases = {
  tags: [string, Lang][];
  appleLanguages: [string, Lang | null][];
  locale: [string, Lang | null][];
  override: [string, Lang | null][];
  decide: { settings: string | null; os: Lang | null; language: Lang; from: string }[];
};
// 殻（bootfail.rs）の試験も同じ表を読む。Node と殻で答えが割れたら、どちらかの試験が落ちる。
const cases = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'language-cases.json'), 'utf8')) as Cases;

describe('言語の決め方の表（殻と同じ表）', () => {
  it('言語の名前は ja で始まれば日本語、ほかは英語', () => {
    for (const [tag, want] of cases.tags) expect(languageOfTag(tag), tag).toBe(want);
  });
  it('macOS の AppleLanguages は先頭の言語で決める', () => {
    for (const [out, want] of cases.appleLanguages) expect(fromAppleLanguages(out), JSON.stringify(out)).toBe(want ?? undefined);
  });
  it('LC_ALL などの値は、C と POSIX と空では決めない', () => {
    for (const [v, want] of cases.locale) expect(fromLocale(v), v).toBe(want ?? undefined);
  });
  it('OS の言語の差し替え（HANGAR_OS_LANGUAGE）は ja と en だけを受け取る', () => {
    for (const [v, want] of cases.override) expect(fromOverride(v), v).toBe(want ?? undefined);
    expect(fromOverride(undefined)).toBeUndefined();
  });
  it('設定の language、設定はあるが language が無い、設定が無いか読めない、の順に決める', () => {
    for (const c of cases.decide) {
      const got = decideLanguage(c.settings ?? undefined, () => c.os ?? undefined);
      expect(got, JSON.stringify(c)).toEqual({ language: c.language, from: c.from });
    }
  });
  it('設定に language があれば OS には聞かない', () => {
    const os = vi.fn(() => 'en' as const);
    expect(decideLanguage('{"language":"ja"}', os).language).toBe('ja');
    expect(decideLanguage('{"nodePath":"x"}', os).language).toBe('ja');
    expect(os).not.toHaveBeenCalled();
  });
});

describe('OS の表示言語（osDisplayLanguage）', () => {
  const sys = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, out: string | undefined): OsReaders & { calls: [string, string[]][] } => {
    const calls: [string, string[]][] = [];
    return { platform, env, calls, run: (file, args) => { calls.push([file, args]); return out; } };
  };

  it('差し替えの変数があれば、OS には聞かない', () => {
    const s = sys('darwin', { [OS_LANGUAGE_ENV]: 'en' }, '(\n "ja-JP"\n)');
    expect(osDisplayLanguage(s)).toBe('en');
    expect(s.calls).toEqual([]);
  });

  it('macOS は defaults read -g AppleLanguages の先頭', () => {
    const s = sys('darwin', { LANG: 'ja_JP.UTF-8' }, '(\n    "en-JP",\n    "ja-JP"\n)\n');
    expect(osDisplayLanguage(s)).toBe('en');
    expect(s.calls).toEqual([['/usr/bin/defaults', ['read', '-g', 'AppleLanguages']]]);
  });

  // 地域の書式（Intl の既定の locale、登録簿の LocaleName）ではなく、表示言語（UI の言語）を読む。殻の GetUserPreferredUILanguages と同じものを見る。
  it('Windows は PowerShell で表示言語（CurrentUICulture）を読み、地域の書式は見ない', () => {
    const s = sys('win32', { SystemRoot: 'C:\\Windows', LANG: 'ja_JP.UTF-8' }, 'en-US\r\n');
    expect(osDisplayLanguage(s)).toBe('en');
    expect(s.calls).toHaveLength(1);
    const [file, args] = s.calls[0]!;
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(args).toContain('-NoProfile');
    expect(args.join(' ')).toContain('CurrentUICulture');
    expect(osDisplayLanguage(sys('win32', { SystemRoot: 'C:\\Windows' }, 'ja-JP\r\n'))).toBe('ja');
  });

  it('答えが取れなければ決めない（決めるのは呼び手の decideLanguage）', () => {
    expect(osDisplayLanguage(sys('win32', {}, undefined))).toBeUndefined();
    expect(osDisplayLanguage(sys('win32', {}, '  \r\n'))).toBeUndefined();
    expect(osDisplayLanguage(sys('darwin', {}, undefined))).toBeUndefined();
  });

  it('ほかの OS は LC_ALL、LC_MESSAGES、LANG の順', () => {
    expect(osDisplayLanguage(sys('linux', { LC_ALL: '', LC_MESSAGES: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' }, undefined))).toBe('ja');
    expect(osDisplayLanguage(sys('linux', { LANG: 'C' }, undefined))).toBeUndefined();
  });

  it('この機械で実際に読める（macOS と Windows では ja か en を返す）', () => {
    const env = { ...process.env };
    delete env[OS_LANGUAGE_ENV];
    const got = osDisplayLanguage({ platform: process.platform, env, run: undefined });
    if (process.platform === 'darwin' || process.platform === 'win32') expect(['ja', 'en']).toContain(got);
  });
});
