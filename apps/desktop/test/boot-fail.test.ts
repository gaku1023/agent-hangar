import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { updateEn } from '../../../packages/shared/src/i18n/en/update.ts';
import { updateJa } from '../../../packages/shared/src/i18n/ja/update.ts';

// 起動の失敗の札の文（loading/boot-fail.js）。頁は UI の辞書を持たないので、この小さい日英の表が札の文を全部持つ。
// 殻は種類と数だけを渡し、文はここで作る（殻は文を書かない）。
type Info = { kind: string; params?: Record<string, string | number>; detail?: string; lang?: string; version?: string; os?: string; home?: string; sep?: string };
type View = {
  kind: string; lang: string; title: string; what: string; steps: string[]; lead: string | null; command: string | null; detail: string; collapsed: boolean; footer: string; copyText: string;
  labels: { whatNext: string; details: string; detailsToggle: string; logAt: string; copyAll: string; copyCommand: string; copied: string; tryAgain: string; openLog: string };
};
type Upd =
  | { phase: 'idle' } | { phase: 'checking' } | { phase: 'latest' } | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; done: number; total: number | null } | { phase: 'installing'; version: string }
  | { phase: 'failed'; step: string; version: string | null; reason: string };
type UpdView = {
  check: { hidden: boolean; disabled: boolean; label: string };
  note: string | null;
  band: { tone: 'info' | 'error'; title: string; detail: string; action: string | null; progress: number | null; progressLabel: string } | null;
  demote: boolean;
};
type Mod = { FAIL_KINDS: string[]; failView(info: Info): View & { current: string }; updateView(lang: string, u: Upd, current: string, kind?: string): UpdView; shellQuote(s: string): string; psQuote(s: string): string };
const loading = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'loading');
const m = (await import(pathToFileURL(path.join(loading, 'boot-fail.js')).href)) as Mod;

const base = { version: '0.1.0', os: 'macOS 15.1', home: '~/.agent-hangar', detail: 'boom' };
const view = (kind: string, extra: Partial<Info> = {}) => m.failView({ kind, lang: 'ja', params: {}, ...base, ...extra });
const KANA_KANJI = /[぀-ヿ㐀-鿿]/;

