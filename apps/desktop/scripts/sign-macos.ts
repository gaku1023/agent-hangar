import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * macOS の .app に署名する（段 5 の 5-1）。
 *
 * 目的は 2 つで、署名の識別子（tauri.conf.json の identifier）と、designated requirement（DR）を固定することである。
 * macOS のローカルネットワークの許可は署名の識別子で引かれる。
 * 署名しない Tauri の build は識別子が `hangar_desktop-<ハッシュ>` で build ごとに変わるので、入れ替えるたびに許可が外れていた。
 * ファイルなどほかの許可は DR で引かれるので、DR は葉の証明書の指紋（SHA-1）で固定する。
 *
 * 2 つの道がある。
 * - 証明書（既定）：キーチェーンの自作の証明書で署名し、DR を `certificate leaf = H"<指紋>"` に固定する。
 * - ad-hoc（`--adhoc`）：証明書が無い開発者の手元で、識別子だけを固定する。DR は build ごとに変わるので、識別子以外の許可は保たれない。
 *
 * 内側の Mach-O から外側へ署名し、`--deep` には頼らない。ハードンドランタイムは付けない（公証をしないので要らず、Node の JIT の entitlement も要らない）。
 * 秘密（キーチェーンのパスワード）は引数に取らず、環境変数か、端末の対話で受け取る。
 */

export type Mode = 'cert' | 'adhoc';

export type SignOptions = {
  app: string;
  mode: Mode;
  identifier: string;
  /** 葉の証明書の SHA-1（小文字の 40 桁）。mode が cert のとき必須。 */
  fingerprint?: string;
  /** 秘密鍵の入ったキーチェーン。mode が cert のとき必須。 */
  keychain?: string;
  /** キーチェーンのパスワード。codesign の引数には載せない。 */
  keychainPassword?: string;
};

export type RunResult = { status: number; stdout: string; stderr: string };
export type Runner = (cmd: string, args: string[], opts?: { inheritStdio?: boolean }) => RunResult;

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONF = path.resolve(here, '../src-tauri/tauri.conf.json');
/** リポジトリに置く指紋の置き場（公開の値だけ）。環境変数 HANGAR_SIGN_CERT_SHA1 が先に効く。 */
export const DEFAULT_FINGERPRINT_FILE = path.resolve(here, '../signing/certificate-sha1.txt');

/** tauri.conf.json の identifier。署名の識別子はこれに合わせる。 */
export function readIdentifier(confPath: string = DEFAULT_CONF): string {
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8')) as { identifier?: unknown };
  if (typeof conf.identifier !== 'string' || conf.identifier === '') throw new Error(`${confPath} に identifier が無い`);
  return conf.identifier;
}

/** コロンや空白を除き、小文字の 40 桁（SHA-1）に直す。 */
export function normalizeFingerprint(s: string): string {
  const v = s.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(v)) throw new Error('証明書の指紋は SHA-1 の 40 桁の 16 進で渡す');
  return v;
}

/** 指紋の置き場の最初の値。# の行と空行は読み飛ばす。ファイルが無い、値が無いときは undefined。 */
export function readFingerprintFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    return normalizeFingerprint(t);
  }
  return undefined;
}

/** DR の式。葉の証明書そのもので縛る。作り直した証明書は別の身元になる。 */
export function designatedRequirement(fingerprint: string): string {
  return `certificate leaf = H"${normalizeFingerprint(fingerprint)}"`;
}

/** `codesign -d -r-` が出す行。署名のあとの確かめに使う。 */
export function expectedDrLine(fingerprint: string): string {
  return `designated => ${designatedRequirement(fingerprint)}`;
}

/** `codesign -dvv` の出力から、確かめに使う欄だけを読む。 */
export function parseDisplay(out: string): { identifier?: string; signature?: string } {
  const get = (k: string): string | undefined => out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim();
  return { identifier: get('Identifier'), signature: get('Signature') };
}

export type ParseDefaults = { identifier: string; fingerprintFile: string };

/**
 * 引数と環境変数を読む。
 * 環境変数：HANGAR_SIGN_CERT_SHA1（指紋）、HANGAR_SIGN_KEYCHAIN（キーチェーンのパス）、HANGAR_SIGN_KEYCHAIN_PASSWORD（任意）。
 * 指紋が環境変数に無ければ、リポジトリの置き場を読む。証明書が無いときに黙って ad-hoc に落とさない（身元が弱くなるので、`--adhoc` を明示させる）。
 */
