import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readFingerprintFile, signApp } from '../scripts/sign-macos.ts';

/**
 * 自動更新の更新物（Hangar.app.tar.gz と .sig）を、署名を終えた .app から作り直す台本（repack-updater-macos.sh）の試験。
 * tauri build の中で作られる更新物は署名の前の .app から詰められるので、署名の段の後で作り直す。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '../scripts/repack-updater-macos.sh');
const CI_SIGN = path.resolve(here, '../scripts/ci-sign-macos.sh');
const MAKE_CERT = path.resolve(here, '../scripts/make-signing-cert.sh');
const TAURI = path.resolve(here, '../../../node_modules/.bin/tauri');
const ID = 'dev.agent-hangar.hangar';
const PW = 'test-only-password';

const posix = process.platform !== 'win32';
const MACHO_SRC = '/bin/echo';
const onMac = process.platform === 'darwin' && fs.existsSync(MACHO_SRC);

const dirs: string[] = [];
const tmp = (p: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** tauri の bundle/macos と同じく、Hangar.app と古い更新物が並ぶ場所を作る。 */
function makeBundleDir(root: string): string {
  const dir = path.join(root, 'bundle/macos');
  const app = path.join(dir, 'Hangar.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources/server'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${ID}</string>
<key>CFBundleExecutable</key><string>T</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  fs.writeFileSync(path.join(app, 'Contents/Resources/server/server.mjs'), 'console.log(1)\n');
  if (onMac) fs.copyFileSync(MACHO_SRC, path.join(app, 'Contents/MacOS/T'));
  else fs.writeFileSync(path.join(app, 'Contents/MacOS/T'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  // tauri build が署名の前に詰めた古い更新物
  fs.writeFileSync(path.join(dir, 'Hangar.app.tar.gz'), 'stale');
  fs.writeFileSync(path.join(dir, 'Hangar.app.tar.gz.sig'), 'stale');
  return app;
}

function baseEnv(): Record<string, string> {
  const pass: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  for (const k of ['CI', 'GITHUB_ACTIONS', 'RUNNER_TEMP', 'TMPDIR']) {
    const v = process.env[k];
    if (v !== undefined) pass[k] = v;
  }
  return pass;
}

function run(args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...baseEnv(), ...env }, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}${r.error ? `\n${String(r.error)}` : ''}` };
}

/** 試しの更新の署名鍵（minisign）。tauri の CLI でその場で作る。 */
function updaterKey(dir: string): Record<string, string> {
  const key = path.join(dir, 'updater.key');
  const r = spawnSync(TAURI, ['signer', 'generate', '-w', key, '-p', PW, '--ci'], { encoding: 'utf8', env: { ...baseEnv(), CI: 'true' }, timeout: 60_000 });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return { TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(key, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PW };
}

function tarList(tarGz: string): string[] {
  return spawnSync('tar', ['-tzf', tarGz], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
}

describe.skipIf(!posix)('更新物の作り直し（引数と鍵）', () => {
  it('知らない段や、.app が無ければ止まる', () => {
    expect(run([]).status).not.toBe(0);
    expect(run(['nope', '/x/Hangar.app']).status).not.toBe(0);
    expect(run(['pack', '/no/such/Hangar.app']).status).not.toBe(0);
  });
  it('更新の署名鍵が無ければ、pack は止まる（署名の無い更新物を置かない）', () => {
    const d = tmp('hangar-repack-nokey-');
    const app = makeBundleDir(d);
    const r = run(['pack', app]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/TAURI_SIGNING_PRIVATE_KEY/);
  });
});

describe.skipIf(!onMac)('更新物の作り直し（実物の tar と codesign）', { timeout: 300_000 }, () => {
  it('署名済みの .app から tar.gz と .sig を作り直し、.app 1 つだけが入り、拡張属性の ._ を含まない', () => {
    const d = tmp('hangar-repack-pack-');
    const app = makeBundleDir(d);
    signApp({ app, mode: 'adhoc', identifier: ID });
    const r = run(['pack', app], updaterKey(d));
    expect(r.status, r.out).toBe(0);
    const tarGz = `${app}.tar.gz`;
    expect(fs.readFileSync(tarGz).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    const entries = tarList(tarGz);
    expect(new Set(entries.map((e) => e.split('/')[0]))).toEqual(new Set(['Hangar.app']));
    expect(entries.some((e) => path.basename(e).startsWith('._'))).toBe(false);
    expect(entries).toContain('Hangar.app/Contents/_CodeSignature/CodeResources');
    const sig = fs.readFileSync(`${tarGz}.sig`, 'utf8');
    expect(sig).not.toBe('stale');
    expect(Buffer.from(sig, 'base64').toString('utf8')).toMatch(/untrusted comment/);
  });

  it('verify は、展開した .app の識別子と DR が元の .app と同じで、verify が通れば 0', () => {
    const d = tmp('hangar-repack-verify-');
    const app = makeBundleDir(d);
    signApp({ app, mode: 'adhoc', identifier: ID });
    expect(run(['pack', app], updaterKey(d)).status).toBe(0);
    const r = run(['verify', app]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(ID);
  });

  it('verify は、更新物が署名の前の .app から詰められていれば止まる', () => {
    const d = tmp('hangar-repack-unsigned-');
    const app = makeBundleDir(d);
    // 署名の前に詰めたもの（tauri build の中で作られる更新物と同じ順序）
    spawnSync('tar', ['-czf', `${app}.tar.gz`, '-C', path.dirname(app), 'Hangar.app']);
    signApp({ app, mode: 'adhoc', identifier: ID });
    const r = run(['verify', app]);
    expect(r.status).not.toBe(0);
  });

  it('verify --expect-signed は、証明書の署名でなければ（ad-hoc なら）止まる', () => {
    const d = tmp('hangar-repack-adhoc-');
    const app = makeBundleDir(d);
    signApp({ app, mode: 'adhoc', identifier: ID });
    expect(run(['pack', app], updaterKey(d)).status).toBe(0);
    const f = path.join(d, 'fp.txt');
    fs.writeFileSync(f, `${'a'.repeat(40)}\n`);
    const r = run(['verify', app, '--expect-signed'], { HANGAR_SIGN_FINGERPRINT_FILE: f });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/DR/);
  });

  it('verify --expect-signed は、試しの証明書で CI の台本が署名した .app なら、識別子と DR が保たれて 0', () => {
    const d = tmp('hangar-repack-cert-');
    const out = path.join(d, 'cert');
    const mk = spawnSync('bash', [MAKE_CERT, '--out', out], { encoding: 'utf8', env: { ...baseEnv(), HANGAR_SIGN_P12_PASSWORD: PW }, timeout: 60_000 });
    expect(mk.status, `${mk.stdout}${mk.stderr}`).toBe(0);
    const fpFile = path.join(out, 'certificate-sha1.txt');
    const fp = readFingerprintFile(fpFile)!;
    const app = makeBundleDir(d);
    const signEnv = {
      HANGAR_SIGN_P12_BASE64: fs.readFileSync(path.join(out, 'hangar-signing.p12')).toString('base64'),
      HANGAR_SIGN_P12_PASSWORD: PW,
      HANGAR_SIGN_FINGERPRINT_FILE: fpFile,
    };
    const s = spawnSync('bash', [CI_SIGN, app], { encoding: 'utf8', env: { ...baseEnv(), ...signEnv }, timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(s.status, `${s.stdout}${s.stderr}`).toBe(0);
    expect(run(['pack', app], updaterKey(d)).status).toBe(0);
    const r = run(['verify', app, '--expect-signed'], { HANGAR_SIGN_FINGERPRINT_FILE: fpFile });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`certificate leaf = H"${fp}"`);
  });
});
