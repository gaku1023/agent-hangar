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
  pick: { label: string; primary: boolean } | null;
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
type Pick = { result: string; path?: string; found?: string; foundArch?: string; min?: string; arch?: string; error?: string } | null;
type Mod = {
  FAIL_KINDS: string[]; NODE_KINDS: string[]; DEFAULT_NODE_MIN: string; DEFAULT_NODE_API: number;
  failView(info: Info): View & { current: string }; updateView(lang: string, u: Upd, current: string, kind?: string): UpdView; pickText(lang: string, r: Pick): string | null;
  shellQuote(s: string): string; psQuote(s: string): string;
};
const loading = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'loading');
const m = (await import(pathToFileURL(path.join(loading, 'boot-fail.js')).href)) as Mod;

const base = { version: '0.1.0', os: 'macOS 15.1', home: '~/.agent-hangar', detail: 'boom' };
const view = (kind: string, extra: Partial<Info> = {}) => m.failView({ kind, lang: 'ja', params: {}, ...base, ...extra });
const KANA_KANJI = /[぀-ヿ㐀-鿿]/;

describe('失敗の種類', () => {
  it('殻が決める 9 種類を持つ（サーバが書く 4 種類、互換の別のサーバ、Node の 3 つ、殻のそれ以外の失敗）', () => {
    expect([...m.FAIL_KINDS].sort()).toEqual(['compat-mismatch', 'db-backup-failed', 'db-too-old', 'node-arch-mismatch', 'node-missing', 'node-version-mismatch', 'other', 'port-in-use', 'server-exited']);
    expect(m.NODE_KINDS).toEqual(['node-missing', 'node-version-mismatch', 'node-arch-mismatch']);
  });
  it('Node の札のほかの種類は、どちらの言語でも、見出し、何が起きたか、2 つ以上の次にすること、詳細を持つ', () => {
    for (const lang of ['ja', 'en']) {
      for (const kind of m.FAIL_KINDS.filter((k) => !m.NODE_KINDS.includes(k))) {
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
      for (const os of ['macOS 15.1', 'Windows 11']) {
        const p = { port: 4177, theirs: 1, ours: 2, found: kind.startsWith('node-') ? '20.18.0' : 3, foundArch: 'x64', baseline: 10, min: '22.14', napi: 10, arch: 'arm64' };
        expect(view(kind, { lang: 'en', params: p, os }).steps.length, `${kind} ${os}`).toBe(view(kind, { lang: 'ja', params: p, os }).steps.length);
      }
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
    expect(v.title).toBe('サーバーを起動できませんでした');
    expect(v.what).toContain('~/h');
    expect(v.command).toBe('node --version');
    expect(v.steps[0]).toContain('もう一度試す');
  });
  // 殻と CLI は Node-API が要る版以上の Node を採る（上限は無い）。確かめる版は「以上」で書く。
  it('サーバが起きない：確かめる Node は、要る版以上', () => {
    expect(m.DEFAULT_NODE_MIN).toBe('22.14');
    expect(m.DEFAULT_NODE_API).toBe(10);
    expect(view('server-exited').steps).toContain('Node 22.14 以上がインストールされているか確認します');
    expect(view('server-exited', { lang: 'en' }).steps).toContain('Check that Node 22.14 or later is installed');
    // 殻が要る版を渡せば、それを書く。
    expect(view('server-exited', { params: { min: '24.1' } }).steps).toContain('Node 24.1 以上がインストールされているか確認します');
  });
  it('ポートが使われている：ポートを文と命令に入れ、動いているプロセスを止めないと言う', () => {
    const v = view('port-in-use', { params: { port: 4390 } });
    expect(v.title).toContain('4390');
    expect(v.what).toContain('自動では停止しません');
    expect(v.command).toBe('lsof -nP -iTCP:4390 -sTCP:LISTEN');
  });
  it('ポートが渡されなければ 4177 と読む', () => {
    expect(view('port-in-use').command).toBe('lsof -nP -iTCP:4177 -sTCP:LISTEN');
  });
  it('互換の別のサーバが古いとき：その版と自分の版を言い、そのサーバを止めてから試す', () => {
    const v = view('compat-mismatch', { params: { port: 4177, theirs: 14, ours: 16 } });
    expect(v.title).toContain('4177');
    expect(v.title).toContain('より古いバージョン');
    expect(v.what).toContain('バージョン 14');
    expect(v.what).toContain('バージョン 16');
    expect(v.what).toContain('自動では停止しません');
    expect(v.steps[0]).toContain('停止');
    expect(v.command).toBe('lsof -nP -iTCP:4177 -sTCP:LISTEN');
  });
  it('互換の別のサーバが新しいとき：Hangar.app の入れ替えか、そのサーバを止める', () => {
    const v = view('compat-mismatch', { params: { port: 4177, theirs: 16, ours: 14 } });
    expect(v.title).toContain('この Hangar.app は');
    expect(v.steps[0]).toContain('置き換え');
    expect(v.steps[1]).toContain('停止');
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
    expect(v.what).toContain('バージョン 6');
    expect(v.what).toContain('バージョン 10');
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
    expect(ja.title).toBe('この Hangar は、ポート 4177 で動作中の hangar のサーバーより古いバージョンです');
    expect(ja.what).toBe('動作中のサーバーはバージョン 16、この Hangar はバージョン 14 です。そのサーバーは、この Hangar より新しいバージョンの hangar が起動したものです。そのサーバーは自動では停止しません。');
    expect(ja.steps).toEqual(['Hangar の新しいバージョンをインストールします', 'インストールせずに使う場合は、そのサーバーを停止してから「もう一度試す」をクリックします']);
    const en = view('compat-mismatch', { os: 'Windows 11', lang: 'en', params: { port: 4177, theirs: 16, ours: 14 } });
    expect(en.title).toBe('This Hangar is older than the hangar server running on 4177');
    expect(en.steps[0]).toBe('Install a newer version of Hangar');
    expect(view('compat-mismatch', { os: 'Windows 11', params: { port: 4177, theirs: 14, ours: 16 } }).steps[1]).toBe('「もう一度試す」をクリックします。この Hangar が同梱のサーバーを起動します');
    expect(view('db-too-old', { os: 'Windows 11', lang: 'en', params: { found: 6, baseline: 10 } }).what).toContain('this Hangar can update version 10 or later');
  });
  it('macOS の札の文は、Hangar.app と呼ぶまま変えない', () => {
    const v = view('compat-mismatch', { params: { port: 4177, theirs: 16, ours: 14 } });
    expect(v.title).toBe('この Hangar.app は、ポート 4177 で動作中の hangar のサーバーより古いバージョンです');
    expect(v.steps).toEqual(['Hangar.app を新しいバージョンに置き換えます', '置き換えずに使う場合は、そのサーバーを停止してから「もう一度試す」をクリックします']);
    expect(view('compat-mismatch', { lang: 'en', params: { port: 4177, theirs: 16, ours: 14 } }).steps[0]).toBe('Replace Hangar.app with a newer version');
    expect(view('db-too-old', { params: { found: 6, baseline: 10 } }).what).toContain('この Hangar.app が更新できるのはバージョン 10 以降です');
  });
  it('Windows の命令には、POSIX の命令（mv、ls、lsof）を出さない', () => {
    const p = { port: 4177, theirs: 1, ours: 2, found: 3, baseline: 10 };
    for (const kind of m.FAIL_KINDS) {
      const c = view(kind, { os: 'Windows 11', sep: '\\', home: '~\\.agent-hangar', params: p }).command ?? '';
      expect(c, kind).not.toMatch(/^(mv|ls|lsof) /);
    }
  });
});

// Node の札（利用者が選んだ形、2026-10-11。版の規則を Node-API に変えて 3 つに分けた、2026-10-13）。
// 見つからない（node-missing）、版が古い（node-version-mismatch）、アーキテクチャが違う（node-arch-mismatch）で、見出しを分ける。
// 何も無いときは一般の入れ方のコマンドを 1 つ出し、古い Node があるときは今の Node を置き換えない入れ方を先に出す。
// どの札にも「node を選ぶ…」（Windows は「node.exe を選ぶ…」）を出す。調べた場所と別の入れ方は畳んだ詳細に置く。
describe('Node の札', () => {
  const need = { min: '22.14', napi: 10, arch: 'arm64' };
  const node = (kind: string, params: Record<string, string | number> = {}, extra: Partial<Info> = {}) =>
    view(kind, { params: { ...need, ...params }, detail: 'Node 22.14 以上（arm64）が見つかりません。\n確認したパス:', ...extra });
  const win = { os: 'Windows 11 24H2 (build 26100)', sep: '\\', home: '~\\.agent-hangar' };
  const reason = 'Hangar のデータベースとターミナルのネイティブモジュールは Node-API 10 を使うため、Node.js 22.14 以上が必要です。';

  describe('見つからない', () => {
    it('見出しは「見つかりません」で、理由を 1 文で言い、macOS では brew で Node と tmux を入れるコマンドを出す', () => {
      const v = node('node-missing');
      expect(v.title).toBe('Node.js が見つかりません');
      expect(v.what).toBe(reason);
      expect(v.lead).toBe('ターミナルで次を実行してください：');
      expect(v.command).toBe('brew install node tmux');
      expect(v.steps).toEqual([]);
      expect(v.labels.tryAgain).toBe('インストール後にもう一度試す');
      expect(v.labels.detailsToggle).toBe('詳細（確認したパス、別のインストール方法）');
      expect(v.collapsed).toBe(true);
      expect(v.detail).toContain('確認したパス');
      expect(v.pick).toEqual({ label: 'node を選択…', primary: false });
    });
    it('Windows では PowerShell で winget の LTS を入れるコマンドを出し、選ぶ釦は node.exe と言う', () => {
      const v = node('node-missing', {}, win);
      expect(v.lead).toBe('PowerShell で次を実行してください：');
      expect(v.command).toBe('winget install -e --id OpenJS.NodeJS.LTS');
      expect(v.title).toBe('Node.js が見つかりません');
      expect(v.pick).toEqual({ label: 'node.exe を選択…', primary: false });
    });
    it('macOS と Windows のほか（Linux）では nvm で LTS を入れるコマンドを出す', () => {
      expect(node('node-missing', {}, { os: 'Ubuntu 24.04 LTS' }).command).toBe('nvm install --lts');
    });
  });

  describe('版が古い', () => {
    it('見つかった版と、要る版以上が要ることを見出しで言い、今の Node を置き換えずに入れられると言う', () => {
      const v = node('node-version-mismatch', { found: '20.18.0' });
      expect(v.title).toBe('Node.js 20.18.0 を検出しましたが、Hangar には Node.js 22.14 以上が必要です');
      expect(v.what).toBe('Hangar のデータベースとターミナルのネイティブモジュールが Node-API 10 を使うためです。現在の Node.js を置き換えずに、別のディレクトリにインストールできます。');
      expect(v.collapsed).toBe(true);
    });
    it('macOS では、既定の node を置き換えない node@22 を brew で入れるコマンドを出す', () => {
      const v = node('node-version-mismatch', { found: '20.18.0' });
      expect(v.lead).toBe('現在の Node.js を置き換えずにインストールするには、ターミナルで次を実行してください：');
      expect(v.command).toBe('brew install node@22');
      expect(v.steps).toEqual([]);
      expect(v.labels.tryAgain).toBe('インストール後にもう一度試す');
      expect(v.pick).toEqual({ label: 'node を選択…', primary: false });
    });
    // winget の Node は C:\Program Files\nodejs に入り、今ある Node を置き換える。公式の zip を別のフォルダに展開して選ぶ道を先に出す。
    it('Windows では、winget を出さず、公式の zip を別のフォルダに展開して node.exe を選ぶ手順を出し、選ぶ釦を主にする', () => {
      const v = node('node-version-mismatch', { found: '20.18.0', arch: 'x64' }, win);
      expect(v.lead).toBe('現在の Node.js を置き換えずにインストールするには：');
      expect(v.command).toBeNull();
      expect(v.steps).toEqual([
        'nodejs.org から Node.js 22 の Windows 用 zip（x64）を取得します',
        '現在の Node.js とは別のディレクトリ（例 %LOCALAPPDATA%\\Programs\\node22）に展開します',
        '「node.exe を選択…」をクリックして、展開したディレクトリの node.exe を選択します',
      ]);
      expect(v.pick).toEqual({ label: 'node.exe を選択…', primary: true });
      expect(v.labels.tryAgain).toBe('もう一度試す');
      expect([v.title, v.what, v.lead, ...v.steps].join('\n')).not.toContain('winget');
    });
    it('Linux では nvm で要る版を入れるコマンドを出す', () => {
      expect(node('node-version-mismatch', { found: '20.18.0' }, { os: 'Ubuntu 24.04 LTS' }).command).toBe('nvm install 22');
    });
  });

  describe('アーキテクチャが違う', () => {
    it('見つかった作りと、要る作りを見出しで言う', () => {
      const v = node('node-arch-mismatch', { found: '22.14.0', foundArch: 'x64' });
      expect(v.title).toBe('x64 用の Node.js を検出しましたが、Hangar には arm64 用が必要です');
      expect(v.what).toBe('この Mac で Hangar を実行するには、arm64 用の Node.js 22.14 以上が必要です。現在の Node.js を置き換えずに、別のディレクトリにインストールできます。');
      expect(v.command).toBe('brew install node@22');
      const w = node('node-arch-mismatch', { found: '22.14.0', foundArch: 'ia32', arch: 'x64' }, win);
      expect(w.what).toBe('この PC で Hangar を実行するには、x64 用の Node.js 22.14 以上が必要です。現在の Node.js を置き換えずに、別のディレクトリにインストールできます。');
      expect(w.steps[0]).toBe('nodejs.org から Node.js 22 の Windows 用 zip（x64）を取得します');
      expect(w.pick).toEqual({ label: 'node.exe を選択…', primary: true });
    });
  });

  it('版は殻が渡したものを使い、渡されなければ規則の既定（22.14、Node-API 10）と読む', () => {
    const v = node('node-missing', { min: '24.1', napi: 11 });
    expect(v.what).toBe('Hangar のデータベースとターミナルのネイティブモジュールは Node-API 11 を使うため、Node.js 24.1 以上が必要です。');
    expect(node('node-version-mismatch', { min: '24.1', found: '22.14.0' }).command).toBe('brew install node@24');
    expect(view('node-missing').what).toBe(reason);
  });
  it('見つかった版や作りが渡されなければ、見つからない札の文に落とす（? を出さない）', () => {
    expect(node('node-version-mismatch').title).toBe('Node.js が見つかりません');
    expect(node('node-arch-mismatch').title).toBe('Node.js が見つかりません');
    expect(node('node-version-mismatch', { found: 'v20; rm' }).title).toBe('Node.js が見つかりません');
  });
  it('英語の札', () => {
    const en = (kind: string, params: Record<string, string | number> = {}, os = 'macOS 15.1') => node(kind, params, { lang: 'en', os, ...(os.startsWith('Windows') ? { sep: '\\' } : {}) });
    const v = en('node-missing');
    expect(v.title).toBe('Node.js was not found');
    expect(v.what).toBe("Hangar's database and terminal parts use Node-API 10, so Hangar needs Node.js 22.14 or later.");
    expect(v.lead).toBe('Run this in Terminal:');
    expect(v.labels.tryAgain).toBe('I installed it, try again');
    expect(v.labels.detailsToggle).toBe('Details (places checked, other ways to install)');
    expect(v.pick).toEqual({ label: 'Choose node…', primary: false });
    expect(en('node-missing', {}, 'Windows 11').lead).toBe('Run this in PowerShell:');
    expect(en('node-missing', {}, 'Windows 11').pick!.label).toBe('Choose node.exe…');
    const old = en('node-version-mismatch', { found: '20.18.0' });
    expect(old.title).toBe('Node.js 20.18.0 was found, but Hangar needs Node.js 22.14 or later');
    expect(old.what).toBe("Hangar's database and terminal parts use Node-API 10. You can install it in another place without replacing your current Node.js.");
    expect(old.lead).toBe('To install it without replacing your current Node.js, run this in Terminal:');
    const oldWin = en('node-version-mismatch', { found: '20.18.0', arch: 'x64' }, 'Windows 11');
    expect(oldWin.lead).toBe('To install it without replacing your current Node.js:');
    expect(oldWin.steps).toEqual([
      'Get the Windows zip of Node.js 22 (x64) from nodejs.org',
      'Extract it to a folder separate from your current Node.js (for example %LOCALAPPDATA%\\Programs\\node22)',
      'Press "Choose node.exe…" and choose node.exe in that folder',
    ]);
    const arch = en('node-arch-mismatch', { found: '22.14.0', foundArch: 'x64' });
    expect(arch.title).toBe('Node.js for x64 was found, but Hangar needs one for arm64');
    expect(arch.what).toBe('Hangar on this Mac needs Node.js 22.14 or later for arm64. You can install it in another place without replacing your current Node.js.');
    for (const kind of m.NODE_KINDS) {
      for (const os of ['macOS 15.1', 'Windows 11']) {
        const e = en(kind, { found: '20.18.0', foundArch: 'x64' }, os);
        expect([e.title, e.what, e.lead ?? '', ...e.steps, e.command ?? '', e.pick?.label ?? '', ...Object.values(e.labels)].join('\n'), `${os} ${kind}`).not.toMatch(KANA_KANJI);
      }
    }
  });
  it('ほかの種類は、前置きの文と選ぶ釦を持たず、詳細を開いたまま、主の釦は「もう一度試す」のまま', () => {
    for (const kind of m.FAIL_KINDS.filter((k) => !m.NODE_KINDS.includes(k))) {
      const v = view(kind);
      expect(v.lead, kind).toBeNull();
      expect(v.pick, kind).toBeNull();
      expect(v.collapsed, kind).toBe(false);
      expect(v.labels.tryAgain, kind).toBe('もう一度試す');
    }
  });
  it('全文のコピーは、ほかの種類と同じく版と OS、種類、詳細の順', () => {
    expect(node('node-missing').copyText).toBe('Hangar 0.1.0 · macOS 15.1\nnode-missing\n\nNode 22.14 以上（arm64）が見つかりません。\n確認したパス:');
    expect(node('node-version-mismatch', { found: '20.18.0' }).copyText.split('\n')[1]).toBe('node-version-mismatch');
  });

  // 「node を選ぶ…」で選んだ Node が合わなかったとき、札に添える文（殻の pick_node の答えから作る）。
  describe('選んだ Node が合わないときの文', () => {
    it('Node として答えない、版が古い、アーキテクチャが違う、保存できない、を分けて言う', () => {
      expect(m.pickText('ja', { result: 'notNode', path: '/x/node' })).toBe('/x/node は Node.js として応答しませんでした。node の実行ファイルを選択してください。');
      expect(m.pickText('ja', { result: 'version', path: '/x/node', found: '20.18.0', min: '22.14' })).toBe('選択した Node.js は 20.18.0 です。Node.js 22.14 以上を選択してください。');
      expect(m.pickText('ja', { result: 'arch', path: '/x/node', foundArch: 'x64', arch: 'arm64' })).toBe('選択した Node.js は x64 用です。arm64 用を選択してください。');
      expect(m.pickText('ja', { result: 'saveFailed', error: 'permission denied' })).toBe('設定に保存できませんでした（permission denied）。');
      expect(m.pickText('en', { result: 'notNode', path: '/x/node' })).toBe('/x/node did not answer as Node.js. Choose the node executable.');
      expect(m.pickText('en', { result: 'version', found: '20.18.0', min: '22.14' })).toBe('The Node.js you chose is 20.18.0. Choose Node.js 22.14 or later.');
      expect(m.pickText('en', { result: 'arch', foundArch: 'x64', arch: 'arm64' })).toBe('The Node.js you chose is for x64. Choose one for arm64.');
      expect(m.pickText('en', { result: 'saveFailed', error: 'denied' })).toBe("Couldn't save the setting (denied).");
    });
    it('取り消した、合った、答えが無いときは何も添えない。知らない答えは確かめられなかったと言う', () => {
      expect(m.pickText('ja', { result: 'cancel' })).toBeNull();
      expect(m.pickText('ja', { result: 'ok', path: '/x/node' })).toBeNull();
      expect(m.pickText('ja', null)).toBeNull();
      expect(m.pickText('ja', { result: 'weird' })).toBe('選択した Node.js を確認できませんでした。');
      expect(m.pickText('en', { result: 'weird' })).toBe("Couldn't check the Node.js you chose.");
    });
  });
});

describe('パスの区切り', () => {
  // Windows では置き場が ~\.agent-hangar で届く。記録の場所が `\.agent-hangar/desktop.log` のように区切りを混ぜて出ていた。
  const win = { os: 'Windows 11', home: '~\\.agent-hangar', sep: '\\' };
  it('記録の場所は、殻が渡した区切りで置き場とつなぐ', () => {
    expect(view('other', win).labels.logAt).toBe('ログはこの PC の ~\\.agent-hangar\\desktop.log にあります');
    expect(view('other', { ...win, lang: 'en' }).labels.logAt).toBe('The log is at ~\\.agent-hangar\\desktop.log on this computer');
  });
  it('区切りが渡されなければ / でつなぐ（macOS と、前の版の殻）', () => {
    expect(view('other').labels.logAt).toBe('ログはこの PC の ~/.agent-hangar/desktop.log にあります');
    expect(view('other', { sep: 'x' }).labels.logAt).toBe('ログはこの PC の ~/.agent-hangar/desktop.log にあります');
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
    expect(v.band!.detail).toContain('現在のバージョンは 0.2.0-rc.5 です。');
    expect(en({ phase: 'available', version: '0.2.1' }).band).toMatchObject({ title: 'Hangar 0.2.1 is available', action: 'Download and install' });
  });
  // Node が無いときは、新しいバージョンを入れても Node は入らない。直ると言わず、今の版だけを言う。
  it('Node が無いときの札では、新しいバージョンで直るとは言わない', () => {
    expect(m.updateView('ja', { phase: 'available', version: '0.2.1' }, cur, 'node-missing').band!.detail).toBe('現在のバージョンは 0.2.0-rc.5 です。');
    expect(m.updateView('en', { phase: 'available', version: '0.2.1' }, cur, 'node-missing').band!.detail).toBe('You have 0.2.0-rc.5.');
    expect(m.updateView('ja', { phase: 'available', version: '0.2.1' }, cur, 'node-version-mismatch').band!.detail).toBe('現在のバージョンは 0.2.0-rc.5 です。');
    expect(m.updateView('ja', { phase: 'available', version: '0.2.1' }, cur, 'node-arch-mismatch').band!.detail).toBe('現在のバージョンは 0.2.0-rc.5 です。');
    expect(m.updateView('ja', { phase: 'available', version: '0.2.1' }, cur, 'server-exited').band!.detail).toContain('修正されている可能性があります');
  });
  it('ダウンロード中は進みを出し、大きさが分からなければ文だけにする', () => {
    const v = ja({ phase: 'downloading', version: '0.2.1', done: 25, total: 100 });
    expect(v.band).toMatchObject({ tone: 'info', title: 'Hangar 0.2.1', detail: '25%', action: null, progress: 0.25, progressLabel: 'ダウンロードの進行状況' });
    expect(v.demote).toBe(true);
    expect(ja({ phase: 'downloading', version: '0.2.1', done: 25, total: null }).band).toMatchObject({ detail: 'ダウンロード中…', progress: null });
  });
  it('インストール中は、終わると再起動することを言う', () => {
    const v = ja({ phase: 'installing', version: '0.2.1' });
    expect(v.band).toMatchObject({ title: 'Hangar 0.2.1', action: null });
    expect(v.band!.detail).toContain('インストール中…');
    expect(v.band!.detail).toContain('再起動');
  });
  it('確認に失敗したら、理由を帯に出し、もう一度確かめられるよう確認の釦を戻す', () => {
    const v = ja({ phase: 'failed', step: 'check', version: null, reason: 'network' });
    expect(v.check).toEqual({ hidden: false, disabled: false, label: '更新を確認' });
    expect(v.demote).toBe(false);
    expect(v.band).toMatchObject({ tone: 'error', title: '更新を確認できませんでした', detail: 'ネットワークまたは配布元に接続できませんでした。', action: null });
  });
  it('ダウンロードかインストールに失敗したら、いまのバージョンは変わらないことと理由を出し、やり直せるようにする', () => {
    const d = ja({ phase: 'failed', step: 'download', version: '0.2.1', reason: 'signature' });
    expect(d.band).toMatchObject({ tone: 'error', title: 'ダウンロードできませんでした', detail: '現在のバージョン 0.2.0-rc.5 は変わりません。署名を確認できませんでした。', action: 'ダウンロードしてインストール' });
    expect(d.check.hidden).toBe(true);
    expect(d.demote).toBe(true);
    const i = ja({ phase: 'failed', step: 'install', version: '0.2.1', reason: 'permission' });
    expect(i.band).toMatchObject({ title: 'インストールできませんでした', detail: '現在のバージョン 0.2.0-rc.5 は変わりません。インストールの権限を取得できませんでした。' });
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