export function parseArgs(argv: string[], env: Record<string, string | undefined>, defaults: ParseDefaults): SignOptions {
  let app: string | undefined;
  let adhoc = false;
  for (const a of argv) {
    if (a === '--adhoc') adhoc = true;
    else if (a.startsWith('-')) throw new Error(`知らない引数: ${a}`);
    else if (app === undefined) app = a;
    else throw new Error(`app が 2 つ渡された: ${app}, ${a}`);
  }
  if (!app) throw new Error('署名する .app のパスを渡す（例: sign-macos.ts path/to/Hangar.app [--adhoc]）');
  // 動いているアプリや、入れ済みのアプリを直接書き換えない。build の出力に署名してから入れる。
  const abs = path.resolve(app);
  if (abs === '/Applications' || abs.startsWith('/Applications/')) throw new Error('/Applications の中は直接署名しない。build の出力に署名してから入れる');
  const base = { app, identifier: defaults.identifier };
  if (adhoc) return { ...base, mode: 'adhoc' };

  const fromEnv = env.HANGAR_SIGN_CERT_SHA1;
  const fingerprint = fromEnv ? normalizeFingerprint(fromEnv) : readFingerprintFile(defaults.fingerprintFile);
  if (!fingerprint) {
    throw new Error('証明書の指紋が無い。HANGAR_SIGN_CERT_SHA1 を渡すか、証明書が無い開発者の手元なら --adhoc で識別子だけ固定する');
  }
  const keychain = env.HANGAR_SIGN_KEYCHAIN;
  if (!keychain) throw new Error('秘密鍵の入ったキーチェーンのパスを HANGAR_SIGN_KEYCHAIN で渡す');
  return { ...base, mode: 'cert', fingerprint, keychain, keychainPassword: env.HANGAR_SIGN_KEYCHAIN_PASSWORD || undefined };
}

const MACHO_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']);

function isMachO(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    return MACHO_MAGICS.has(buf.toString('hex'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * .app の中の Mach-O（.node、.dylib、spawn-helper、主の実行ファイル）を、深いところから先に並べる。
 * 外側の署名はこれらの内容のハッシュを封じるので、内側を先に署名する。シンボリックリンクはたどらない。
 */
export function findMachOs(app: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && isMachO(p)) out.push(p);
    }
  };
  walk(path.join(app, 'Contents'));
  const depth = (p: string): number => p.split(path.sep).length;
  return out.sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

export const defaultRun: Runner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, opts?.inheritStdio ? { stdio: 'inherit', encoding: 'utf8' } : { encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * キーチェーンを開ける。
 * パスワードが環境変数にあればそれを使う（security の -p は引数に載るので、CI のように 1 人しか使わない機械の話である）。
 * 無ければ、security 自身に端末で尋ねさせる（この台本はパスワードを受け取らない）。
 */
export function unlockKeychain(opts: SignOptions, run: Runner = defaultRun): void {
  if (opts.mode !== 'cert' || !opts.keychain) return;
  const r = opts.keychainPassword
    ? run('security', ['unlock-keychain', '-p', opts.keychainPassword, opts.keychain])
    : run('security', ['unlock-keychain', opts.keychain], { inheritStdio: true });
  if (r.status !== 0) throw new Error(`キーチェーンを開けない: ${opts.keychain}\n${r.stderr}`);
}

/**
 * 署名して、確かめる。確かめに通らなければ投げる。
 * `run` と `machOs` は試験のために差し替えられる。
 */
export function signApp(opts: SignOptions, run: Runner = defaultRun, machOs: string[] = findMachOs(opts.app)): void {
  const identity = opts.mode === 'adhoc' ? '-' : opts.fingerprint;
  if (!identity) throw new Error('証明書の指紋が無い');
  const base = ['--force', ...(opts.mode === 'cert' && opts.keychain ? ['--keychain', opts.keychain] : []), '-s', identity];
  const codesign = (args: string[]): RunResult => {
    const r = run('codesign', args);
    if (r.status !== 0) throw new Error(`codesign が失敗した（${args[args.length - 1]}）\n${r.stderr}`);
    return r;
  };

  // 内側から外側へ
  for (const f of machOs) codesign([...base, f]);
  const outer = [...base, '--identifier', opts.identifier];
  if (opts.mode === 'cert') outer.push('--requirements', `=${expectedDrLine(opts.fingerprint!)}`);
  codesign([...outer, opts.app]);

  // 確かめ。違えば、身元が黙って変わるのを止めるために落とす
  const display = parseDisplay(run('codesign', ['-dvv', opts.app]).stderr);
  if (display.identifier !== opts.identifier) throw new Error(`署名の識別子が違う（期待 ${opts.identifier}、実際 ${display.identifier ?? '無し'}）`);
  if (opts.mode === 'adhoc') {
    if (display.signature !== 'adhoc') throw new Error(`ad-hoc の署名になっていない（Signature=${display.signature ?? '無し'}）`);
  } else {
    const dr = run('codesign', ['-d', '-r-', opts.app]);
    const want = expectedDrLine(opts.fingerprint!);
    const got = `${dr.stdout}\n${dr.stderr}`.split('\n').map((l) => l.replace(/^#\s*/, '').trim()).find((l) => l.startsWith('designated =>'));
    if (got !== want) throw new Error(`DR が期待と違う\n期待: ${want}\n実際: ${got ?? '無し'}`);
  }
  const v = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', opts.app]);
  if (v.status !== 0) throw new Error(`codesign --verify が通らない\n${v.stderr}`);
}

// `node --import tsx scripts/sign-macos.ts <Hangar.app> [--adhoc]` として直接呼ばれたときだけ実行する。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2), process.env, { identifier: readIdentifier(), fingerprintFile: DEFAULT_FINGERPRINT_FILE });
    unlockKeychain(opts);
    signApp(opts);
    const dr = opts.mode === 'cert' ? expectedDrLine(opts.fingerprint!) : '（ad-hoc：DR は build ごとに変わる。識別子だけ固定した）';
    console.log(`署名した: ${opts.app}\n識別子: ${opts.identifier}\nDR: ${dr}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
