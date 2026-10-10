import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  designatedRequirement,
  expectedDrLine,
  findMachOs,
  normalizeFingerprint,
  parseArgs,
  parseDisplay,
  readFingerprintFile,
  readIdentifier,
  signApp,
  unlockKeychain,
  type RunResult,
  type Runner,
} from '../scripts/sign-macos.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const confPath = path.resolve(here, '../src-tauri/tauri.conf.json');
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// 台本は macOS の道具と bash の前提なので、Windows では組み立ての単体試験だけ走らせる。
const posix = process.platform !== 'win32';

const FP = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
const FP_LC = FP.toLowerCase();
const ID = 'dev.agent-hangar.hangar';

describe('識別子の読み出し', () => {
  it('tauri.conf.json の identifier を読む', () => {
    expect(readIdentifier(confPath)).toBe(ID);
  });
  it('identifier が無ければ止まる', () => {
    const d = tmp('hangar-sign-conf-');
    dirs.push(d);
    const p = path.join(d, 'tauri.conf.json');
    fs.writeFileSync(p, JSON.stringify({ productName: 'X' }));
    expect(() => readIdentifier(p)).toThrow(/identifier/);
  });
});

describe('指紋と DR の組み立て', () => {
  it('指紋はコロンや空白があっても、大文字でも、小文字の 40 桁に直す', () => {
    expect(normalizeFingerprint(FP)).toBe(FP_LC);
    expect(normalizeFingerprint(FP.match(/../g)!.join(':'))).toBe(FP_LC);
    expect(normalizeFingerprint(` ${FP_LC}\n`)).toBe(FP_LC);
  });
  it('40 桁の 16 進でなければ止まる', () => {
    expect(() => normalizeFingerprint('abc')).toThrow(/40/);
    expect(() => normalizeFingerprint('z'.repeat(40))).toThrow(/40/);
  });
  it('DR は葉の証明書の指紋（小文字）で縛る', () => {
    expect(designatedRequirement(FP)).toBe(`certificate leaf = H"${FP_LC}"`);
    expect(expectedDrLine(FP)).toBe(`designated => certificate leaf = H"${FP_LC}"`);
  });
  it('指紋の置き場は # の行と空行を読み飛ばし、値が無ければ undefined', () => {
    const d = tmp('hangar-sign-fp-');
    dirs.push(d);
    const p = path.join(d, 'fp.txt');
    fs.writeFileSync(p, '# 説明\n\n');
    expect(readFingerprintFile(p)).toBeUndefined();
    fs.writeFileSync(p, `# 説明\n${FP}\n`);
    expect(readFingerprintFile(p)).toBe(FP_LC);
    expect(readFingerprintFile(path.join(d, 'none.txt'))).toBeUndefined();
  });
  it('codesign -dvv の出力から識別子と署名の種類を読む', () => {
    const out = `Executable=/x/T\nIdentifier=${ID}\nFormat=app bundle\nSignature=adhoc\nTeamIdentifier=not set\n`;
    expect(parseDisplay(out)).toMatchObject({ identifier: ID, signature: 'adhoc' });
  });
});

describe('引数の扱い', () => {
  const noFile = path.join(os.tmpdir(), 'hangar-sign-no-such-fingerprint.txt');
  const base = { identifier: ID, fingerprintFile: noFile };
  it('app が無ければ止まる', () => {
    expect(() => parseArgs([], {}, base)).toThrow(/app/);
  });
  it('--adhoc なら証明書もキーチェーンも要らない', () => {
    const o = parseArgs(['/x/Hangar.app', '--adhoc'], {}, base);
    expect(o).toMatchObject({ app: '/x/Hangar.app', mode: 'adhoc', identifier: ID });
  });
  it('証明書の指紋が無ければ止まり、--adhoc を案内する（黙って ad-hoc にしない）', () => {
    expect(() => parseArgs(['/x/Hangar.app'], { HANGAR_SIGN_KEYCHAIN: '/k.keychain-db' }, base)).toThrow(/--adhoc/);
  });
  it('キーチェーンが無ければ止まる', () => {
    expect(() => parseArgs(['/x/Hangar.app'], { HANGAR_SIGN_CERT_SHA1: FP }, base)).toThrow(/HANGAR_SIGN_KEYCHAIN/);
  });
  it('環境変数の指紋とキーチェーンを受け取る。パスワードは環境変数からだけ', () => {
    const o = parseArgs(['/x/Hangar.app'], { HANGAR_SIGN_CERT_SHA1: FP, HANGAR_SIGN_KEYCHAIN: '/k.keychain-db', HANGAR_SIGN_KEYCHAIN_PASSWORD: 'pw' }, base);
    expect(o).toMatchObject({ mode: 'cert', fingerprint: FP_LC, keychain: '/k.keychain-db', keychainPassword: 'pw' });
  });
  it('環境変数に無ければリポジトリの指紋の置き場を使う', () => {
    const d = tmp('hangar-sign-args-');
    dirs.push(d);
    const f = path.join(d, 'fp.txt');
    fs.writeFileSync(f, `${FP}\n`);
    const o = parseArgs(['/x/Hangar.app'], { HANGAR_SIGN_KEYCHAIN: '/k' }, { ...base, fingerprintFile: f });
    expect(o.fingerprint).toBe(FP_LC);
  });
  it.skipIf(!posix)('/Applications の中は断る', () => {
    expect(() => parseArgs(['/Applications/Hangar.app', '--adhoc'], {}, base)).toThrow(/Applications/);
  });
  it('知らない引数は止まる', () => {
    expect(() => parseArgs(['/x/Hangar.app', '--adhoc', '--nope'], {}, base)).toThrow(/--nope/);
  });
});

