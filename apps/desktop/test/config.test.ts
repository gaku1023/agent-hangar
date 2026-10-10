import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_DROPPED_ENV } from '../../../packages/server/src/launch/env.ts';
import { COMPAT_VERSION } from '../../../packages/shared/src/compat.ts';
import { LANGUAGES } from '../../../packages/shared/src/i18n/language.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(app, p), 'utf8');

// Tauri は tauri.windows.conf.json を、Windows のビルドのときだけ tauri.conf.json に重ねる（JSON merge patch。配列は丸ごと置き換わる）。
// macOS の配布（.app だけ）を変えずに、Windows の配布物を NSIS の 1 本に決めるための置き場である（段 6 の 6-8）。
describe('tauri.windows.conf.json', () => {
  const win = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
  it('配布物は NSIS の 1 本で、管理者権限を要らないユーザー単位のインストールにする', () => {
    expect(win.bundle.targets).toEqual(['nsis']);
    expect(win.bundle.windows.nsis.installMode).toBe('currentUser');
    // 署名はしない（利用者の決定）。署名の設定が紛れ込んで、鍵の無い CI を落とさないようにする。
    expect(win.bundle.windows.certificateThumbprint).toBeUndefined();
    expect(win.bundle.windows.signCommand).toBeUndefined();
    expect(win.bundle.createUpdaterArtifacts).toBeUndefined();
  });
  it('macOS の設定を変えない（.app だけ、重ねるのは Windows のビルドのときだけ）', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    expect(conf.bundle.targets).toEqual(['app']);
    expect(conf.bundle.windows).toBeUndefined();
    // 重ねる側が、読み込み画面や同梱サーバの置き場まで書き換えていない。重ねるのは配布物と窓の装飾だけである。
    expect(Object.keys(win).sort()).toEqual(['$schema', 'app', 'bundle']);
    expect(Object.keys(win.app)).toEqual(['windows']);
    expect(Object.keys(win.bundle).sort()).toEqual(['targets', 'windows']);
    // macOS の窓は、信号の 3 点をヘッダに重ねる装飾のまま。
    expect(conf.app.windows[0]).toMatchObject({ titleBarStyle: 'Overlay', hiddenTitle: true, trafficLightPosition: { x: 11, y: 24 } });
  });
  // titleBarStyle、hiddenTitle、trafficLightPosition は macOS の装飾である。Windows では標準の枠（タイトルバーと閉じるなどのボタン）にする。
  // 配列は丸ごと置き換わるので、窓の名前と大きさは tauri.conf.json の写しを持つ。片方だけ変えるとここが落ちる。
  it('Windows の窓は標準の枠にし、名前と大きさは macOS の窓と同じにする', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    expect(win.app.windows).toHaveLength(1);
    const { titleBarStyle, hiddenTitle, trafficLightPosition, ...shared } = conf.app.windows[0];
    expect([titleBarStyle, hiddenTitle, trafficLightPosition]).not.toContain(undefined);
    expect(win.app.windows[0]).toEqual({ ...shared, decorations: true });
  });
});

