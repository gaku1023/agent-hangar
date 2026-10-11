import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION_FILES, compareVersions } from '../scripts/release-plan.ts';
import { REHEARSAL_SCRIPT, injectRehearsal, nextVersion, rehearsalConfig, stageUpdate } from '../scripts/update-rehearsal.ts';

/**
 * CI で、本当の更新の経路を 1 回通す（版 A の殻を入れて起こし、版 B へ updater で更新し、起き直した殻が版 B を名乗ることを見る）。
 * 鍵は CI の中で作る使い捨ての鍵で、目録はローカルの HTTP で配る。
 * ここでは、その準備をする台本（scripts/update-rehearsal.ts）と、CI の段の配線を確かめる。
 */
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../..');
const script = path.join(app, 'scripts/update-rehearsal.ts');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'update-rehearsal-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('版 B の版', () => {
  it('版 A より新しい版（patch を 1 つ上げ、プレリリースを外す）', () => {
    expect(nextVersion('0.2.0-rc.5')).toBe('0.2.1');
    expect(nextVersion('1.4.2')).toBe('1.4.3');
    for (const v of ['0.2.0-rc.5', '0.2.0', '1.4.2', '0.9.9-beta.1']) expect(compareVersions(nextVersion(v), v)).toBe(1);
  });
  it('semver でなければ止める', () => {
    expect(() => nextVersion('v0.2.0')).toThrow();
    expect(() => nextVersion('0.2')).toThrow();
  });
});

describe('試しの build に重ねる設定', () => {
  const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
  it('使い捨ての公開鍵と、ローカルの目録を指し、更新物を作る', () => {
    const c = rehearsalConfig('PUBKEY', 47181);
    expect(c.plugins.updater.pubkey).toBe('PUBKEY');
    expect(c.plugins.updater.endpoints).toEqual(['http://127.0.0.1:47181/latest.json']);
    // ローカルの目録は http なので、updater に許させる。この設定は試しの build にだけ重ねる。
    expect(c.plugins.updater.dangerousInsecureTransportProtocol).toBe(true);
    expect(c.bundle.createUpdaterArtifacts).toBe(true);
    // 版は重ねない。版 B は set-version で 5 つの在りかをそろえて上げる（サーバの版も上がる）。
    expect(JSON.stringify(c)).not.toContain('"version"');
  });
  // ふだんの build（手元、ci の配布物、release）には効かない。目録は https の GitHub だけで、http は許さない。
  it('ふだんの設定は http の目録を許さず、配布の道は試しの設定を重ねない', () => {
    expect(conf.plugins.updater.dangerousInsecureTransportProtocol).toBeUndefined();
    for (const e of conf.plugins.updater.endpoints as string[]) expect(e).toMatch(/^https:\/\/github\.com\//);
    expect(read('.github/workflows/release.yml')).not.toContain('update-rehearsal');
    expect(read('.github/actions/windows-installer/action.yml')).not.toContain('update-rehearsal');
  });
  it('台本は鍵の置き場と番号から、設定のファイルを書く', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'k.pub'), 'PUBKEY\n');
    const out = path.join(d, 'rehearsal.conf.json');
    const r = await run(['config', path.join(d, 'k.pub'), '47182', out]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(rehearsalConfig('PUBKEY', 47182));
  });
});