/** 実在の Mach-O（システムの小さな実行ファイル）。この機械が macOS でなければ空。 */
const MACHO_SRC = '/bin/echo';
const onMac = process.platform === 'darwin' && fs.existsSync(MACHO_SRC);

function makeApp(root: string, identifier = 'dev.example.fixture'): string {
  const app = path.join(root, 'T.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources/server/node_modules/m'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>T</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  fs.writeFileSync(path.join(app, 'Contents/Resources/server/server.mjs'), 'console.log(1)\n');
  fs.writeFileSync(path.join(app, 'Contents/Resources/server/node_modules/m/readme.txt'), 'text\n');
  if (onMac) {
    fs.copyFileSync(MACHO_SRC, path.join(app, 'Contents/MacOS/T'));
    fs.copyFileSync(MACHO_SRC, path.join(app, 'Contents/Resources/server/node_modules/m/a.node'));
    fs.copyFileSync(MACHO_SRC, path.join(app, 'Contents/Resources/server/node_modules/m/spawn-helper'));
  } else {
    // Mach-O のふりをして先頭の 4 バイトだけ合わせる
    const fake = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
    fs.writeFileSync(path.join(app, 'Contents/MacOS/T'), fake);
    fs.writeFileSync(path.join(app, 'Contents/Resources/server/node_modules/m/a.node'), fake);
    fs.writeFileSync(path.join(app, 'Contents/Resources/server/node_modules/m/spawn-helper'), fake);
  }
  return app;
}

describe('Mach-O の拾い出し', () => {
  it.skipIf(!posix)('Mach-O だけを、深いところから先に並べる。テキストと、シンボリックリンクは拾わない', () => {
    const d = tmp('hangar-sign-find-');
    dirs.push(d);
    const app = makeApp(d);
    fs.symlinkSync(path.join(app, 'Contents/MacOS/T'), path.join(app, 'Contents/Resources/link'));
    const found = findMachOs(app).map((f) => path.relative(app, f));
    expect(found.sort()).toEqual(['Contents/MacOS/T', 'Contents/Resources/server/node_modules/m/a.node', 'Contents/Resources/server/node_modules/m/spawn-helper']);
    const ordered = findMachOs(app).map((f) => path.relative(app, f).split(path.sep).length);
    expect(ordered).toEqual([...ordered].sort((a, b) => b - a));
  });
});

/** codesign と security の呼び出しを記録する偽の実行器。応答は呼び出しごとに差し替えられる。 */
function fakeRunner(responder: (cmd: string, args: string[]) => Partial<RunResult> = () => ({})): { run: Runner; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '', stderr: '', ...responder(cmd, args) };
  };
  return { run, calls };
}

