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
  it('版は package.json と Cargo.toml と一致する', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(conf.version).toBe(pkg.version);
    expect(read('src-tauri/Cargo.toml')).toContain(`version = "${pkg.version}"`);
  });
});

describe('Info.plist', () => {
  it('iTerm2 の AppleScript 用の説明文を持つ', () => {
    expect(read('src-tauri/Info.plist')).toContain('NSAppleEventsUsageDescription');
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