describe('ローカルの目録', () => {
  it('更新物を配る置き場へ写し、署名の中身と、置き場の URL を目録に書く', () => {
    const d = tmp();
    const src = path.join(d, 'build');
    const serve = path.join(d, 'serve');
    fs.mkdirSync(src);
    const artifact = path.join(src, 'Hangar_0.2.1_x64-setup.exe');
    fs.writeFileSync(artifact, 'installer');
    fs.writeFileSync(`${artifact}.sig`, 'SIGNATURE\n');
    const m = stageUpdate({ serveDir: serve, version: '0.2.1', platform: 'windows-x86_64', artifact, port: 47183, now: new Date('2026-10-11T00:00:00Z') });
    expect(m).toEqual({
      version: '0.2.1',
      notes: '',
      pub_date: '2026-10-11T00:00:00.000Z',
      platforms: { 'windows-x86_64': { url: 'http://127.0.0.1:47183/Hangar_0.2.1_x64-setup.exe', signature: 'SIGNATURE' } },
    });
    expect(fs.readFileSync(path.join(serve, 'Hangar_0.2.1_x64-setup.exe'), 'utf8')).toBe('installer');
    expect(JSON.parse(fs.readFileSync(path.join(serve, 'latest.json'), 'utf8'))).toEqual(m);
  });
  it('署名が無ければ止める（鍵を渡し忘れた build）', () => {
    const d = tmp();
    const artifact = path.join(d, 'Hangar.app.tar.gz');
    fs.writeFileSync(artifact, 'x');
    expect(() => stageUpdate({ serveDir: path.join(d, 's'), version: '0.2.1', platform: 'darwin-aarch64', artifact, port: 1 })).toThrow(/\.sig/);
  });
  it('置き場のファイルだけを配り、外へ抜ける道は 404 にして、受けた要求を 1 行ずつ書く', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'latest.json'), '{"version":"0.2.1"}');
    fs.writeFileSync(path.join(path.dirname(d), `${path.basename(d)}-outside.txt`), 'secret');
    dirs.push(path.join(path.dirname(d), `${path.basename(d)}-outside.txt`));
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script, 'serve', d, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (c: Buffer) => {
          buf += c.toString();
          const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
          if (m) resolve(Number(m[1]));
        });
        child.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
      });
      const ok = await fetch(`http://127.0.0.1:${port}/latest.json`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ version: '0.2.1' });
      expect((await fetch(`http://127.0.0.1:${port}/..%2F${path.basename(d)}-outside.txt`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/nothing`)).status).toBe(404);
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      await fetch(`http://127.0.0.1:${port}/latest.json`);
      await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain('GET /latest.json 200');
    } finally {
      child.kill();
    }
  });
});

describe('入れた版 A の UI に差し込む、更新を進める頁の台本', () => {
  const ui = () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'assets'));
    fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><html><head><title>Hangar</title><script type="module" crossorigin src="/assets/index-abc.js"></script></head><body></body></html>');
    return d;
  };
  it('assets に台本を置き、index.html の head の終わりに 1 度だけ読み込ませる', () => {
    const d = ui();
    injectRehearsal(d);
    injectRehearsal(d);
    const html = fs.readFileSync(path.join(d, 'index.html'), 'utf8');
    // サーバの CSP は script-src 'self' なので、インラインではなく assets のファイルにする。
    expect(html.split(`<script src="/assets/${REHEARSAL_SCRIPT}"></script>`)).toHaveLength(2);
    expect(html.indexOf(REHEARSAL_SCRIPT)).toBeLessThan(html.indexOf('</head>'));
    expect(fs.existsSync(path.join(d, 'assets', REHEARSAL_SCRIPT))).toBe(true);
  });
  it('頁と同じ口（__TAURI_INTERNALS__.invoke）で、確認、取得、インストールの順に殻の命令を呼ぶ', () => {
    const d = ui();
    injectRehearsal(d);
    const js = fs.readFileSync(path.join(d, 'assets', REHEARSAL_SCRIPT), 'utf8');
    expect(js).toContain('__TAURI_INTERNALS__');
    const names = [...js.matchAll(/invoke\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(names).toEqual(['update_check', 'update_download', 'update_install']);
    // 殻の命令の名前と、頁に許した命令（capabilities/remote-update.json）にそろっている。
    const lib = read('apps/desktop/src-tauri/src/lib.rs');
    const allowed = JSON.parse(read('apps/desktop/src-tauri/capabilities/remote-update.json')).permissions as string[];
    for (const n of names) {
      expect(lib).toContain(`async fn ${n}(`);
      expect(allowed).toContain(`allow-${n!.replaceAll('_', '-')}`);
    }
  });
  it('head の無い index.html には差し込まずに止める', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'assets'));
    fs.writeFileSync(path.join(d, 'index.html'), '<html><body></body></html>');
    expect(() => injectRehearsal(d)).toThrow(/head/);
  });
});

