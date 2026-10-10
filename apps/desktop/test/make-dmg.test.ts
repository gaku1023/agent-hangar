import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../scripts/make-dmg.sh');
const releaseYml = path.resolve(here, '../../../.github/workflows/release.yml');
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// hdiutil と codesign を使うので、macOS でだけ走る（CI では desktop ジョブ）。
const mac = process.platform === 'darwin';

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8' });

// 署名した小さな .app を作る。
// 中身は本物の Hangar.app と関係なく、dmg に詰めても署名が崩れないことだけを見るためのものである。
function fakeApp(dir: string): string {
  const app = path.join(dir, 'Hangar.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>hangar</string>
<key>CFBundleIdentifier</key><string>dev.example.fake</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  const exe = path.join(app, 'Contents', 'MacOS', 'hangar');
  fs.copyFileSync('/usr/bin/true', exe);
  const signed = run('codesign', ['--force', '--sign', '-', '--identifier', 'dev.example.fake', app]);
  expect(signed.status, signed.stderr).toBe(0);
  return app;
}

function attach(dmg: string, mountpoint: string): void {
  const r = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountpoint, dmg]);
  expect(r.status, r.stderr).toBe(0);
}

describe.skipIf(!mac)('make-dmg.sh', () => {
  it('.app と Applications へのリンクを詰め、.app の署名をそのまま保つ', () => {
    const d = tmp('hangar-dmg-');
    dirs.push(d);
    const app = fakeApp(d);
    const out = path.join(d, 'out', 'Hangar-v0.0.0-macos-arm64.dmg');
    fs.mkdirSync(path.dirname(out));
    const made = run('bash', [script, app, out]);
    expect(made.status, made.stderr).toBe(0);
    expect(fs.statSync(out).size).toBeGreaterThan(0);

    const mnt = path.join(d, 'mnt');
    fs.mkdirSync(mnt);
    attach(out, mnt);
    try {
      const entries = fs.readdirSync(mnt).filter((n) => !n.startsWith('.'));
      expect(entries.sort()).toEqual(['Applications', 'Hangar.app']);
      expect(fs.readlinkSync(path.join(mnt, 'Applications'))).toBe('/Applications');
      // 署名した後の .app を詰めるので、識別子が変わらず、検証も通る。
      const shown = run('codesign', ['-dvv', path.join(mnt, 'Hangar.app')]);
      expect(shown.stderr).toMatch(/^Identifier=dev\.example\.fake$/m);
      const verified = run('codesign', ['--verify', '--deep', '--strict', path.join(mnt, 'Hangar.app')]);
      expect(verified.status, verified.stderr).toBe(0);
    } finally {
      run('hdiutil', ['detach', mnt]);
    }
    const info = run('hdiutil', ['imageinfo', out]);
    expect(info.stdout).toMatch(/Format: ULMO/);
  });

  it('同じ名前の dmg があれば作り直す', () => {
    const d = tmp('hangar-dmg-');
    dirs.push(d);
    const app = fakeApp(d);
    const out = path.join(d, 'Hangar.dmg');
    fs.writeFileSync(out, 'old');
    const made = run('bash', [script, app, out]);
    expect(made.status, made.stderr).toBe(0);
    expect(fs.statSync(out).size).toBeGreaterThan(3);
  });

  it('.app が無ければ止まり、dmg を作らない', () => {
    const d = tmp('hangar-dmg-');
    dirs.push(d);
    const out = path.join(d, 'Hangar.dmg');
    const made = run('bash', [script, path.join(d, 'Missing.app'), out]);
    expect(made.status).not.toBe(0);
    expect(made.stderr).toMatch(/Missing\.app/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('引数が足りなければ使い方を出して止まる', () => {
    const made = run('bash', [script]);
    expect(made.status).not.toBe(0);
    expect(made.stderr).toMatch(/make-dmg\.sh <Hangar\.app> <出力の \.dmg>/);
  });
});

// Release の macOS の資産は dmg が主、zip が従（段 5 の決定）。
// dmg は tauri の dmg ターゲットでは作らない。
// tauri の dmg は build の途中で .app を詰めるので、build の後で署名した .app が入らない。
// tauri bundle --bundles dmg も .app を作り直してから詰めるので、署名が消える（2026-10-10 に手元で確かめた）。
describe('release.yml の macOS の資産', () => {
  const yml = fs.readFileSync(releaseYml, 'utf8');
  // macos ジョブの範囲だけを見る（次のジョブの見出しの手前まで）。
  const start = yml.indexOf('\n  macos:\n');
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  const macos = next === -1 ? rest : rest.slice(0, next + 1);
  it('dmg を zip と同じ名前の形で作り、checksum を添えて Release に載せる', () => {
    expect(macos).toContain('name="Hangar-${GITHUB_REF_NAME}-macos-${{ matrix.arch }}"');
    expect(macos).toMatch(/bash "\$GITHUB_WORKSPACE\/apps\/desktop\/scripts\/make-dmg\.sh" Hangar\.app "\$name\.dmg"/);
    expect(macos).toContain('shasum -a 256 "$name.dmg" > "$name.dmg.sha256"');
    expect(macos).toContain('${{ env.ASSET_DIR }}/*.dmg\n');
    expect(macos).toContain('${{ env.ASSET_DIR }}/*.dmg.sha256\n');
    // zip は従として残す。
    expect(macos).toContain('${{ env.ASSET_DIR }}/*.zip\n');
  });
  it('dmg は .app のビルドの後で作る', () => {
    const build = macos.indexOf('npm run tauri -- build');
    const dmg = macos.indexOf('make-dmg.sh');
    expect(build).toBeGreaterThan(-1);
    expect(dmg).toBeGreaterThan(build);
  });
  it('tauri の dmg ターゲットは使わない（.app だけを作る）', () => {
    const conf = JSON.parse(fs.readFileSync(path.resolve(here, '../src-tauri/tauri.conf.json'), 'utf8'));
    expect(conf.bundle.targets).toEqual(['app']);
  });
});
