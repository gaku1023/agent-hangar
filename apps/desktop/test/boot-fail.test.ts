import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// 起動の失敗の札の文（loading/boot-fail.js）。頁は UI の辞書を持たないので、この小さい日英の表が札の文を全部持つ。
// 殻は種類と数だけを渡し、文はここで作る（殻は文を書かない）。
type Info = { kind: string; params?: Record<string, string | number>; detail?: string; lang?: string; version?: string; os?: string; home?: string };
type View = {
  kind: string; lang: string; title: string; what: string; steps: string[]; command: string | null; detail: string; footer: string; copyText: string;
  labels: { whatNext: string; details: string; logAt: string; copyAll: string; copyCommand: string; copied: string; tryAgain: string; openLog: string };
};
type Mod = { FAIL_KINDS: string[]; failView(info: Info): View; shellQuote(s: string): string };
const loading = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'loading');
const m = (await import(pathToFileURL(path.join(loading, 'boot-fail.js')).href)) as Mod;

const base = { version: '0.1.0', os: 'macOS 15.1', home: '~/.agent-hangar', detail: 'boom' };
const view = (kind: string, extra: Partial<Info> = {}) => m.failView({ kind, lang: 'ja', params: {}, ...base, ...extra });
const KANA_KANJI = /[぀-ヿ㐀-鿿]/;

describe('失敗の種類', () => {
  it('殻が決める 6 種類を持つ（サーバが書く 4 種類、互換の別のサーバ、殻のそれ以外の失敗）', () => {
    expect([...m.FAIL_KINDS].sort()).toEqual(['compat-mismatch', 'db-backup-failed', 'db-too-old', 'other', 'port-in-use', 'server-exited']);
  });
  it('どの種類も、どちらの言語でも、見出し、何が起きたか、2 つ以上の次にすること、詳細を持つ', () => {
    for (const lang of ['ja', 'en']) {
      for (const kind of m.FAIL_KINDS) {
        const v = view(kind, { lang, params: { port: 4177, theirs: 1, ours: 2, found: 3, baseline: 10, file: '~/.agent-hangar/hangar.db', dir: '~/.agent-hangar/backups/db' } });
        expect(v.title, `${lang}/${kind} title`).not.toBe('');
        expect(v.what, `${lang}/${kind} what`).not.toBe('');
        expect(v.steps.length, `${lang}/${kind} steps`).toBeGreaterThanOrEqual(2);
        expect(v.steps.every((s) => s.length > 0)).toBe(true);
        expect(v.detail).toBe('boom');
      }
    }
  });
  it('日本語と英語で、次にすることの数が同じ', () => {
    for (const kind of m.FAIL_KINDS) {
      const p = { port: 4177, theirs: 1, ours: 2, found: 3, baseline: 10 };
      expect(view(kind, { lang: 'en', params: p }).steps.length, kind).toBe(view(kind, { lang: 'ja', params: p }).steps.length);
    }
  });
  it('英語の札には日本語が混ざらない（詳細は記録そのものなので除く）', () => {
    for (const kind of m.FAIL_KINDS) {
      const v = view(kind, { lang: 'en', params: { port: 4177, theirs: 1, ours: 2, found: 3, baseline: 10 } });
      const text = [v.title, v.what, ...v.steps, v.command ?? '', v.footer, ...Object.values(v.labels)].join('\n');
      expect(text, kind).not.toMatch(KANA_KANJI);
    }
  });
  it('知らない種類は other、知らない言語は日本語で出す', () => {
    expect(view('whatever').kind).toBe('other');
    expect(m.failView({ kind: 'other' }).lang).toBe('ja');
    expect(view('other', { lang: 'fr' }).lang).toBe('ja');
  });
});