describe('署名の手順（偽の codesign）', () => {
  const app = '/x/T.app';
  const found = ['/x/T.app/Contents/Resources/a.node', '/x/T.app/Contents/MacOS/T'];
  const certOpts = { app, mode: 'cert' as const, identifier: ID, fingerprint: FP_LC, keychain: '/k.keychain-db' };
  const okResponder = (fp: string | null) => (cmd: string, args: string[]): Partial<RunResult> => {
    if (cmd !== 'codesign') return {};
    if (args[0] === '-d' && args[1] === '-r-') return { stderr: fp ? `# designated => certificate leaf = H"${fp}"\n`.replace('# ', '') : 'designated => cdhash H"aa"\n' };
    if (args[0] === '-dvv') return { stderr: `Identifier=${ID}\nSignature=${fp ? 'Authority' : 'adhoc'}\n` };
    return {};
  };

  it('内側の Mach-O を先に、最後に .app を、識別子と DR つきで署名する', () => {
    const { run, calls } = fakeRunner(okResponder(FP_LC));
    signApp(certOpts, run, found);
    const signs = calls.filter((c) => c.cmd === 'codesign' && c.args.includes('--force'));
    expect(signs.map((c) => c.args[c.args.length - 1])).toEqual([found[0], found[1], app]);
    for (const c of signs) {
      expect(c.args).toContain('--keychain');
      expect(c.args[c.args.indexOf('-s') + 1]).toBe(FP_LC);
    }
    const last = signs[signs.length - 1]!.args;
    expect(last[last.indexOf('--identifier') + 1]).toBe(ID);
    expect(last[last.indexOf('--requirements') + 1]).toBe(`=designated => certificate leaf = H"${FP_LC}"`);
    expect(signs[0]!.args).not.toContain('--requirements');
  });
  it('ハードンドランタイムは付けない', () => {
    const { run, calls } = fakeRunner(okResponder(FP_LC));
    signApp(certOpts, run, found);
    expect(calls.flatMap((c) => c.args)).not.toContain('--options');
  });
  it('署名のあとで DR の確認と verify を行う', () => {
    const { run, calls } = fakeRunner(okResponder(FP_LC));
    signApp(certOpts, run, found);
    const verify = calls.find((c) => c.args.includes('--verify'))!;
    expect(verify.args).toEqual(expect.arrayContaining(['--verify', '--deep', '--strict', app]));
    expect(calls.some((c) => c.args[0] === '-d' && c.args[1] === '-r-')).toBe(true);
  });
  it('DR が期待と違えば落とす', () => {
    const { run } = fakeRunner(okResponder('f'.repeat(40)));
    expect(() => signApp(certOpts, run, found)).toThrow(/DR/);
  });
  it('識別子が期待と違えば落とす', () => {
    const { run } = fakeRunner((cmd, args) => (args[0] === '-dvv' ? { stderr: 'Identifier=hangar_desktop-abc\nSignature=Authority\n' } : okResponder(FP_LC)(cmd, args)));
    expect(() => signApp(certOpts, run, found)).toThrow(/識別子/);
  });
  it('verify が落ちれば落とす', () => {
    const { run } = fakeRunner((cmd, args) => (args.includes('--verify') ? { status: 1, stderr: 'a sealed resource is missing' } : okResponder(FP_LC)(cmd, args)));
    expect(() => signApp(certOpts, run, found)).toThrow(/verify/);
  });
  it('codesign が落ちたらそこで止まる', () => {
    const { run, calls } = fakeRunner((cmd, args) => (args.includes('--force') ? { status: 1, stderr: 'no identity found' } : {}));
    expect(() => signApp(certOpts, run, found)).toThrow(/no identity found/);
    expect(calls.filter((c) => c.args.includes('--force')).length).toBe(1);
  });
  it('ad-hoc は - で署名し、識別子だけ固定する（DR は要求しない）', () => {
    const { run, calls } = fakeRunner(okResponder(null));
    signApp({ app, mode: 'adhoc', identifier: ID }, run, found);
    const signs = calls.filter((c) => c.args.includes('--force'));
    for (const c of signs) {
      expect(c.args[c.args.indexOf('-s') + 1]).toBe('-');
      expect(c.args).not.toContain('--keychain');
    }
    const last = signs[signs.length - 1]!.args;
    expect(last).toContain('--identifier');
    expect(last).not.toContain('--requirements');
  });
  it('ad-hoc なのに ad-hoc の署名になっていなければ落とす', () => {
    const { run } = fakeRunner((cmd, args) => (args[0] === '-dvv' ? { stderr: `Identifier=${ID}\nSignature=Authority\n` } : okResponder(null)(cmd, args)));
    expect(() => signApp({ app, mode: 'adhoc', identifier: ID }, run, found)).toThrow(/ad-hoc/);
  });
  it('キーチェーンのパスワードを codesign の引数に載せない', () => {
    const { run, calls } = fakeRunner(okResponder(FP_LC));
    signApp({ ...certOpts, keychainPassword: 'sekret-pw' }, run, found);
    expect(JSON.stringify(calls.filter((c) => c.cmd === 'codesign'))).not.toContain('sekret-pw');
  });
});

