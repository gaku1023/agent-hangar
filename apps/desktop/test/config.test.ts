import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(app, p), 'utf8');

describe('tauri.conf.json', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  it('hangar スキームを登録し、同梱サーバを server/ に置き、読み込み画面から始める', () => {
    expect(conf.plugins['deep-link'].desktop.schemes).toEqual(['hangar']);
    expect(conf.bundle.resources).toEqual({ '../server-dist': 'server' });
    expect(conf.bundle.targets).toEqual(['app']);
    expect(conf.identifier).toBe('dev.agent-hangar.hangar');
    expect(conf.build.frontendDist).toBe('../loading');
    expect(fs.existsSync(path.join(app, 'src-tauri', conf.build.frontendDist, 'index.html'))).toBe(true);
    expect(conf.app.windows[0]).toMatchObject({ label: 'main', title: 'Hangar', width: 1400, height: 900, titleBarStyle: 'Overlay', hiddenTitle: true });
  });
  // csp を null にしてあるのは、ウィンドウが読み込み画面から離れたあとはサーバ自身の
  // Content-Security-Policy だけが効く形にするためである。
  // Tauri の csp は、frontendDist として配る読み込み画面にしか付かない。
  // ここに値を入れると、サーバが配るヘッダと二重になり、どちらが効くのかが読めなくなる。
  // UI に対する制限は packages/server/src/http の CSP が正本で、そこだけを直せばよい。
  it('csp は null にして、サーバ自身のヘッダだけを効かせる', () => {
    expect(conf.app.security.csp).toBe(null);
  });
  // icon に並べたファイルが欠けていると、bundle の途中で初めて落ちる。
  // 生成物ではなくリポジトリに置くファイルなので、ここで実在を見ておく。
  it('icon に並ぶファイルが実在する', () => {
    expect(conf.bundle.icon.length).toBeGreaterThan(0);
    for (const rel of conf.bundle.icon) {
      expect(fs.existsSync(path.join(app, 'src-tauri', rel)), rel).toBe(true);
    }
  });
  it('版は package.json と Cargo.toml と一致する', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(conf.version).toBe(pkg.version);
    // 部分一致だと依存の version 行にも当たるので、[package] の version だけを取り出して見る。
    const cargo = read('src-tauri/Cargo.toml');
    const section = cargo.split(/^\[/m).find((s) => s.startsWith('package]'));
    expect(section, '[package] が見つかりません').toBeDefined();
    expect(/^version = "(.+)"$/m.exec(section!)?.[1]).toBe(pkg.version);
  });
});

describe('Info.plist', () => {
  it('iTerm2 の AppleScript 用の説明文を持つ', () => {
    expect(read('src-tauri/Info.plist')).toContain('NSAppleEventsUsageDescription');
  });
  // hangar スキームの登録は tauri.conf.json の deep-link から CLI が作る。
  // ここに手で書くと、併合された Info.plist に CFBundleURLTypes が二つ並ぶ。
  it('CFBundleURLTypes は手で書かない。deep-link の設定から生成される', () => {
    expect(read('src-tauri/Info.plist')).not.toContain('CFBundleURLTypes');
  });
});

describe('読み込み画面', () => {
  it('status 要素を持ち、常にライトで描く', () => {
    const html = read('loading/index.html');
    expect(html).toContain('id="status"');
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).toContain('color-scheme" content="light"');
    expect(html).toContain('<title>Hangar</title>');
    expect(html).toContain('src="logo.svg"');
    expect(html).toContain('<img id="logo" src="logo.svg"');
    expect(html).toContain('<script type="module" src="boot.js"></script>');
  });
  // 殻は起動画面の周の境目まで待ってから画面を移す。周期が食い違うと、送りの途中で画面が替わる。
  it('殻の周期（lib.rs の BOOT_CYCLE_MS）は、起動画面の周期（boot-frames.js の CYCLE_MS）と同じ', () => {
    const rust = read('src-tauri/src/lib.rs').match(/const BOOT_CYCLE_MS: u64 = (\d+);/)?.[1];
    const js = read('loading/boot-frames.js').match(/export const CYCLE_MS = (\d+);/)?.[1];
    expect(rust).toBeDefined();
    expect(rust).toBe(js);
  });
  // 殻は境目まで待った後、移る前に起動画面の動きを止めさせる。止める口の名前が食い違うと、最後のコマで新しい札が降り始める。
  it('殻が呼ぶ止める口（__hangarBootSettle）を、起動画面が持つ', () => {
    const rust = read('src-tauri/src/lib.rs').match(/const BOOT_SETTLE_JS: &str = "([^"]+)";/)?.[1];
    expect(rust).toBe('window.__hangarBootSettle && window.__hangarBootSettle()');
    expect(read('loading/boot.js')).toContain('window.__hangarBootSettle = ');
  });
});

describe('capabilities', () => {
  const dir = path.join(app, 'src-tauri', 'capabilities');
  const cap = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  it('置くのは既定と、窓を動かすための 2 つだけ', () => {
    expect(fs.readdirSync(dir).sort()).toEqual(['default.json', 'remote-drag.json']);
  });
  it('既定の権限は core:default のまま変えない', () => {
    expect(cap('default.json').permissions).toEqual(['core:default']);
    expect(cap('default.json').remote).toBeUndefined();
  });
  // UI はサーバ（127.0.0.1:4177）から読み込む。そこから呼べる殻の機能は、窓を動かす権限と、ダブルクリックで拡大する権限の 2 つだけにする。
  it('UI の出どころには、窓を動かす権限と、ダブルクリックで拡大する権限の 2 つだけ与える', () => {
    const c = cap('remote-drag.json');
    expect(c.windows).toEqual(['main']);
    expect(c.remote).toEqual({ urls: ['http://127.0.0.1:4177/*'] });
    expect(c.permissions).toEqual(['core:window:allow-start-dragging', 'core:window:allow-internal-toggle-maximize']);
  });
  // 権限の出どころのポートと、殻がサーバを立てるポートは別のファイルにある。片方だけ変えると、ヘッダを掴んでも窓が動かなくなる。
  it('権限の出どころのポートは、殻がサーバを立てるポート（server.rs の PORT）と同じ', () => {
    const port = read('src-tauri/src/server.rs').match(/pub const PORT: u16 = (\d+);/)?.[1];
    expect(port).toBeDefined();
    expect(cap('remote-drag.json').remote.urls).toEqual([`http://127.0.0.1:${port}/*`]);
  });
});

describe('殻の印', () => {
  // 殻が付ける印と、画面がそれを読む規則は別の言語に分かれている。片方だけ直すと、ブラウザか殻のどちらかで余白が崩れる。
  it('殻は頁に data-shell="desktop" を付け、画面はそれでサイドバーの上を空ける', () => {
    expect(read('src-tauri/src/lib.rs')).toContain("document.documentElement.dataset.shell = 'desktop'");
    const base = fs.readFileSync(path.resolve(app, '../../packages/ui/src/styles/base.css'), 'utf8');
    expect(base).toContain("[data-shell='desktop'] .sidebar {");
  });
});