// 殻は起動のたびに、トーストのための登録（AppUserModelId と COM の口の CLSID）と絵（notify-icon.png）を利用者の領域へ書く（notify.rs の mod toast）。
// アンインストールで消さないと、消したあとも登録が残る。消す側（NSIS のフック）の値が、書く側の定数と食い違わないことを見る。
describe('NSIS のアンインストールの後片付け', () => {
  const win = JSON.parse(read('src-tauri/tauri.windows.conf.json'));
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const hooksPath = win.bundle.windows.nsis.installerHooks as string;
  /** NSIS_HOOK_POSTUNINSTALL の本体（macro と macroend の間）。 */
  const body = () => {
    const m = /!macro NSIS_HOOK_POSTUNINSTALL\r?\n([\s\S]*?)!macroend/.exec(read(path.join('src-tauri', hooksPath)));
    expect(m, 'NSIS_HOOK_POSTUNINSTALL が見つかりません').not.toBeNull();
    return m![1]!;
  };
  /** notify.rs の定数。`0x1ce6ab2a_d79d_49f4_88b0_5a9e624a75e4` を `{1CE6AB2A-D79D-49F4-88B0-5A9E624A75E4}` にする。 */
  const clsid = () => {
    const m = /ACTIVATOR_CLSID: u128 = 0x([0-9a-f_]+);/.exec(read('src-tauri/src/notify.rs'));
    expect(m, 'ACTIVATOR_CLSID が見つかりません').not.toBeNull();
    const h = m![1]!.replaceAll('_', '').toUpperCase();
    return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
  };
  it('設定がフックの .nsh を指し、実在する', () => {
    expect(hooksPath).toBeTruthy();
    expect(fs.existsSync(path.join(app, 'src-tauri', hooksPath))).toBe(true);
  });
  it('AppUserModelId の登録を、書く側と同じ名前（identifier）で消す', () => {
    expect(body()).toContain(`DeleteRegKey HKCU "Software\\Classes\\AppUserModelId\\${conf.identifier}"`);
  });
  it('COM の口の CLSID の登録を、書く側の定数と同じ値で消す', () => {
    expect(body()).toContain(`DeleteRegKey HKCU "Software\\Classes\\CLSID\\${clsid()}"`);
  });
  it('トーストの絵だけを消し、利用者のデータ（~\\.agent-hangar の DB など）は消さない', () => {
    const b = body();
    expect(b).toContain('Delete "$PROFILE\\.agent-hangar\\notify-icon.png"');
    expect(b).not.toMatch(/RMDir/i);
    expect(b).not.toMatch(/Delete\s+"[^"]*\*/);
    expect(b).not.toMatch(/\.db/);
  });
});

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
  // 入力待ちの通知は、頁が WebSocket で受けて殻の notify_waiting を呼ぶ。
  // WKWebView は窓が隠れると既定で頁を止める（suspend）ので、最小化している間に入力待ちを受けても通知を呼べない。
  // throttle は止めずに絞るだけで、電池への響きは disabled より小さい。効くのは macOS 14 から（wry の with_background_throttling）。
  // Windows の WebView2 には効かない。頁が Web Lock を握って凍らないようにする（packages/ui/src/runtime/notifier.ts の holdPageAwake）。
  it('窓が隠れても頁を止めず、絞るだけにする（macOS の入力待ちの通知のため）', () => {
    expect(conf.app.windows[0].backgroundThrottling).toBe('throttle');
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
  // 自動更新（段 5-4）。目録は GitHub の Release の最新から引き、更新物は minisign の公開鍵で確かめる。
  // 公開鍵は本物の鍵のもので、秘密鍵は CI の secret だけにある。
  it('updater は Release の最新の目録を https で引き、公開鍵で更新物を確かめる', () => {
    const u = conf.plugins.updater;
    expect(u.endpoints).toEqual(['https://github.com/gaku1023/agent-hangar/releases/latest/download/latest.json']);
    expect(typeof u.pubkey).toBe('string');
    // tauri signer generate の公開鍵は、minisign の公開鍵のファイルを base64 にしたものである。
    expect(Buffer.from(u.pubkey, 'base64').toString('utf8')).toMatch(/^untrusted comment: minisign public key: [0-9A-F]{16}\nRW[A-Za-z0-9+/=]+\n$/);
    expect(u.windows).toEqual({ installMode: 'passive' });
    // 危ない緩めは入れない。
    expect(u.dangerousInsecureTransportProtocol).toBeUndefined();
    expect(u.dangerousAcceptInvalidCerts).toBeUndefined();
    expect(u.allowDowngrades).toBeUndefined();
  });
  // 更新物の署名には秘密鍵が要る。手元と ci の build は鍵を持たないので、更新物づくりは release.yml が --config で入れる。
  it('更新物づくり（createUpdaterArtifacts）は設定に書かず、release.yml だけが入れる', () => {
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
    // 重ねる側は更新物づくりだけを入れる。
    expect(JSON.parse(read('src-tauri/tauri.updater.conf.json'))).toEqual({ $schema: 'https://schema.tauri.app/config/2', bundle: { createUpdaterArtifacts: true } });
    const release = fs.readFileSync(path.resolve(app, '../../.github/workflows/release.yml'), 'utf8');
    const action = fs.readFileSync(path.resolve(app, '../../.github/actions/windows-installer/action.yml'), 'utf8');
    expect(release).toContain('--config src-tauri/tauri.updater.conf.json');
    expect(action).toContain("'--config', 'src-tauri/tauri.updater.conf.json'");
    expect(release).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY');
    expect(release).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    expect(release).toContain('latest.json');
  });
});