// CI の 2 つのジョブで通す。Windows はインストーラ（/P /UPDATE /R /ARGS）、macOS は .app.tar.gz の入れ替えである。
describe('CI の段', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = (name: string) => {
    const at = ci.indexOf(`\n  ${name}:\n`);
    const next = ci.slice(at + 1).search(/\n {2}[a-z-]+:\n/);
    return next < 0 ? ci.slice(at) : ci.slice(at, at + 1 + next);
  };
  const stepOf = (j: string, run: string) => {
    const at = j.indexOf(run);
    expect(at, run).toBeGreaterThan(-1);
    return j.slice(j.lastIndexOf('- name:', at), at + run.length);
  };
  it('windows ジョブは、配布物の段の後で、版 A から版 B への更新を通す', () => {
    const w = job('windows');
    const run = 'run: pwsh -NoProfile -File apps/desktop/scripts/ci-update-windows.ps1';
    expect(w.indexOf(run)).toBeGreaterThan(w.indexOf('./.github/actions/windows-installer'));
    expect(w.indexOf(run)).toBeGreaterThan(w.indexOf('ci-boot-probe-windows.ps1'));
    expect(stepOf(w, run)).toMatch(/timeout-minutes: \d+\n/);
  });
  it('desktop ジョブは、.app の段の後で、版 A から版 B への入れ替えを通す', () => {
    const d = job('desktop');
    const run = 'run: bash apps/desktop/scripts/ci-update-macos.sh';
    expect(d.indexOf(run)).toBeGreaterThan(d.indexOf('ci-boot-probe-macos.sh'));
    expect(stepOf(d, run)).toMatch(/timeout-minutes: \d+\n/);
  });
  it('Windows の台本は、本当の更新の経路の印を確かめる', () => {
    const ps = read('apps/desktop/scripts/ci-update-windows.ps1');
    // 使い捨ての鍵を CI の中で作る。本物の secret は使わない。
    expect(ps).toContain('signer generate');
    expect(ps).not.toMatch(/secrets\./);
    expect(ps).toContain('update-rehearsal.ts');
    // 殻がインストーラに渡す引数（tauri-plugin-updater の nsis の道）。
    for (const a of ['/P', '/UPDATE', '/R', '/ARGS']) expect(ps).toContain(`'${a}'`);
    // on_before_exit でサーバを止め、入れ終えたら起き直して版 B を名乗る。
    expect(ps).toContain('update: handing over to the installer');
    expect(ps).toContain('server stopped');
    expect(ps).toContain('/health');
  });
  // 版 B は set-version で 5 つの在りかをそろえて上げ、build の後で git checkout で元に戻す。戻し漏れが無いよう、名簿は VERSION_FILES と同じにする。
  it('両方の台本は、版 B の build の後で、版の在りかをすべて元に戻す', () => {
    for (const f of ['apps/desktop/scripts/ci-update-windows.ps1', 'apps/desktop/scripts/ci-update-macos.sh']) {
      const text = read(f);
      expect(text, f).toMatch(/git (-C \S+ )?checkout -- /);
      expect(text, f).toContain('release-plan.ts');
      expect(text, f).toContain('set-version');
      for (const v of VERSION_FILES) expect(text, `${f}: ${v}`).toContain(v);
    }
  });
  // 確認で取り消したアンインストールは、PATH も置き場も残す（hooks.nsh の NSIS_HOOK_POSTUNINSTALL）。
  it('Windows の台本は、殻を開いたまま消そうとして取り消すと、PATH が残ることを見る', () => {
    const ps = read('apps/desktop/scripts/ci-update-windows.ps1');
    expect(ps).toContain('uninstall.exe');
    // 確認の頁で「アンインストール」を押し、動いている殻の問いで「キャンセル」を押す。
    expect(ps).toMatch(/IDCANCEL/);
    expect(ps).toContain('取り消したのに PATH から');
  });
  it('macOS の台本は、.app.tar.gz で入れ替えて起き直した殻が版 B を名乗ることを見る', () => {
    const sh = read('apps/desktop/scripts/ci-update-macos.sh');
    expect(sh).toContain('signer generate');
    expect(sh).toContain('update-rehearsal.ts');
    expect(sh).toContain('.app.tar.gz');
    expect(sh).toContain('/health');
    expect(sh).toContain('CFBundleShortVersionString');
  });
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    c.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    c.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