describe.skipIf(!onMac)('実際の ad-hoc 署名（一時ディレクトリの小さな .app）', () => {
  const codesign = (...args: string[]): { status: number; out: string } => {
    const r = spawnSync('codesign', args, { encoding: 'utf8' });
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };

  it('Info.plist の識別子が違っていても、指定の識別子に固定され、verify が通る', () => {
    const d = tmp('hangar-sign-real-');
    dirs.push(d);
    const app = makeApp(d);
    signApp({ app, mode: 'adhoc', identifier: ID }, undefined);
    const info = codesign('-dvv', app).out;
    expect(info).toContain(`Identifier=${ID}`);
    expect(info).toContain('Signature=adhoc');
    expect(codesign('--verify', '--deep', '--strict', app).status).toBe(0);
  });
  it('内側の Mach-O を書き換えると verify が落ちる', () => {
    const d = tmp('hangar-sign-tamper-');
    dirs.push(d);
    const app = makeApp(d);
    signApp({ app, mode: 'adhoc', identifier: ID }, undefined);
    fs.appendFileSync(path.join(app, 'Contents/Resources/server/node_modules/m/a.node'), 'x');
    expect(codesign('--verify', '--deep', '--strict', app).status).not.toBe(0);
  });
  it('2 回署名しても識別子は変わらない（build ごとに変わる hangar_desktop-<ハッシュ> にならない）', () => {
    const d = tmp('hangar-sign-twice-');
    dirs.push(d);
    const a = makeApp(fs.mkdtempSync(path.join(d, '1-')));
    const b = makeApp(fs.mkdtempSync(path.join(d, '2-')));
    fs.appendFileSync(path.join(b, 'Contents/Resources/server/server.mjs'), '// 別の build\n');
    signApp({ app: a, mode: 'adhoc', identifier: ID }, undefined);
    signApp({ app: b, mode: 'adhoc', identifier: ID }, undefined);
    expect(parseDisplay(codesign('-dvv', a).out).identifier).toBe(ID);
    expect(parseDisplay(codesign('-dvv', b).out).identifier).toBe(ID);
  });
});

describe('キーチェーンを開ける', () => {
  it('パスワードが環境変数にあればそれで開け、無ければ security に端末で尋ねさせる（引数にパスワードを取らない）', () => {
    const a = fakeRunner();
    unlockKeychain({ app: '/x', mode: 'cert', identifier: ID, fingerprint: FP_LC, keychain: '/k', keychainPassword: 'pw' }, a.run);
    expect(a.calls[0]).toEqual({ cmd: 'security', args: ['unlock-keychain', '-p', 'pw', '/k'] });
    const b = fakeRunner();
    unlockKeychain({ app: '/x', mode: 'cert', identifier: ID, fingerprint: FP_LC, keychain: '/k' }, b.run);
    expect(b.calls[0]).toEqual({ cmd: 'security', args: ['unlock-keychain', '/k'] });
  });
  it('ad-hoc では何も開けない', () => {
    const a = fakeRunner();
    unlockKeychain({ app: '/x', mode: 'adhoc', identifier: ID }, a.run);
    expect(a.calls).toEqual([]);
  });
  it('開けなければ止まる', () => {
    const a = fakeRunner(() => ({ status: 1, stderr: 'bad password' }));
    expect(() => unlockKeychain({ app: '/x', mode: 'cert', identifier: ID, fingerprint: FP_LC, keychain: '/k', keychainPassword: 'pw' }, a.run)).toThrow(/bad password/);
  });
});

const script = (name: string): string => path.resolve(here, '../scripts', name);
const repoRoot = path.resolve(here, '../../..');

describe('台本の入口（CLI）', () => {
  const cli = (args: string[], env: Record<string, string> = {}): { status: number; out: string } => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', script('sign-macos.ts'), ...args], {
      encoding: 'utf8',
      cwd: path.resolve(here, '..'),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };
  it('引数が無ければ使い方を出して非 0 で終わる', () => {
    const r = cli([]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/\.app/);
  });
  it('証明書の指紋が無く --adhoc も無ければ、ad-hoc に落とさず止まる', () => {
    const d = tmp('hangar-sign-cli-');
    dirs.push(d);
    const r = cli([makeApp(d)]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/--adhoc/);
  });
  it.skipIf(!onMac)('--adhoc で署名し、識別子が tauri.conf.json のものに固定される', () => {
    const d = tmp('hangar-sign-cli-adhoc-');
    dirs.push(d);
    const app = makeApp(d);
    const r = cli([app, '--adhoc']);
    expect(r.out).toContain(ID);
    expect(r.status).toBe(0);
    const info = spawnSync('codesign', ['-dvv', app], { encoding: 'utf8' });
    expect(parseDisplay(info.stderr).identifier).toBe(ID);
  });
});

