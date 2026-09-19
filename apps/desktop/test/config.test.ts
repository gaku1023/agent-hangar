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
    expect(conf.app.windows[0]).toMatchObject({ label: 'main', title: 'agent-hangar', width: 1400, height: 900 });
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
  });
});