describe('種類ごとの文', () => {
  it('サーバが起きない：Node の確認の命令を添え、置き場の名前を文に入れる', () => {
    const v = view('server-exited', { home: '~/h' });
    expect(v.title).toBe('サーバを起動できませんでした');
    expect(v.what).toContain('~/h');
    expect(v.command).toBe('node --version');
    expect(v.steps[0]).toContain('もう一度試す');
  });
  it('ポートが使われている：ポートを文と命令に入れ、動いているプロセスを止めないと言う', () => {
    const v = view('port-in-use', { params: { port: 4390 } });
    expect(v.title).toContain('4390');
    expect(v.what).toContain('止めません');
    expect(v.command).toBe('lsof -nP -iTCP:4390 -sTCP:LISTEN');
  });
  it('ポートが渡されなければ 4177 と読む', () => {
    expect(view('port-in-use').command).toBe('lsof -nP -iTCP:4177 -sTCP:LISTEN');
  });
  it('互換の別のサーバが古いとき：その版と自分の版を言い、そのサーバを止めてから試す', () => {
    const v = view('compat-mismatch', { params: { port: 4177, theirs: 14, ours: 16 } });
    expect(v.title).toContain('4177');
    expect(v.title).toContain('より古い版');
    expect(v.what).toContain('版 14');
    expect(v.what).toContain('版 16');
    expect(v.what).toContain('止めません');
    expect(v.steps[0]).toContain('止め');
    expect(v.command).toBe('lsof -nP -iTCP:4177 -sTCP:LISTEN');
  });
  it('互換の別のサーバが新しいとき：Hangar.app の入れ替えか、そのサーバを止める', () => {
    const v = view('compat-mismatch', { params: { port: 4177, theirs: 16, ours: 14 } });
    expect(v.title).toContain('Hangar.app が');
    expect(v.steps[0]).toContain('入れ替え');
    expect(v.steps[1]).toContain('止め');
  });
  it('互換の別のサーバは英語でも、古い側と新しい側を言い分ける', () => {
    // theirs が小さければ動いているサーバが古く、大きければこの Hangar.app が古い。
    const olderServer = view('compat-mismatch', { lang: 'en', params: { port: 4177, theirs: 1, ours: 2 } });
    const newerServer = view('compat-mismatch', { lang: 'en', params: { port: 4177, theirs: 2, ours: 1 } });
    expect(olderServer.title).toBe('The hangar server running on 4177 is older than this Hangar.app');
    expect(newerServer.title).toBe('This Hangar.app is older than the hangar server running on 4177');
    expect(olderServer.what).toContain('version 1');
    expect(olderServer.what).toContain('version 2');
  });
  it('DB が古い：ファイルと版を文に入れ、退避の命令を版つきの別の名前で出す', () => {
    const v = view('db-too-old', { params: { file: '~/.agent-hangar/hangar.db', found: 6, baseline: 10 } });
    expect(v.what).toContain('~/.agent-hangar/hangar.db');
    expect(v.what).toContain('版 6');
    expect(v.what).toContain('版 10');
    expect(v.command).toBe('mv ~/.agent-hangar/hangar.db ~/.agent-hangar/hangar-v6.db');
  });
  it('DB が古いとき、空白を含むパスは引用し、~ は引用の外に出す', () => {
    const v = view('db-too-old', { params: { file: '~/My Data/hangar.db', found: 6, baseline: 10 } });
    expect(v.command).toBe("mv ~/'My Data/hangar.db' ~/'My Data/hangar-v6.db'");
  });
  it('DB が古いとき、ファイルが渡されなければ置き場の hangar.db を指す', () => {
    const v = view('db-too-old', { home: '~/h', params: {} });
    expect(v.command).toBe('mv ~/h/hangar.db ~/h/hangar-old.db');
    expect(v.what).not.toContain('undefined');
    expect(v.what).not.toContain('NaN');
  });
  it('DB の控えが取れない：置き場を確かめる命令を出す', () => {
    const v = view('db-backup-failed', { params: { dir: '~/.agent-hangar/backups/db' } });
    expect(v.what).toContain('~/.agent-hangar/backups/db');
    expect(v.command).toBe('ls -la ~/.agent-hangar/backups/db');
  });
  it('DB の控えの置き場が渡されなければ、置き場の backups/db を指す', () => {
    expect(view('db-backup-failed', { home: '~/h' }).command).toBe('ls -la ~/h/backups/db');
  });
  it('それ以外の失敗：命令は無く、詳細を読んで報告する手順を出す', () => {
    const v = view('other');
    expect(v.command).toBeNull();
    expect(v.steps.length).toBeGreaterThanOrEqual(2);
  });
  it('Windows では lsof の命令を出さない（命令が無い）', () => {
    expect(view('port-in-use', { os: 'Windows 11' }).command).toBeNull();
    expect(view('compat-mismatch', { os: 'Windows 11', params: { theirs: 1, ours: 2 } }).command).toBeNull();
    expect(view('server-exited', { os: 'Windows 11' }).command).toBe('node --version');
  });
});

describe('札の下端と全文のコピー', () => {
  it('下端に、アプリの版と OS を出す', () => {
    expect(view('other').footer).toBe('Hangar 0.1.0 · macOS 15.1');
  });
  it('版か OS が渡されなければ、渡されたほうだけを出す', () => {
    expect(view('other', { os: '' }).footer).toBe('Hangar 0.1.0');
    expect(view('other', { version: '', os: '' }).footer).toBe('');
  });
  it('全文のコピーは、版と OS、種類、詳細の順で、報告にそのまま貼れる', () => {
    const v = view('port-in-use', { detail: 'line1\nline2', params: { port: 4177 } });
    expect(v.copyText).toBe('Hangar 0.1.0 · macOS 15.1\nport-in-use\n\nline1\nline2');
  });
  it('詳細が空でも、全文のコピーは版と種類を持つ', () => {
    expect(view('other', { detail: '' }).copyText).toBe('Hangar 0.1.0 · macOS 15.1\nother');
  });
});

describe('命令の引用（shellQuote）', () => {
  it('安全な文字だけなら、そのまま', () => {
    expect(m.shellQuote('/a/b-c_d.db')).toBe('/a/b-c_d.db');
    expect(m.shellQuote('~/.agent-hangar/x')).toBe('~/.agent-hangar/x');
  });
  it('空白や記号を含めば、単引用符で包み、中の単引用符を逃がす', () => {
    expect(m.shellQuote('/a b/c')).toBe("'/a b/c'");
    expect(m.shellQuote("/it's")).toBe("'/it'\\''s'");
    expect(m.shellQuote('/a;rm')).toBe("'/a;rm'");
  });
  it('~ で始まるものは、~ を引用の外に出す', () => {
    expect(m.shellQuote('~/a b')).toBe("~/'a b'");
  });
  it('空の文字は空の引用', () => {
    expect(m.shellQuote('')).toBe("''");
  });
});