describe.skipIf(!posix)('証明書を作る台本', () => {
  const make = (args: string[], env: Record<string, string> = {}): { status: number; out: string } => {
    const r = spawnSync('bash', [script('make-signing-cert.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };
  const PW = { HANGAR_SIGN_P12_PASSWORD: 'test-only-password' };

  it('10 年より短い有効期間は断る', () => {
    const d = tmp('hangar-cert-short-');
    dirs.push(d);
    const r = make(['--out', path.join(d, 'o'), '--days', '365'], PW);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/10 年/);
  });
  it('出力先がリポジトリの中なら断る（秘密鍵を commit しない）', () => {
    const d = fs.mkdtempSync(path.join(repoRoot, 'hangar-cert-in-repo-'));
    dirs.push(d);
    const r = make(['--out', d], PW);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/リポジトリの中/);
    expect(fs.readdirSync(d)).toEqual([]);
  });
  it('パスワードを引数に取らない（--password は知らない引数）', () => {
    const d = tmp('hangar-cert-arg-');
    dirs.push(d);
    expect(make(['--out', d, '--password', 'x'], PW).status).not.toBe(0);
  });

  describe.skipIf(!onMac)('実際に作り、専用のキーチェーンで署名する', () => {
    it('p12、公開の証明書、指紋ができ、署名した .app の DR が指紋で固定される', () => {
      const d = tmp('hangar-cert-real-');
      dirs.push(d);
      const kc = path.join(d, 'test.keychain-db');
      try {
        const r = make(['--out', path.join(d, 'out'), '--keychain', kc], PW);
        expect(r.status, r.out).toBe(0);
        const fp = readFingerprintFile(path.join(d, 'out/certificate-sha1.txt'));
        expect(fp).toMatch(/^[0-9a-f]{40}$/);
        expect(fs.statSync(path.join(d, 'out/hangar-signing.p12')).mode & 0o777).toBe(0o600);
        // 有効期間は 10 年以上
        const end = spawnSync('/usr/bin/openssl', ['x509', '-inform', 'DER', '-in', path.join(d, 'out/hangar-signing.cer'), '-noout', '-enddate'], { encoding: 'utf8' }).stdout;
        const years = (Date.parse(end.replace('notAfter=', '').trim()) - Date.now()) / (365.25 * 86400e3);
        expect(years).toBeGreaterThan(10);

        const app = makeApp(d);
        const opts = { app, mode: 'cert' as const, identifier: ID, fingerprint: fp!, keychain: kc, keychainPassword: PW.HANGAR_SIGN_P12_PASSWORD };
        unlockKeychain(opts);
        const sh = (cmd: string, args: string[]): string => { const x = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }); return `$ ${cmd} ${args.join(' ')} -> ${x.status}\n${x.stdout}${x.stderr}`; };
        if (process.env.CI) {
          const cer = path.join(d, 'out/hangar-signing.cer');
          const logA = sh('sudo', ['-n', 'security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-p', 'codeSign', '-k', '/Library/Keychains/System.keychain', cer]);
          const validA = sh('security', ['find-identity', '-v', '-p', 'codesigning', kc]);
          const logB = '';
          console.log(`TRUSTEXP\n${logA}\n${validA}\n${logB}`);
        }
        const diag = (): string => ['find-identity -p codesigning', 'find-identity', 'list-keychains -d user', 'show-keychain-info'].map((a) => { const x = spawnSync('security', [...a.split(' '), ...(a.startsWith('find') || a.startsWith('show') ? [kc] : [])], { encoding: 'utf8' }); return `$ security ${a}\n${x.stdout}${x.stderr}`; }).join('\n');
        try { signApp(opts); } catch (e) { throw new Error(`${(e as Error).message}\n${diag()}`); }
        const dr = spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' });
        expect(`${dr.stdout}${dr.stderr}`).toContain(`designated => certificate leaf = H"${fp}"`);
        // 内容の違う 2 回目の build でも DR は同じ
        const app2 = makeApp(fs.mkdtempSync(path.join(d, 'b-')));
        fs.appendFileSync(path.join(app2, 'Contents/Resources/server/server.mjs'), '// 別の build\n');
        signApp({ ...opts, app: app2 });
        const dr2 = spawnSync('codesign', ['-d', '-r-', app2], { encoding: 'utf8' });
        expect(`${dr2.stdout}${dr2.stderr}`).toContain(`designated => certificate leaf = H"${fp}"`);
        // 既にあるものは上書きしない
        expect(make(['--out', path.join(d, 'out')], PW).status).not.toBe(0);
      } finally {
        spawnSync('security', ['delete-keychain', kc]);
      }
    });
  });
});