describe('失敗の種類', () => {
  it('殻が決める 7 種類を持つ（サーバが書く 4 種類、互換の別のサーバ、Node が無い、殻のそれ以外の失敗）', () => {
    expect([...m.FAIL_KINDS].sort()).toEqual(['compat-mismatch', 'db-backup-failed', 'db-too-old', 'node-missing', 'other', 'port-in-use', 'server-exited']);
  });
  it('Node が無いときのほかの種類は、どちらの言語でも、見出し、何が起きたか、2 つ以上の次にすること、詳細を持つ', () => {
    for (const lang of ['ja', 'en']) {
      for (const kind of m.FAIL_KINDS.filter((k) => k !== 'node-missing')) {
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
  it('Windows では lsof の代わりに、PowerShell でポートを握っているプロセスを出す', () => {
    const ps = 'Get-Process -Id (Get-NetTCPConnection -LocalPort 4390 -State Listen).OwningProcess';
    expect(view('port-in-use', { os: 'Windows 11', params: { port: 4390 } }).command).toBe(ps);
    expect(view('compat-mismatch', { os: 'Windows 11', params: { port: 4390, theirs: 1, ours: 2 } }).command).toBe(ps);
    expect(view('compat-mismatch', { os: 'Windows 11', params: { port: 4390, theirs: 2, ours: 1 } }).command).toBe(ps);
    expect(view('server-exited', { os: 'Windows 11' }).command).toBe('node --version');
  });
  it('Windows では DB の退避を Move-Item で出し、~ は $HOME に替えて二重引用符で包む', () => {
    const v = view('db-too-old', { os: 'Windows 11', sep: '\\', params: { file: '~\\.agent-hangar\\hangar.db', found: 6 } });
    expect(v.command).toBe('Move-Item -LiteralPath "$HOME\\.agent-hangar\\hangar.db" -Destination "$HOME\\.agent-hangar\\hangar-v6.db"');
  });
  it('Windows では控えの置き場を Get-ChildItem で見る', () => {
    const v = view('db-backup-failed', { os: 'Windows 11', sep: '\\', params: { dir: 'D:\\hangar data\\backups\\db' } });
    expect(v.command).toBe("Get-ChildItem -Force -LiteralPath 'D:\\hangar data\\backups\\db'");
  });
  it('Windows でも、置き場が渡されなければ既定の置き場を $HOME から指す', () => {
    const v = view('db-backup-failed', { os: 'Windows 11', sep: '\\', home: '~\\.agent-hangar' });
    expect(v.command).toBe('Get-ChildItem -Force -LiteralPath "$HOME\\.agent-hangar\\backups\\db"');
  });
  // Hangar.app は macOS の呼び名である。Windows と Linux の札では、アプリを Hangar と呼ぶ。
  it('macOS のほかでは、札の文に .app と言わず、アプリを Hangar と呼ぶ', () => {
    const p = { port: 4177, theirs: 1, ours: 2, found: 3, baseline: 10 };
    for (const os of ['Windows 11', 'Ubuntu 24.04']) {
      for (const lang of ['ja', 'en']) {
        for (const kind of m.FAIL_KINDS) {
          for (const params of [p, { ...p, theirs: 2, ours: 1 }, { ...p, found: undefined as unknown as number }]) {
            const v = view(kind, { os, lang, params });
            expect([v.title, v.what, ...v.steps].join('\n'), `${os}/${lang}/${kind}`).not.toContain('.app');
          }
        }
      }
    }
    const ja = view('compat-mismatch', { os: 'Windows 11', params: { port: 4177, theirs: 16, ours: 14 } });
    expect(ja.title).toBe('この Hangar が、4177 で動いている hangar のサーバより古い版です');
    expect(ja.what).toBe('動いているサーバは版 16、この Hangar は版 14 です。そのサーバは、この Hangar より新しい hangar が起こしたものです。hangar はそのサーバを止めません。');
    expect(ja.steps).toEqual(['Hangar の新しい版をインストールします', 'インストールせずに使うときは、そのサーバを止めてから「もう一度試す」を押します']);
    const en = view('compat-mismatch', { os: 'Windows 11', lang: 'en', params: { port: 4177, theirs: 16, ours: 14 } });
    expect(en.title).toBe('This Hangar is older than the hangar server running on 4177');
    expect(en.steps[0]).toBe('Install a newer version of Hangar');
    expect(view('compat-mismatch', { os: 'Windows 11', params: { port: 4177, theirs: 14, ours: 16 } }).steps[1]).toBe('「もう一度試す」を押します。この Hangar が同梱のサーバを起こします');
    expect(view('db-too-old', { os: 'Windows 11', lang: 'en', params: { found: 6, baseline: 10 } }).what).toContain('this Hangar can update version 10 or later');
  });
  it('macOS の札の文は、Hangar.app と呼ぶまま変えない', () => {
    const v = view('compat-mismatch', { params: { port: 4177, theirs: 16, ours: 14 } });
    expect(v.title).toBe('この Hangar.app が、4177 で動いている hangar のサーバより古い版です');
    expect(v.steps).toEqual(['Hangar.app を新しい版に入れ替えます', '入れ替えずに使うときは、そのサーバを止めてから「もう一度試す」を押します']);
    expect(view('compat-mismatch', { lang: 'en', params: { port: 4177, theirs: 16, ours: 14 } }).steps[0]).toBe('Replace Hangar.app with a newer version');
    expect(view('db-too-old', { params: { found: 6, baseline: 10 } }).what).toContain('この Hangar.app が更新できるのは版 10 以降です');
  });
  it('Windows の命令には、POSIX の命令（mv、ls、lsof）を出さない', () => {
    const p = { port: 4177, theirs: 1, ours: 2, found: 3, baseline: 10 };
    for (const kind of m.FAIL_KINDS) {
      const c = view(kind, { os: 'Windows 11', sep: '\\', home: '~\\.agent-hangar', params: p }).command ?? '';
      expect(c, kind).not.toMatch(/^(mv|ls|lsof) /);
    }
  });
});

// Node が見つからないときの専用の札（利用者が選んだ形、2026-10-11）。
// 見出しと本文はその場合（入っていない、版が違う、アーキテクチャが違う）に合わせ、入れるコマンドを 1 つだけ大きく出す。
// 主の釦は「入れたのでもう一度試す」で、調べた場所と別の入れ方は畳んだ詳細に置く。
describe('Node が無いときの札', () => {
  const node = (params: Record<string, string | number>, extra: Partial<Info> = {}) => view('node-missing', { params: { major: 22, arch: 'arm64', ...params }, detail: 'Node 22（arm64）が見つかりません。\n調べた場所:', ...extra });
  it('入っていない：見出しは「Node.js 22 が入っていません」で、macOS では brew で Node と tmux を入れるコマンドを出す', () => {
    const v = node({ reason: 'missing' });
    expect(v.title).toBe('Node.js 22 が入っていません');
    expect(v.what).toBe('Hangar の動作には Node.js 22 が要ります。');
    expect(v.lead).toBe('ターミナルで次を実行してください：');
    expect(v.command).toBe('brew install node@22 tmux');
    expect(v.steps).toEqual([]);
    expect(v.labels.tryAgain).toBe('入れたのでもう一度試す');
    expect(v.labels.detailsToggle).toBe('詳細（調べた場所、別の入れ方）');
    expect(v.collapsed).toBe(true);
    expect(v.detail).toContain('調べた場所');
  });
  it('Windows では PowerShell で winget の Node だけを入れるコマンドを出す（psmux は別の案内がある）', () => {
    const v = node({ reason: 'missing' }, { os: 'Windows 11 24H2 (build 26100)', sep: '\\', home: '~\\.agent-hangar' });
    expect(v.lead).toBe('PowerShell で次を実行してください：');
    expect(v.command).toBe('winget install -e --id OpenJS.NodeJS.22');
    expect(v.title).toBe('Node.js 22 が入っていません');
  });
  it('macOS と Windows のほか（Linux）では nvm で入れるコマンドを出す', () => {
    expect(node({ reason: 'missing' }, { os: 'Ubuntu 24.04 LTS' }).command).toBe('nvm install 22');
  });
  it('版が違う：見つかった版を言い、要る版を入れるよう言う', () => {
    const v = node({ reason: 'version', found: 24 });
    expect(v.title).toBe('Node.js 22 が見つかりません');
    expect(v.what).toBe('見つかった Node.js は 24 です。Hangar の動作には Node.js 22 が要ります。');
    expect(v.command).toBe('brew install node@22 tmux');
  });
  it('アーキテクチャが違う：見つかった Node のアーキテクチャと、要るアーキテクチャを言う', () => {
    const v = node({ reason: 'arch', foundArch: 'x64' });
    expect(v.title).toBe('arm64 用の Node.js 22 が見つかりません');
    expect(v.what).toBe('見つかった Node.js 22 は x64 用です。この Mac で Hangar を動かすには arm64 用の Node.js 22 が要ります。');
    const w = node({ reason: 'arch', foundArch: 'ia32', arch: 'x64' }, { os: 'Windows 11' });
    expect(w.what).toBe('見つかった Node.js 22 は ia32 用です。この PC で Hangar を動かすには x64 用の Node.js 22 が要ります。');
  });
  it('版の数は殻が渡したものを使う', () => {
    const v = node({ reason: 'missing', major: 24 });
    expect(v.title).toBe('Node.js 24 が入っていません');
    expect(v.command).toBe('brew install node@24 tmux');
    expect(node({ reason: 'missing', major: 24 }, { os: 'Windows 11' }).command).toBe('winget install -e --id OpenJS.NodeJS.24');
  });
  it('理由が渡されないか知らない値なら、入っていない札にする。版が渡されなければ 22 と読む', () => {
    expect(view('node-missing').title).toBe('Node.js 22 が入っていません');
    expect(node({ reason: 'weird' }).title).toBe('Node.js 22 が入っていません');
    // 版が違うのに見つかった版が無ければ、入っていない札に落とす（? を出さない）。
    expect(node({ reason: 'version' }).what).not.toContain('?');
  });
  it('英語の札', () => {
    const en = (params: Record<string, string | number>, os = 'macOS 15.1') => node(params, { lang: 'en', os });
    const v = en({ reason: 'missing' });
    expect(v.title).toBe('Node.js 22 is not installed');
    expect(v.what).toBe('Hangar needs Node.js 22 to run.');
    expect(v.lead).toBe('Run this in Terminal:');
    expect(v.labels.tryAgain).toBe('I installed it, try again');
    expect(v.labels.detailsToggle).toBe('Details (places checked, other ways to install)');
    expect(en({ reason: 'missing' }, 'Windows 11').lead).toBe('Run this in PowerShell:');
    expect(en({ reason: 'version', found: 24 }).title).toBe('Node.js 22 was not found');
    expect(en({ reason: 'version', found: 24 }).what).toBe('The Node.js found is version 24. Hangar needs Node.js 22 to run.');
    expect(en({ reason: 'arch', foundArch: 'x64' }).title).toBe('Node.js 22 for arm64 was not found');
    expect(en({ reason: 'arch', foundArch: 'x64' }).what).toBe('The Node.js 22 found is for x64. Hangar on this Mac needs Node.js 22 for arm64.');
    for (const p of [{ reason: 'missing' }, { reason: 'version', found: 24 }, { reason: 'arch', foundArch: 'x64' }] as Record<string, string | number>[]) {
      for (const os of ['macOS 15.1', 'Windows 11']) {
        const e = en(p, os);
        expect([e.title, e.what, e.lead ?? '', e.command ?? '', ...Object.values(e.labels)].join('\n'), `${os} ${p.reason}`).not.toMatch(KANA_KANJI);
      }
    }
  });
  it('ほかの種類は、前置きの文を持たず、詳細を開いたまま、主の釦は「もう一度試す」のまま', () => {
    for (const kind of m.FAIL_KINDS.filter((k) => k !== 'node-missing')) {
      const v = view(kind);
      expect(v.lead, kind).toBeNull();
      expect(v.collapsed, kind).toBe(false);
      expect(v.labels.tryAgain, kind).toBe('もう一度試す');
    }
  });
  it('全文のコピーは、ほかの種類と同じく版と OS、種類、詳細の順', () => {
    expect(node({ reason: 'missing' }).copyText).toBe('Hangar 0.1.0 · macOS 15.1\nnode-missing\n\nNode 22（arm64）が見つかりません。\n調べた場所:');
  });
});

describe('パスの区切り', () => {
  // Windows では置き場が ~\.agent-hangar で届く。記録の場所が `\.agent-hangar/desktop.log` のように区切りを混ぜて出ていた。
  const win = { os: 'Windows 11', home: '~\\.agent-hangar', sep: '\\' };
  it('記録の場所は、殻が渡した区切りで置き場とつなぐ', () => {
    expect(view('other', win).labels.logAt).toBe('記録はこの PC の ~\\.agent-hangar\\desktop.log にあります');
    expect(view('other', { ...win, lang: 'en' }).labels.logAt).toBe('The log is at ~\\.agent-hangar\\desktop.log on this computer');
  });
  it('区切りが渡されなければ / でつなぐ（macOS と、前の版の殻）', () => {
    expect(view('other').labels.logAt).toBe('記録はこの PC の ~/.agent-hangar/desktop.log にあります');
    expect(view('other', { sep: 'x' }).labels.logAt).toBe('記録はこの PC の ~/.agent-hangar/desktop.log にあります');
  });
  it('DB のファイルと控えの置き場の既定も、同じ区切りでつなぐ', () => {
    const old = view('db-too-old', { ...win, params: { found: 6, baseline: 10 } });
    expect(old.what).toContain('~\\.agent-hangar\\hangar.db');
    expect(old.command).toContain('$HOME\\.agent-hangar\\hangar-v6.db');
    expect(old.command).not.toContain('/');
    const backup = view('db-backup-failed', win);
    expect(backup.what).toContain('~\\.agent-hangar\\backups\\db');
    expect(backup.steps.join('\n')).toContain('backups\\db');
    expect(backup.steps.join('\n')).not.toContain('backups/db');
  });
  it('サーバが渡した Windows のパスでも、隣の名前は同じ置き場に作る', () => {
    const v = view('db-too-old', { ...win, params: { file: 'D:\\data\\hangar.db', found: 6 } });
    expect(v.command).toContain('D:\\data\\hangar-v6.db');
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

describe('PowerShell の引用（psQuote）', () => {
  it('安全な文字だけなら、そのまま', () => {
    expect(m.psQuote('C:\\data\\hangar.db')).toBe('C:\\data\\hangar.db');
  });
  it('空白や記号を含めば単引用符で包み、中の単引用符は 2 つにする', () => {
    expect(m.psQuote('C:\\My Data\\x')).toBe("'C:\\My Data\\x'");
    expect(m.psQuote("C:\\it's")).toBe("'C:\\it''s'");
    expect(m.psQuote('C:\\a$b')).toBe("'C:\\a$b'");
  });
  it('~ で始まるものは $HOME に替えて二重引用符で包み、残りの $ と ` と " を ` で逃がす', () => {
    expect(m.psQuote('~\\.agent-hangar')).toBe('"$HOME\\.agent-hangar"');
    expect(m.psQuote('~/a b')).toBe('"$HOME/a b"');
    expect(m.psQuote('~\\$x`y"z')).toBe('"$HOME\\`$x``y`"z"');
    expect(m.psQuote('~')).toBe('"$HOME"');
  });
  it('空の文字は空の引用', () => {
    expect(m.psQuote('')).toBe("''");
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

// 札の中の更新（起動に失敗する版を入れた人が、UI まで届かなくても新しいバージョンを受け取る口）。
// 語は UI の辞書（packages/shared の update.*）と同じものを使う。
describe('札の中の更新', () => {
  const cur = '0.2.0-rc.5';
  const ja = (u: Upd) => m.updateView('ja', u, cur);
  const en = (u: Upd) => m.updateView('en', u, cur);
  const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '');
  it('まだ確かめていなければ、下端に「更新を確認」だけを出す', () => {
    expect(ja({ phase: 'idle' })).toEqual({ check: { hidden: false, disabled: false, label: '更新を確認' }, note: null, band: null, demote: false });
    expect(en({ phase: 'idle' }).check.label).toBe('Check for updates');
  });
  it('確かめている間は、押せない「確認中…」にする', () => {
    expect(ja({ phase: 'checking' }).check).toEqual({ hidden: false, disabled: true, label: '確認中…' });
    expect(en({ phase: 'checking' }).check.label).toBe('Checking…');
  });
  it('新しいバージョンが無ければ、確認の釦を退けて「最新」と添える', () => {
    const v = ja({ phase: 'latest' });
    expect(v.check.hidden).toBe(true);
    expect(v.note).toBe('最新');
    expect(v.band).toBeNull();
    expect(en({ phase: 'latest' }).note).toBe('Up to date');
  });
  it('新しいバージョンがあれば、札の中に帯を出し、ダウンロードしてインストールを主の釦にする', () => {
    const v = ja({ phase: 'available', version: '0.2.1' });
    expect(v.check.hidden).toBe(true);
    expect(v.demote).toBe(true);
    expect(v.band).toMatchObject({ tone: 'info', title: 'Hangar 0.2.1 を利用できます', action: 'ダウンロードしてインストール', progress: null });
    expect(v.band!.detail).toContain('現在は 0.2.0-rc.5 です。');
    expect(en({ phase: 'available', version: '0.2.1' }).band).toMatchObject({ title: 'Hangar 0.2.1 is available', action: 'Download and install' });
  });
  // Node が無いときは、新しいバージョンを入れても Node は入らない。直ると言わず、今の版だけを言う。
  it('Node が無いときの札では、新しいバージョンで直るとは言わない', () => {
    expect(m.updateView('ja', { phase: 'available', version: '0.2.1' }, cur, 'node-missing').band!.detail).toBe('現在は 0.2.0-rc.5 です。');
    expect(m.updateView('en', { phase: 'available', version: '0.2.1' }, cur, 'node-missing').band!.detail).toBe('You have 0.2.0-rc.5.');
    expect(m.updateView('ja', { phase: 'available', version: '0.2.1' }, cur, 'server-exited').band!.detail).toContain('直っていることがあります');
  });
  it('ダウンロード中は進みを出し、大きさが分からなければ文だけにする', () => {
    const v = ja({ phase: 'downloading', version: '0.2.1', done: 25, total: 100 });
    expect(v.band).toMatchObject({ tone: 'info', title: 'Hangar 0.2.1', detail: '25%', action: null, progress: 0.25, progressLabel: 'ダウンロードの進み具合' });
    expect(v.demote).toBe(true);
    expect(ja({ phase: 'downloading', version: '0.2.1', done: 25, total: null }).band).toMatchObject({ detail: 'ダウンロードしています…', progress: null });
  });
  it('インストール中は、終わると再起動することを言う', () => {
    const v = ja({ phase: 'installing', version: '0.2.1' });
    expect(v.band).toMatchObject({ title: 'Hangar 0.2.1', action: null });
    expect(v.band!.detail).toContain('インストールしています…');
    expect(v.band!.detail).toContain('再起動');
  });
  it('確認に失敗したら、理由を帯に出し、もう一度確かめられるよう確認の釦を戻す', () => {
    const v = ja({ phase: 'failed', step: 'check', version: null, reason: 'network' });
    expect(v.check).toEqual({ hidden: false, disabled: false, label: '更新を確認' });
    expect(v.demote).toBe(false);
    expect(v.band).toMatchObject({ tone: 'error', title: '更新を確認できませんでした', detail: 'ネットワークか配布元に接続できませんでした。', action: null });
  });
  it('ダウンロードかインストールに失敗したら、いまのバージョンは変わらないことと理由を出し、やり直せるようにする', () => {
    const d = ja({ phase: 'failed', step: 'download', version: '0.2.1', reason: 'signature' });
    expect(d.band).toMatchObject({ tone: 'error', title: 'ダウンロードできませんでした', detail: 'いまのバージョン 0.2.0-rc.5 は変わりません。署名を確認できませんでした。', action: 'ダウンロードしてインストール' });
    expect(d.check.hidden).toBe(true);
    expect(d.demote).toBe(true);
    const i = ja({ phase: 'failed', step: 'install', version: '0.2.1', reason: 'permission' });
    expect(i.band).toMatchObject({ title: 'インストールできませんでした', detail: 'いまのバージョン 0.2.0-rc.5 は変わりません。インストールの許可が得られませんでした。' });
    // 知らない理由は other と読む。
    expect(ja({ phase: 'failed', step: 'install', version: '0.2.1', reason: 'what' }).band!.detail).toContain('詳しくはログを確認してください。');
  });
  it('語は UI の辞書（update.*）と同じ', () => {
    for (const [lang, d] of [['ja', updateJa], ['en', updateEn]] as const) {
      const u = (x: Upd) => m.updateView(lang, x, cur);
      expect(u({ phase: 'idle' }).check.label).toBe(d['update.settings.check']);
      expect(u({ phase: 'checking' }).check.label).toBe(d['update.settings.checking']);
      expect(u({ phase: 'latest' }).note).toBe(d['update.settings.badgeLatest']);
      const a = u({ phase: 'available', version: '9.9.9' }).band!;
      expect(a.title).toBe(fill(d['update.card.availableTitle'], { version: '9.9.9' }));
      expect(a.detail.startsWith(fill(d['update.card.availableDetail'], { current: cur }))).toBe(true);
      expect(a.action).toBe(d['update.card.download']);
      expect(u({ phase: 'downloading', version: '9.9.9', done: 1, total: null }).band!.detail).toBe(d['update.card.downloadingUnknown']);
      expect(u({ phase: 'downloading', version: '9.9.9', done: 1, total: 4 }).band!.detail).toBe(fill(d['update.card.percent'], { n: '25' }));
      expect(u({ phase: 'installing', version: '9.9.9' }).band!.detail.startsWith(d['update.card.installingDetail'])).toBe(true);
      expect(u({ phase: 'failed', step: 'download', version: '9.9.9', reason: 'network' }).band!.title).toBe(d['update.card.failedDownload']);
      expect(u({ phase: 'failed', step: 'install', version: '9.9.9', reason: 'other' }).band!.detail).toBe(fill(d['update.card.failedDetail'], { current: cur, reason: d['update.reason.other'] }));
    }
  });
  it('英語の帯と釦には日本語が混ざらない', () => {
    const all: Upd[] = [{ phase: 'idle' }, { phase: 'checking' }, { phase: 'latest' }, { phase: 'available', version: '1' }, { phase: 'downloading', version: '1', done: 1, total: 2 }, { phase: 'installing', version: '1' }, { phase: 'failed', step: 'check', version: null, reason: 'network' }, { phase: 'failed', step: 'download', version: '1', reason: 'signature' }];
    for (const u of all) {
      const v = en(u);
      const text = [v.check.label, v.note ?? '', v.band?.title ?? '', v.band?.detail ?? '', v.band?.action ?? '', v.band?.progressLabel ?? ''].join('\n');
      expect(text, u.phase).not.toMatch(KANA_KANJI);
    }
  });
  it('知らない言語は日本語で出す', () => {
    expect(m.updateView('fr', { phase: 'idle' }, cur).check.label).toBe('更新を確認');
  });
  it('札の材料は、殻が渡した動いている版をそのまま持つ（帯の文に使う）', () => {
    expect(view('other', { version: '0.2.0-rc.5' }).current).toBe('0.2.0-rc.5');
    expect(view('other', { version: undefined }).current).toBe('');
  });
});