// 殻が resource_dir（Windows では \\?\ 付き）から作ったパスで Node を起こす経路は、同梱の hangar.cmd では通らない。
// 0.2.0-rc.1 はこの経路で起動しなかったので、入れた殻そのものを起こして /health が応えるまで見る段を外さない。
describe('Windows のインストーラの action', () => {
  const action = fs.readFileSync(path.resolve(app, '../../.github/actions/windows-installer/action.yml'), 'utf8');
  it('入れた殻を起こし、同梱のサーバが /health に応えるまで待ってから止める', () => {
    expect(action).toContain("http://127.0.0.1:4177/health");
    expect(action).toMatch(/\$app = Start-Process -FilePath \$exe\.FullName -PassThru/);
    expect(action).toContain('Stop-Process -Id $app.Id -Force');
    // 止めるのはアンインストールの前でなければならない（動いている殻の exe は消せない）。
    expect(action.indexOf('Stop-Process -Id $app.Id')).toBeLessThan(action.indexOf("'uninstall.exe') -ArgumentList"));
  });
  // 殻は Node を公式の入れ先から PATH より先に探すので、放っておくとランナーに初めから入っている Node を使う。
  // その版が 22.20 より古いと、verbatim のパスで落ちる回帰をこの段では捕まえられない。
  // 一時のホームの settings.json の nodePath で setup-node の Node を指し、殻が使った版を確かめる。
  it('殻には一時のホームで setup-node の Node を使わせ、その版が 22.20 以上であることを確かめる', () => {
    expect(action).toContain('$env:HANGAR_HOME = $tmpHome');
    expect(action).toMatch(/nodePath = \$node/);
    expect(action).toContain("[version]'22.20.0'");
    // 確かめるのは殻が実際に使った Node で、desktop.log の起動の行から読む。
    expect(action).toContain(String.raw`'\[desktop\] node (.+) server '`);
    // 一時のホームは殻を起こす前に作り、起こしたあとは元に戻す。
    expect(action.indexOf('$env:HANGAR_HOME = $tmpHome')).toBeLessThan(action.indexOf('$app = Start-Process'));
    expect(action.indexOf('Remove-Item Env:HANGAR_HOME')).toBeGreaterThan(action.indexOf('$app = Start-Process'));
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
  // ロゴは 128px（2026-09-30 に 96 / 128 / 160 / 200px を試作で比べて決めた）。
  // 読み込みが済むまでの静止画と、動き始めてからの絵を同じ大きさにし、差し替わるときに跳ねないようにする。
  it('起動画面のロゴは、静止画も動く絵も 128px にする', () => {
    expect(read('loading/index.html')).toContain('<img id="logo" src="logo.svg" width="128" height="128" alt="" />');
    const js = read('loading/boot.js');
    expect(js).toContain("svg.setAttribute('width', String(LOGO));");
    expect(js).toContain("svg.setAttribute('height', String(LOGO));");
    expect(js).toContain('const LOGO = 128;');
  });
  // ロゴの中心を窓の中心に置く。名前と文は流れから外してロゴの下に下げる。
  // 失敗は 1 枚の札（#fail）で出し、そのとき読み込みの絵（main）ごと退ける。
  it('起動画面は、ロゴだけで真ん中を決め、名前と文をその下に下げる', () => {
    const html = read('loading/index.html');
    expect(html).toMatch(/<main>\s*<img id="logo"[^>]*>\s*<div class="caption">\s*<h1>Hangar<\/h1>\s*<p id="status">/);
    expect(html).toContain('.caption { position: absolute; top: 100%;');
    expect(html).not.toContain("main:has(#status[data-level='error'])");
    expect(html).not.toMatch(/main \{[^}]*white-space/);
  });
  // macOS の窓の左上には信号の 3 点が重なる。失敗の札のロゴは、UI のヘッダーの左の空き（--lights-end）と同じだけ右に置く。
  // Windows の窓は標準の枠で、窓の中に信号は無い。殻は印を付けないので、UI の既定（--head-lead、16px）と同じ位置から始める。
  it('失敗の札のロゴは、macOS の殻の中では信号の 3 点の右（--lights-end）から、それ以外では 16px から始める', () => {
    const tokens = fs.readFileSync(path.resolve(app, '../../packages/ui/src/styles/tokens.css'), 'utf8');
    const lights = tokens.match(/--lights-end: (\d+)px;/)?.[1];
    expect(lights).toBeDefined();
    const html = read('loading/index.html');
    expect(html).toContain('.fail-brand { position: fixed; left: 16px;');
    expect(html).toContain(`[data-shell='desktop'] .fail-brand { left: ${lights}px; }`);
  });
  // 札の操作の並びは Tab の順（命令のコピー、詳細、全文をコピー、ログを開く、もう一度試す）で、DOM もこの順に置く。
  it('失敗の札の操作は、DOM を Tab の順に置く', () => {
    const html = read('loading/index.html');
    const at = ['fail-command-copy', 'fail-detail', 'fail-copy-all', 'boot-log', 'boot-retry'].map((id) => html.indexOf(`<${id.startsWith('fail-detail') ? 'pre' : 'button'} id="${id}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  // 殻は準備ができたら合図の口を呼び、光が満ち切るまで待ってから画面を移す。
  // 口の名前が食い違うと合図が打たれず、長さが食い違うと光が満ちる途中で画面が替わる。
  it('殻が呼ぶ合図の口（__hangarBootFinish）を、起動画面が持つ', () => {
    const rust = read('src-tauri/src/lib.rs').match(/const BOOT_FINISH_JS: &str = "([^"]+)";/)?.[1];
    expect(rust).toBe('window.__hangarBootFinish && window.__hangarBootFinish()');
    expect(read('loading/boot.js')).toContain('window.__hangarBootFinish = ');
  });
  // 殻は索引づけが済むまで起動画面に残り、その進み具合を渡す。口の名前が食い違うと、件数が出ないまま待たされる。
  it('殻が進み具合を渡す口（__hangarBootProgress）を、起動画面が持つ', () => {
    expect(read('src-tauri/src/lib.rs')).toContain('"window.__hangarBootProgress && window.__hangarBootProgress({{');
    expect(read('loading/boot.js')).toContain('window.__hangarBootProgress = ');
  });
  // 殻は起動の失敗を、種類と数だけ決まった式で渡す。口の名前が食い違うと、札が出ないまま読み込み中の絵が残る。
  it('殻が失敗を渡す口（__hangarBootFail）を、起動画面が持つ', () => {
    expect(read('src-tauri/src/bootfail.rs')).toContain('"window.__hangarBootFail && window.__hangarBootFail({})"');
    expect(read('loading/boot.js')).toContain('window.__hangarBootFail = ');
  });
  // 札の種類は、殻（bootfail.rs の KINDS）と頁の表（boot-fail.js の FAIL_KINDS）と、サーバが書く 4 種類（bootError.ts）で揃える。
  it('失敗の種類は、殻と頁の表で同じ並びで、サーバが書く種類はその部分になる', async () => {
    const rust = [...(read('src-tauri/src/bootfail.rs').match(/pub const KINDS: &\[&str\] = &\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    const page = (await import(pathToFileURL(path.join(app, 'loading', 'boot-fail.js')).href)) as { FAIL_KINDS: string[] };
    expect(rust.length).toBeGreaterThan(0);
    expect(rust).toEqual(page.FAIL_KINDS);
    const serverSource = fs.readFileSync(path.resolve(app, '../../packages/server/src/boot/bootError.ts'), 'utf8');
    const written = [...(serverSource.match(/export type BootErrorKind = ([^;]+);/)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    expect(written).toHaveLength(4);
    for (const k of written) expect(page.FAIL_KINDS).toContain(k);
    // サーバが書かない 2 種類は、殻が決める。
    expect(page.FAIL_KINDS.filter((k) => !written.includes(k)).sort()).toEqual(['compat-mismatch', 'other']);
    // 殻が読むファイルの名前は、サーバが書く名前と同じ。
    const file = serverSource.match(/export const BOOT_ERROR_FILE = '([^']+)'/)?.[1];
    expect(file).toBeDefined();
    expect(read('src-tauri/src/bootfail.rs')).toContain(`pub const BOOT_ERROR_FILE: &str = "${file}";`);
  });
  // 頁の言語は、設定の言語（shared の LANGUAGES）と同じで、先頭が既定である。
  it('失敗の札の言語は、shared の LANGUAGES と同じ', async () => {
    const page = (await import(pathToFileURL(path.join(app, 'loading', 'boot-fail.js')).href)) as { LANGS: string[] };
    expect(page.LANGS).toEqual([...LANGUAGES]);
  });
  it('殻が待つ長さ（lib.rs の BOOT_FINISH_MS）は、合図と光が満ちる長さ（boot-frames.js の FINISH_MS）と同じ', () => {
    const rust = read('src-tauri/src/lib.rs').match(/const BOOT_FINISH_MS: u64 = (\d+);/)?.[1];
    const js = read('loading/boot-frames.js').match(/export const FINISH_MS = (\d+);/)?.[1];
    expect(rust).toBeDefined();
    expect(rust).toBe(js);
  });
});

describe('capabilities', () => {
  const dir = path.join(app, 'src-tauri', 'capabilities');
  const cap = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  it('置くのは既定と、窓を動かすためと、入力待ちを知らせるためと、起動画面の操作と、UI から殻に頼む操作と、フォルダの選択と、設定の同期の適用と、更新の 8 つだけ', () => {
    expect(fs.readdirSync(dir).sort()).toEqual(['boot-screen.json', 'default.json', 'remote-config-apply.json', 'remote-drag.json', 'remote-notify.json', 'remote-pick-folder.json', 'remote-shell.json', 'remote-update.json']);
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
  // 入力待ちの知らせのために、通知を出す、通知の許可を求める、通知の許可の状態を読む、Dock のバッジに数を出すの 4 つだけを足す。
  it('UI の出どころには、入力待ちの通知と Dock のバッジの 4 つだけ与える', () => {
    const c = cap('remote-notify.json');
    expect(c.windows).toEqual(['main']);
    expect(c.remote).toEqual({ urls: ['http://127.0.0.1:4177/*'] });
    expect(c.permissions).toEqual(['allow-notify-waiting', 'allow-notify-request', 'allow-notify-status', 'core:window:allow-set-badge-count']);
  });
  // 権限の出どころのポートと、殻がサーバを立てるポートは別のファイルにある。片方だけ変えると、ヘッダを掴んでも窓が動かなくなる。
  it('権限の出どころのポートは、殻がサーバを立てるポート（server.rs の PORT）と同じ', () => {
    const port = read('src-tauri/src/server.rs').match(/pub const PORT: u16 = (\d+);/)?.[1];
    expect(port).toBeDefined();
    expect(cap('remote-drag.json').remote.urls).toEqual([`http://127.0.0.1:${port}/*`]);
    expect(cap('remote-notify.json').remote.urls).toEqual([`http://127.0.0.1:${port}/*`]);
    expect(cap('remote-shell.json').remote.urls).toEqual([`http://127.0.0.1:${port}/*`]);
    expect(cap('remote-pick-folder.json').remote.urls).toEqual([`http://127.0.0.1:${port}/*`]);
    expect(cap('remote-config-apply.json').remote.urls).toEqual([`http://127.0.0.1:${port}/*`]);
    expect(cap('remote-update.json').remote.urls).toEqual([`http://127.0.0.1:${port}/*`]);
  });
  // 殻のコマンドの名前は、殻（build.rs と lib.rs）と画面（notifier.ts）に分かれている。
  // 片方だけ変えると、通知が黙って出なくなる。
  it('画面が呼ぶ殻のコマンドは、殻が並べて登録したものと同じ', () => {
    const ui = fs.readFileSync(path.resolve(app, '../../packages/ui/src/runtime/notifier.ts'), 'utf8');
    const build = read('src-tauri/build.rs');
    const lib = read('src-tauri/src/lib.rs');
    for (const cmd of ['notify_waiting', 'notify_request', 'notify_status']) {
      expect(ui).toContain(`'${cmd}'`);
      expect(build).toContain(`"${cmd}"`);
      expect(lib).toMatch(new RegExp(`generate_handler!\\[[^\\]]*\\b${cmd}\\b`));
    }
    expect(ui).toContain("'plugin:window|set_badge_count'");
  });
  // 起動画面は殻の中の頁（tauri://localhost）なので、remote を持たない。もう一度試すは起動画面からだけ呼べる。
  it('起動画面には、もう一度試すとログを開くだけを与える', () => {
    const c = cap('boot-screen.json');
    expect(c.windows).toEqual(['main']);
    expect(c.remote).toBeUndefined();
    expect(c.permissions).toEqual(['allow-retry-boot', 'allow-open-log']);
  });
  // サーバの頁から頼めるのは、ログを開くことと、アプリの再起動だけにする。起動のやり直しは与えない。
  it('UI の出どころには、ログを開くと再起動だけを与える', () => {
    const c = cap('remote-shell.json');
    expect(c.windows).toEqual(['main']);
    expect(c.permissions).toEqual(['allow-open-log', 'allow-restart-app']);
  });
  // フォルダの選択は、プロジェクトを作るダイアログの「ほかの場所を選ぶ…」だけが使う。プラグインの JS の権限は与えない。
  it('UI の出どころには、フォルダの選択だけを別に与える', () => {
    const c = cap('remote-pick-folder.json');
    expect(c.windows).toEqual(['main']);
    expect(c.remote).toEqual({ urls: ['http://127.0.0.1:4177/*'] });
    expect(c.permissions).toEqual(['allow-pick-folder']);
  });
  // 設定の同期の適用と世代へ戻す操作は、どちらも殻がネイティブの確認を出し、承諾されたときだけ CLI（hangar config）を走らせる。
  // 頁から渡せるのは、戻す世代の名前だけで、殻が形を確かめる。サーバは `~/.claude` に書かない（D9）。
  it('UI の出どころには、設定の同期の適用と世代へ戻す 2 つだけを別に与える', () => {
    const c = cap('remote-config-apply.json');
    expect(c.windows).toEqual(['main']);
    expect(c.remote).toEqual({ urls: ['http://127.0.0.1:4177/*'] });
    expect(c.permissions).toEqual(['allow-apply-config-sync', 'allow-restore-config-sync']);
  });
  // 更新は殻の 4 つの命令だけで行う。プラグインの JS の権限（updater:default）は与えず、目録の URL も頁からは変えられない。
  it('UI の出どころには、更新の確認、進み、取得、インストールの 4 つだけを別に与える', () => {
    const c = cap('remote-update.json');
    expect(c.windows).toEqual(['main']);
    expect(c.remote).toEqual({ urls: ['http://127.0.0.1:4177/*'] });
    expect(c.permissions).toEqual(['allow-update-status', 'allow-update-check', 'allow-update-download', 'allow-update-install']);
    for (const f of fs.readdirSync(dir)) expect(JSON.stringify(cap(f))).not.toContain('updater:');
  });
  it('設定の同期の命令は、確認を出してから CLI を走らせ、書く操作を殻の中で完結させない', () => {
    const lib = read('src-tauri/src/lib.rs');
    // 確認を出す前に --plan で見立てだけを取り、承諾のあとにだけ --yes を渡す。
    const apply = lib.slice(lib.indexOf('fn apply_config_flow'), lib.indexOf('fn restore_config_flow'));
    expect(apply.indexOf('"--plan"')).toBeGreaterThan(-1);
    expect(apply.indexOf('"--plan"')).toBeLessThan(apply.indexOf('confirm_natively'));
    expect(apply.indexOf('confirm_natively')).toBeLessThan(apply.indexOf('"--yes"'));
    expect(apply).toContain('"--order"');
    const restore = lib.slice(lib.indexOf('fn restore_config_flow'), lib.indexOf('async fn apply_config_sync'));
    expect(restore.indexOf('valid_generation_name')).toBeLessThan(restore.indexOf('"--yes"'));
    expect(restore.indexOf('confirm_natively')).toBeLessThan(restore.indexOf('"--yes"'));
  });
  // 命令の名前は、build.rs の一覧、lib.rs の #[tauri::command]、UI と起動画面の呼び出しの 4 か所にある。
  // 入力待ちの知らせの 3 つは、上の notifier.ts との突き合わせでも確かめる。
  it('殻の命令の名前は、build.rs と lib.rs と UI と起動画面でそろっている', () => {
    const listed = [...(read('src-tauri/build.rs').match(/const COMMANDS: &\[&str\] = &\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(['apply_config_sync', 'notify_request', 'notify_status', 'notify_waiting', 'open_log', 'pick_folder', 'restart_app', 'restore_config_sync', 'retry_boot', 'update_check', 'update_download', 'update_install', 'update_status']);
    const defined = [...read('src-tauri/src/lib.rs').matchAll(/#\[tauri::command\]\s*(?:pub )?(?:async )?fn ([a-z_]+)/g)].map((m) => m[1]).sort();
    expect(defined).toEqual(listed);
    const ui = fs.readFileSync(path.resolve(app, '../../packages/ui/src/runtime/desktop.ts'), 'utf8');
    expect(ui).toContain("openLog: 'open_log'");
    expect(ui).toContain("restart: 'restart_app'");
    expect(ui).toContain("pickFolder: 'pick_folder'");
    for (const [k, cmd] of [['status', 'update_status'], ['check', 'update_check'], ['download', 'update_download'], ['install', 'update_install']]) expect(ui).toContain(`${k}: '${cmd}'`);
    const boot = read('loading/boot.js');
    expect(boot).toContain("'retry_boot'");
    expect(boot).toContain("'open_log'");
  });
  // invoke_handler を 2 度呼ぶと、後のものだけが残り、先に並べた命令が黙って呼べなくなる。
  it('殻の命令は invoke_handler の 1 か所でまとめて登録する', () => {
    expect(read('src-tauri/src/lib.rs').match(/\.invoke_handler\(/g)).toHaveLength(1);
  });
});

describe('殻がサーバへ渡す環境', () => {
  // サーバへ渡さない変数の正本はサーバの側（launch/env.ts）にあり、殻はその写しを持つ。
  // 片方だけ足すと、殻とサーバで外す名前が食い違い、殻の側では新しい印が素通りする。
  it('殻がサーバへ渡さない変数（server.rs の INHERITED_ENV_DROPPED）は、サーバの正本（SERVER_DROPPED_ENV）と同じ', () => {
    const block = read('src-tauri/src/server.rs').match(/pub const INHERITED_ENV_DROPPED: &\[&str\] = &\[([^\]]*)\];/)?.[1];
    expect(block, 'INHERITED_ENV_DROPPED が見つかりません').toBeDefined();
    const names = [...block!.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]!);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...SERVER_DROPPED_ENV].sort());
  });
});

describe('殻の印', () => {
  // 殻が付ける印と、画面がそれを読む規則は別の言語に分かれている。片方だけ直すと、ブラウザか殻のどちらかで余白が崩れる。
  // ヘッダの左の列はロゴから始まる。ロゴの始まり（--head-lead）を、殻の中でだけ信号の 3 点の右にする。
  it('殻は頁に data-shell="desktop" を付け、画面はそれでヘッダの左を信号の 3 点の分だけ空ける', () => {
    expect(read('src-tauri/src/lib.rs')).toContain("document.documentElement.dataset.shell = 'desktop'");
    // 印は macOS の殻でだけ付ける。Windows の窓は標準の枠で、信号の 3 点が無いので空けない。
    // 読み込み画面（失敗の札のロゴ）にもサーバの頁にも、同じ条件で付ける。
    const lib = read('src-tauri/src/lib.rs');
    const mark = lib.indexOf("document.documentElement.dataset.shell = 'desktop'");
    const guard = lib.lastIndexOf('if cfg!(target_os = "macos") {', mark);
    expect(guard).toBeGreaterThan(0);
    expect(lib.slice(guard, mark)).not.toContain('}');
    expect(lib.slice(guard, mark)).not.toContain('server_page');
    const base = fs.readFileSync(path.resolve(app, '../../packages/ui/src/styles/base.css'), 'utf8');
    expect(base).toContain("[data-shell='desktop'] .shell { --head-lead: var(--lights-end); }");
  });
});

describe('外のアプリの起こし役', () => {
  // サーバは外のアプリを、殻の実行ファイルに印を付けて起こさせる（Windows で Hangar のジョブの外に出すため）。
  // 印は殻（breakaway.rs の FLAG）とサーバ（external/breakaway.ts の BREAKAWAY_FLAG）の 2 か所にある。片方だけ変えると、殻は印に気付かず窓を開く。
  it('殻とサーバの印が同じで、殻は Tauri を立ち上げる前に印を見る', async () => {
    const rust = read('src-tauri/src/breakaway.rs').match(/pub const FLAG: &str = "([^"]+)";/)?.[1];
    expect(rust, 'breakaway.rs の FLAG が見つかりません').toBeDefined();
    const { BREAKAWAY_FLAG } = await import('../../../packages/server/src/external/breakaway.ts');
    expect(rust).toBe(BREAKAWAY_FLAG);
    const main = read('src-tauri/src/main.rs');
    expect(main.indexOf('breakaway::run_if_requested')).toBeGreaterThan(0);
    expect(main.indexOf('breakaway::run_if_requested')).toBeLessThan(main.indexOf('hangar_desktop_lib::run()'));
  });
});

describe('互換の版', () => {
  // 殻は 4177 の既存のサーバを、自分が名乗る版と同じ版のときだけ採る（health.rs の judge_existing）。
  // 殻の版は同梱するサーバの版と同じでなければならないので、shared の正本と突き合わせる。
  // 片方だけ変えると、殻は自分と同じ束のサーバまで採らなくなるか、版の違うサーバを採る。
  it('殻が名乗る互換の版（health.rs の COMPAT_VERSION）は shared の正本と同じ', () => {
    const rust = read('src-tauri/src/health.rs').match(/pub const COMPAT_VERSION: u64 = (\d+);/)?.[1];
    expect(rust, 'health.rs の COMPAT_VERSION が見つかりません').toBeDefined();
    expect(Number(rust)).toBe(COMPAT_VERSION);
  });
});
