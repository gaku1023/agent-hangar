import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkCommitGate, checkSigningSecrets, compareVersions, type CiRun, isPrerelease, manifestUrl, missingAssets, planRelease,
  PRERELEASE_CHANNEL_TAG, PRERELEASE_TAURI_CONFIG, readVersions, releaseNotesFile, setVersionIn, shouldUpdateChannel, UPSTREAM_REPO,
  versionOfTag, VERSION_FILES,
} from '../scripts/release-plan.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../..');
const script = path.join(app, 'scripts/release-plan.ts');
// 呼び手の環境（GitHub Actions の印や secret の有無）を持ち込まない。試験が渡したものだけを見せる。
const node = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH ?? '', ...env },
});

// タグを打つと release.yml が走る。
// アプリの版はリポジトリのファイル（tauri.conf.json ほか）にあり、タグはそれを名指すだけである。
// 食い違ったまま配ると、更新の目録の版と、アプリが自分を名乗る版と、更新物の署名に入る版がずれ、更新が見つからないか署名の照合で落ちる。
describe('タグから版を読む', () => {
  it('v に semver が続くタグだけを受ける', () => {
    expect(versionOfTag('v0.2.0')).toBe('0.2.0');
    expect(versionOfTag('v0.2.0-rc.1')).toBe('0.2.0-rc.1');
    expect(versionOfTag('v1.10.3-beta.2')).toBe('1.10.3-beta.2');
    for (const bad of ['0.2.0', 'v0.2', 'v0.2.0.1', 'v01.2.0', 'v0.2.0-', 'v0.2.0-rc..1', 'v0.2.0-rc.01', 'updater-prerelease', 'v0.2.0 ']) {
      expect(() => versionOfTag(bad), bad).toThrow();
    }
  });
  // 更新の比べ方（semver）はビルドメタデータを見ないので、v0.2.0+1 は v0.2.0 の更新として見つからない。
  // NSIS もビルドメタデータを数字しか受けない。だから配る版に + は付けない。
  it('ビルドメタデータ（+）の付いたタグは断る', () => {
    expect(() => versionOfTag('v0.2.0+1')).toThrow(/build metadata/);
    expect(() => versionOfTag('v0.2.0-rc.1+abc')).toThrow(/build metadata/);
  });
  it('- の後ろ（プレリリース）があれば試しの版とみなす', () => {
    expect(isPrerelease('0.2.0-rc.1')).toBe(true);
    expect(isPrerelease('0.2.0-beta')).toBe(true);
    expect(isPrerelease('0.2.0')).toBe(false);
  });
});

describe('semver の順序（tauri-plugin-updater と NSIS の比べ方と同じ）', () => {
  it('試しの版は同じ数字の正式な版より古く、rc.10 は rc.9 より新しい', () => {
    const ordered = ['0.1.0', '0.2.0-alpha', '0.2.0-alpha.1', '0.2.0-beta', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.9', '0.2.0-rc.10', '0.2.0', '0.2.1', '0.10.0', '1.0.0'];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(compareVersions(ordered[i]!, ordered[j]!), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
      }
    }
  });
});

describe('release の計画', () => {
  const same = (v: string) => Object.fromEntries(VERSION_FILES.map((f) => [f, v]));
  // 本文のファイルを読む口。渡したものだけがあるように見せ、読みに来た名前を控える。
  const notes = (files: Record<string, string> = {}) => {
    const asked: string[] = [];
    const read = (f: string) => { asked.push(f); return files[f]; };
    return { read, asked };
  };
  const withNotes = (v: string) => notes({ [`docs/release-notes/${v}.md`]: `# Hangar ${v}\n` }).read;
  it('正式な版は、最新の Release にして、目録は安定版の道（Release の最新）だけに置く', () => {
    expect(planRelease('v0.2.0', same('0.2.0'), withNotes('0.2.0'))).toEqual({ version: '0.2.0', prerelease: false, tauriConfig: '', releaseNotes: 'docs/release-notes/0.2.0.md' });
  });
  it('試しの版は prerelease にして、試しの道の endpoint を焼き込む設定を重ねる', () => {
    expect(planRelease('v0.2.0-rc.1', same('0.2.0-rc.1'), withNotes('0.2.0-rc.1'))).toEqual({ version: '0.2.0-rc.1', prerelease: true, tauriConfig: PRERELEASE_TAURI_CONFIG, releaseNotes: '' });
  });
  it('どれか 1 つのファイルの版がタグと違えば、どのファイルが何かを挙げて止める', () => {
    const files = { ...same('0.2.0-rc.1'), 'apps/desktop/src-tauri/Cargo.toml': '0.1.0' };
    expect(() => planRelease('v0.2.0-rc.1', files, withNotes('0.2.0-rc.1'))).toThrow(/Cargo\.toml.*0\.1\.0/);
    // tauri.conf.json がまだ前の版のまま（版を上げる PR を入れずにタグを打った）
    expect(() => planRelease('v0.2.0', same('0.1.0'), withNotes('0.2.0'))).toThrow(/tauri\.conf\.json/);
    // ファイルが読めなかった（版が見つからない）も止める。
    const missing: Record<string, string | undefined> = { ...same('0.2.0'), 'package-lock.json': undefined };
    expect(() => planRelease('v0.2.0', missing, withNotes('0.2.0'))).toThrow(/package-lock\.json/);
  });
  // 正式な版の Release の本文は docs/release-notes/<版>.md で、release.yml がそのまま本文にする。
  // 無いまま進むと、GitHub の自動生成（PR の一覧）が本文になって、最新の Release として利用者に見える。
  it('正式な版は、本文のファイル（docs/release-notes/<版>.md）が無いか空なら止める', () => {
    expect(releaseNotesFile('0.2.0')).toBe('docs/release-notes/0.2.0.md');
    expect(() => planRelease('v0.2.0', same('0.2.0'), notes().read)).toThrow(/docs\/release-notes\/0\.2\.0\.md/);
    expect(() => planRelease('v0.2.0', same('0.2.0'), notes({ 'docs/release-notes/0.2.0.md': ' \n\n' }).read)).toThrow(/docs\/release-notes\/0\.2\.0\.md.*empty/);
    // 別の版の本文は数えない。
    expect(() => planRelease('v0.2.1', same('0.2.1'), withNotes('0.2.0'))).toThrow(/docs\/release-notes\/0\.2\.1\.md/);
  });
  it('試しの版は本文のファイルを見ず、GitHub の自動生成に任せる', () => {
    const n = notes();
    expect(planRelease('v0.2.0-rc.1', same('0.2.0-rc.1'), n.read).releaseNotes).toBe('');
    expect(n.asked).toEqual([]);
  });
});

// 安定版の利用者は Release の最新（prerelease は入らない）の latest.json を引く。
// 試しの版の利用者は、固定の名前の prerelease（PRERELEASE_CHANNEL_TAG）の latest.json を引く。
describe('更新の目録の行き先', () => {
  it('安定版の道は Release の最新、試しの道は固定のタグの Release である', () => {
    expect(manifestUrl('owner/repo', 'stable')).toBe('https://github.com/owner/repo/releases/latest/download/latest.json');
    expect(manifestUrl('owner/repo', 'prerelease')).toBe(`https://github.com/owner/repo/releases/download/${PRERELEASE_CHANNEL_TAG}/latest.json`);
    // 固定のタグは release.yml の on.push.tags（v*）に当たらない。当たると、目録を置くたびに release が走る。
    expect(PRERELEASE_CHANNEL_TAG.startsWith('v')).toBe(false);
  });
  // 試しの道には、試しの版も正式な版も、より新しいものだけを置く。
  // 試しの版の利用者は、次の rc も、その後の正式な版も受け取れる。古い版の再実行で道が巻き戻らない。
  it('試しの道の目録は、今より新しいか同じ版のときだけ置き換える', () => {
    expect(shouldUpdateChannel(null, '0.2.0-rc.1')).toBe(true);
    expect(shouldUpdateChannel('0.2.0-rc.1', '0.2.0-rc.2')).toBe(true);
    expect(shouldUpdateChannel('0.2.0-rc.2', '0.2.0')).toBe(true);
    expect(shouldUpdateChannel('0.2.0-rc.2', '0.2.0-rc.2')).toBe(true);
    expect(shouldUpdateChannel('0.2.0-rc.2', '0.2.0-rc.1')).toBe(false);
    expect(shouldUpdateChannel('0.2.0', '0.1.9')).toBe(false);
  });
  it('リポジトリの設定が、安定版の道と試しの道をそれぞれ指す', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(app, 'src-tauri/tauri.conf.json'), 'utf8'));
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(conf.plugins.updater.endpoints[0])?.[1];
    expect(repo).toBeDefined();
    expect(conf.plugins.updater.endpoints).toEqual([manifestUrl(repo!, 'stable')]);
    // 重ねる側は endpoint だけを替える（JSON merge patch で配列は丸ごと置き換わる）。公開鍵や installMode は tauri.conf.json のまま。
    const pre = JSON.parse(fs.readFileSync(path.join(app, PRERELEASE_TAURI_CONFIG), 'utf8'));
    expect(pre).toEqual({ $schema: 'https://schema.tauri.app/config/2', plugins: { updater: { endpoints: [manifestUrl(repo!, 'prerelease')] } } });
  });
});

// 本家で署名の secret が無いまま走ると、証明書の署名の無い .app（入れ替えのたびに許可が外れる）や、目録の無い Release を配ってしまう。
// 本家では、正式な版も試しの版も止める。試しの版は正式な版の通し稽古で、試す人の許可も同じ証明書で保たれなければならない。
// fork には secret が無いのがふつうなので、警告だけで続ける。
describe('署名の secret', () => {
  const both = { macosSign: true, updaterKey: true };
  it('本家で 2 つともあれば、署名を必須として続ける', () => {
    expect(checkSigningSecrets(UPSTREAM_REPO, both)).toEqual({ required: true, warnings: [] });
  });
  it('本家でどちらかが無ければ、無い secret の名前を挙げて止める', () => {
    expect(() => checkSigningSecrets(UPSTREAM_REPO, { ...both, macosSign: false })).toThrow(/HANGAR_SIGN_P12_BASE64/);
    expect(() => checkSigningSecrets(UPSTREAM_REPO, { ...both, updaterKey: false })).toThrow(/TAURI_SIGNING_PRIVATE_KEY/);
    expect(() => checkSigningSecrets(UPSTREAM_REPO, { macosSign: false, updaterKey: false })).toThrow(/HANGAR_SIGN_P12_BASE64[\s\S]*TAURI_SIGNING_PRIVATE_KEY/);
  });
  it('fork では、無い secret ごとに警告を返して続ける', () => {
    expect(checkSigningSecrets('someone/agent-hangar', both)).toEqual({ required: false, warnings: [] });
    const r = checkSigningSecrets('someone/agent-hangar', { macosSign: false, updaterKey: false });
    expect(r.required).toBe(false);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join('\n')).toMatch(/HANGAR_SIGN_P12_BASE64[\s\S]*TAURI_SIGNING_PRIVATE_KEY/);
  });
  it('本家の名前は大文字と小文字を区別しない（GitHub のリポジトリ名と同じ）', () => {
    expect(() => checkSigningSecrets(UPSTREAM_REPO.toUpperCase(), { macosSign: false, updaterKey: true })).toThrow();
  });
});

// タグは main に入って ci が緑になったコミットにだけ打つ。
// release の windows ジョブは npm test を回さず、ci の windows ジョブが同じコミットで回したことに頼るので、plan で確かめる。
describe('タグのコミットの関門', () => {
  const sha = 'a'.repeat(40);
  const run = (over: Partial<CiRun> = {}): CiRun => ({ run_number: 10, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: sha, event: 'push', head_branch: 'main', ...over });
  it('main の祖先で、main への push の ci が成功していれば通す', () => {
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run()] })).not.toThrow();
  });
  it('main の祖先でなければ止める', () => {
    expect(() => checkCommitGate({ sha, onMain: false, runs: [run()] })).toThrow(/not on main/);
  });
  it('そのコミットの main への push の ci が無ければ止める（PR の ci や、ほかのコミットの ci は数えない）', () => {
    expect(() => checkCommitGate({ sha, onMain: true, runs: [] })).toThrow(/no ci run/);
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ event: 'pull_request', head_branch: 'feature' })] })).toThrow(/no ci run/);
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ head_sha: 'b'.repeat(40) })] })).toThrow(/no ci run/);
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ head_branch: 'other' })] })).toThrow(/no ci run/);
  });
  it('ci が走っている途中なら、終わってから release をもう一度走らせるよう告げて止める', () => {
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ status: 'in_progress', conclusion: null })] })).toThrow(/still in_progress[\s\S]*re-run/);
  });
  it('ci が成功で終わっていなければ止める', () => {
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ conclusion: 'failure' })] })).toThrow(/failure/);
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ conclusion: 'cancelled' })] })).toThrow(/cancelled/);
  });
  it('同じコミットに ci が何度か走ったら、いちばん新しいものを見る', () => {
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ run_number: 9, conclusion: 'failure' }), run({ run_number: 10 })] })).not.toThrow();
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ run_number: 11, conclusion: 'failure' }), run({ run_number: 10 })] })).toThrow(/failure/);
    // 同じ run を回し直したもの（run_attempt が増える）も、新しいほうを見る。
    expect(() => checkCommitGate({ sha, onMain: true, runs: [run({ run_attempt: 1, conclusion: 'failure' }), run({ run_attempt: 2 })] })).not.toThrow();
  });
});

// Release は下書きで作り、資産と目録がそろってから最後に公開する。
// 公開の前に、そろうべき資産の名前を照らす（途中で落ちたら公開しないが、そろわないまま公開する誤りも防ぐ）。
describe('公開の前にそろう資産', () => {
  const tag = 'v9.9.9';
  const base = [
    'Hangar-v9.9.9-macos-arm64.dmg', 'Hangar-v9.9.9-macos-arm64.dmg.sha256',
    'Hangar-v9.9.9-macos-arm64.zip', 'Hangar-v9.9.9-macos-arm64.zip.sha256',
    'Hangar-v9.9.9-windows-x64-setup.exe', 'Hangar-v9.9.9-windows-x64-setup.exe.sha256',
  ];
  const updater = ['Hangar-v9.9.9-macos-arm64.app.tar.gz', 'Hangar-v9.9.9-macos-arm64.app.tar.gz.sig', 'Hangar-v9.9.9-windows-x64-setup.exe.sig', 'latest.json'];
  it('更新の署名鍵があれば、配布物と更新物と目録のすべてが要る', () => {
    expect(missingAssets(tag, [...base, ...updater], true)).toEqual([]);
    expect(missingAssets(tag, [...base, ...updater.filter((n) => n !== 'latest.json')], true)).toEqual(['latest.json']);
    expect(missingAssets(tag, base, true)).toEqual(updater);
  });
  it('鍵が無ければ（fork）、配布物だけが要る', () => {
    expect(missingAssets(tag, base, false)).toEqual([]);
    expect(missingAssets(tag, base.slice(1), false)).toEqual([base[0]]);
  });
  it('ほかのタグの資産は数えない', () => {
    expect(missingAssets(tag, [...base, ...updater].map((n) => n.replace('v9.9.9', 'v9.9.8')), true)).toContain('Hangar-v9.9.9-macos-arm64.dmg');
  });
});

describe('リポジトリの版', () => {
  // 版を上げる PR が 1 つのファイルを上げ忘れると、ここで落ちる（タグを打つ前に気づける）。
  it('版の在りかの 5 つが同じ版を名乗る', () => {
    const v = readVersions(root);
    expect(Object.keys(v).sort()).toEqual([...VERSION_FILES].sort());
    const values = new Set(Object.values(v));
    expect(values.size, JSON.stringify(v)).toBe(1);
    expect([...values][0]).toMatch(/^\d+\.\d+\.\d+/);
  });
  // サーバ（/health、WebSocket の ready、MCP）が名乗る版は、決め打ちせず apps/desktop の package.json から読む。
  // だから set-version で上げればサーバの版も上がり、plan の照合もサーバの版を見たことになる。
  it('サーバの名乗る版は、版の在りかの 1 つから読み、決め打ちしない', () => {
    const src = fs.readFileSync(path.join(root, 'packages/server/src/boot/options.ts'), 'utf8');
    const from = /from '((?:\.\.\/)+apps\/desktop\/package\.json)'/.exec(src);
    expect(from, 'options.ts must import apps/desktop/package.json').not.toBeNull();
    expect(path.relative(root, path.resolve(root, 'packages/server/src/boot', from![1]!)).split(path.sep).join('/')).toBe('apps/desktop/package.json');
    expect(VERSION_FILES).toContain('apps/desktop/package.json');
    expect(src).not.toMatch(/['"]\d+\.\d+\.\d+[^'"]*['"]/);
  });
  // Worker の /health が名乗る版も同じで、packages/cloud/src/util.ts は決め打ちせず apps/desktop の package.json から読む。
  // 決め打ちだと、版を上げても Worker だけ古い版を名乗り続ける（0.4.0 のまま残っていた）。
  it('Worker の名乗る版も、版の在りかの 1 つから読み、決め打ちしない', () => {
    const src = fs.readFileSync(path.join(root, 'packages/cloud/src/util.ts'), 'utf8');
    const from = /from '((?:\.\.\/)+apps\/desktop\/package\.json)'/.exec(src);
    expect(from, 'util.ts must import apps/desktop/package.json').not.toBeNull();
    expect(path.relative(root, path.resolve(root, 'packages/cloud/src', from![1]!)).split(path.sep).join('/')).toBe('apps/desktop/package.json');
    expect(src).not.toMatch(/VERSION\s*(?::\s*string\s*)?=\s*['"]\d+\.\d+\.\d+[^'"]*['"]/);
  });
  it('束ねた Worker は、今の版を名乗る', async () => {
    const { bundleWorker } = await import('../../../packages/cloud/scripts/build-worker.ts');
    const code = await bundleWorker(path.join(root, 'packages/cloud'));
    expect(code).toContain(JSON.stringify(readVersions(root)['apps/desktop/package.json']));
  });
  it('版を書き換えると、それぞれのファイルのその 1 か所だけが変わる', () => {
    for (const f of VERSION_FILES) {
      const before = fs.readFileSync(path.join(root, f), 'utf8');
      const current = readVersions(root)[f]!;
      const after = setVersionIn(f, before, '9.8.7-rc.6');
      const changed = before.split('\n').filter((line, i) => line !== after.split('\n')[i]);
      expect(changed.length, f).toBe(1);
      expect(changed[0], f).toContain(current);
      expect(after.split('\n').length, f).toBe(before.split('\n').length);
      expect(setVersionIn(f, after, current), f).toBe(before);
    }
  });
  // 本文のファイルはそのまま Release の本文になる。正式な版の名前だけを置き、中身を空にしない。
  it('リポジトリの Release の本文は、正式な版の名前で、空でない', () => {
    const dir = path.join(root, 'docs/release-notes');
    for (const f of fs.readdirSync(dir)) {
      const m = /^(.+)\.md$/.exec(f);
      expect(m, f).not.toBeNull();
      expect(() => versionOfTag(`v${m![1]}`), f).not.toThrow();
      expect(isPrerelease(m![1]!), f).toBe(false);
      expect(releaseNotesFile(m![1]!)).toBe(`docs/release-notes/${f}`);
      expect(fs.readFileSync(path.join(dir, f), 'utf8').trim(), f).not.toBe('');
    }
  });
  it('版を上げる手順（docs/release.md）が呼ぶ npm の script がある', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    expect(pkg.scripts['set-version']).toBe('node --experimental-strip-types --no-warnings scripts/release-plan.ts set-version');
    expect(fs.readFileSync(path.join(root, 'docs/release.md'), 'utf8')).toContain('npm run set-version -w apps/desktop -- ');
  });
  it('書き換えた版を読み直せる（置き場で試す）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
    for (const f of VERSION_FILES) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(dir, f));
    }
    const r = node(['set-version', '0.2.0-rc.1', dir]);
    expect(r.status, r.stderr).toBe(0);
    expect(new Set(Object.values(readVersions(dir)))).toEqual(new Set(['0.2.0-rc.1']));
    // ビルドメタデータ付きや semver でない版は書かない。
    expect(node(['set-version', '0.2.0+1', dir]).status).not.toBe(0);
    expect(node(['set-version', 'v0.2.0', dir]).status).not.toBe(0);
    expect(new Set(Object.values(readVersions(dir)))).toEqual(new Set(['0.2.0-rc.1']));
  });
});

// release.yml は実際には走らせられないので、計画の出力がどこへつながっているかを文字で見る。
describe('release.yml の配線', () => {
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const action = fs.readFileSync(path.join(root, '.github/actions/windows-installer/action.yml'), 'utf8');
  const job = (name: string) => {
    const m = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[\\w-]+:\\n|(?![\\s\\S]))`, 'm').exec(release);
    expect(m, name).not.toBeNull();
    return m![1]!;
  };
  const at = (text: string, s: string) => {
    const i = text.indexOf(s);
    expect(i, s).toBeGreaterThanOrEqual(0);
    return i;
  };
  // ジョブの段（6 つの空白の字下げ）と、composite action の段（4 つ）に分ける。
  const steps = (body: string, indent: number) => body.split(new RegExp(`\\n {${indent}}- `)).slice(1);
  it('plan ジョブが計画を決め、作るジョブはすべてその後に回る', () => {
    expect(job('plan')).toContain('release-plan.ts plan "$GITHUB_REF_NAME"');
    expect(job('macos')).toMatch(/needs: plan\n/);
    expect(job('windows')).toMatch(/needs: plan\n/);
    expect(job('macos-test')).toMatch(/needs: plan\n/);
    expect(job('windows-upload')).toMatch(/needs: \[macos, windows\]\n/);
    expect(job('publish')).toMatch(/needs: \[plan, macos, macos-test, windows-upload\]\n/);
    expect(job('channel')).toMatch(/needs: \[plan, publish\]\n/);
    // 照合は plan の 1 か所にする（tauri.conf.json だけを見る古い段は残さない）。
    expect(release).not.toContain("require('./apps/desktop/src-tauri/tauri.conf.json').version");
  });
  it('macOS の型の確かめと試験は、.app のビルドと並ぶ別のジョブで回し、通らなければ公開しない', () => {
    const t = steps(job('macos-test'), 6);
    expect(t.some((s) => s.startsWith('run: npm run typecheck'))).toBe(true);
    expect(t.some((s) => s.startsWith('run: npm test'))).toBe(true);
    expect(job('macos-test')).toContain('runs-on: macos-latest');
    // ビルドのジョブで同じ試験を重ねて回さない。
    const m = steps(job('macos'), 6);
    expect(m.some((s) => s.startsWith('run: npm test'))).toBe(false);
    expect(m.some((s) => s.startsWith('run: npm run typecheck'))).toBe(false);
  });
  // macOS のランナーは、同じ macos-latest でも run ごとに 3 倍ほど速さが違った（2026-10-29）。機械の違いかを後から見分けられるよう、型と数を残す。
  it('Mac の 2 つのジョブは、ランナーの CPU の型と数を記録に出す', () => {
    for (const name of ['macos', 'macos-test']) {
      expect(job(name), name).toContain('sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize');
    }
  });
  it('タグの run は Rust のキャッシュを保存しない（タグの範囲のキャッシュは次のタグから読めない）', () => {
    const cache = steps(job('macos'), 6).find((s) => s.includes('Swatinem/rust-cache'));
    expect(cache).toContain('save-if: false');
  });
  it('plan は、タグのコミットが origin/main の祖先で、そのコミットの main の ci が成功していることを確かめる', () => {
    const p = job('plan');
    expect(p).toContain('fetch-depth: 0');
    expect(p).toContain('git merge-base --is-ancestor "$sha" origin/main');
    expect(p).toContain('actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main');
    expect(p).toContain('release-plan.ts gate "$sha" "$on_main"');
    // 走った ci を読むのに actions: read が要る。
    expect(p).toMatch(/permissions:\n {6}contents: read\n {6}actions: read\n/);
    // 関門は計画を書き出す前に置く（関門で落ちたら、作るジョブに何も渡らない）。
    expect(at(p, 'release-plan.ts gate')).toBeLessThan(at(p, '>> "$GITHUB_OUTPUT"'));
  });
  it('plan は署名の secret の有無を受け取り、署名が必須かを作るジョブへ渡す', () => {
    const p = job('plan');
    expect(p).toContain('signing-required: ${{ steps.plan.outputs.signing-required }}');
    expect(release).toContain("HAS_UPDATER_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY != '' }}");
    expect(release).toContain("HAS_MACOS_SIGN: ${{ secrets.HANGAR_SIGN_P12_BASE64 != '' }}");
    const sign = steps(job('macos'), 6).find((s) => s.includes('ci-sign-macos.sh'));
    expect(sign).toContain('HANGAR_SIGN_REQUIRED: ${{ needs.plan.outputs.signing-required }}');
  });
  it('Release は下書きで作って最新にせず、公開と最新への格上げは publish ジョブの最後の段だけが行う', () => {
    const m = job('macos');
    expect(m).toContain('draft: true');
    expect(m).toContain("make_latest: 'false'");
    expect(m).toContain("prerelease: ${{ needs.plan.outputs.prerelease == 'true' }}");
    const p = job('publish');
    const manifest = at(p, 'gh release upload "$GITHUB_REF_NAME" "$RUNNER_TEMP/latest.json"');
    const check = at(p, 'release-plan.ts assets "$GITHUB_REF_NAME"');
    const publish = at(p, '--draft=false');
    expect(manifest).toBeLessThan(check);
    expect(check).toBeLessThan(publish);
    // 正式な版だけを最新にし、試しの版は prerelease のまま最新にしない。
    expect(p).toContain('--prerelease --latest=false');
    expect(p).toMatch(/--draft=false --latest\n/);
    // 公開した後に資産を足す段は無い（公開は最後）。
    expect(p.slice(publish)).not.toContain('gh release upload');
    for (const name of ['macos', 'windows-upload', 'channel']) expect(job(name), name).not.toContain('--draft=false');
  });
  // 正式な版は docs/release-notes/<版>.md を本文にし、試しの版は GitHub の自動生成にする。
  // 本文と自動生成を両方渡すと、GitHub は本文の後ろに自動生成を足すので、どちらか一方だけにする。
  it('Release の本文は、plan が決めた本文のファイルを使い、無いとき（試しの版）だけ自動生成にする', () => {
    expect(job('plan')).toContain('release-notes: ${{ steps.plan.outputs.release-notes }}');
    const m = job('macos');
    expect(m).toContain('body_path: ${{ needs.plan.outputs.release-notes }}');
    expect(m).toContain("generate_release_notes: ${{ needs.plan.outputs.release-notes == '' }}");
    expect(release).not.toContain('generate_release_notes: true');
    // 公開の段は本文に触らない（下書きに入れた本文がそのまま公開される）。
    expect(job('publish')).not.toMatch(/--notes/);
  });
  it('試しの道の目録の置き換えは 1 本ずつ走り、取得の失敗を「目録が無い」と取り違えない', () => {
    const c = job('channel');
    expect(c).toMatch(/concurrency:\n {6}group: release-channel-\$\{\{ needs\.plan\.outputs\.channel-tag \}\}\n {6}cancel-in-progress: false\n/);
    expect(c).not.toContain('|| true');
    expect(c).toContain('--prerelease');
    expect(c).toContain('isPrerelease');
    expect(c).toContain('release-plan.ts channel');
    expect(c).toContain('CHANNEL: ${{ needs.plan.outputs.channel-tag }}');
    // 目録が無いと決めるのは、Release の資産の一覧に latest.json が無いときだけ。
    expect(c).toContain("--json assets -q '.assets[].name'");
    expect(c).toContain('set -euo pipefail');
  });
  it('試しの版の build は、macOS も Windows も試しの道の endpoint を重ねる', () => {
    expect(job('macos')).toContain('EXTRA_CONFIG: ${{ needs.plan.outputs.tauri-config }}');
    expect(job('macos')).toContain('--config "$EXTRA_CONFIG"');
    expect(job('windows')).toContain('extra-config: ${{ needs.plan.outputs.tauri-config }}');
    expect(action).toContain("$extra += @('--config', $env:EXTRA_CONFIG)");
  });
  // build は npm の script（beforeBuildCommand の bundle-server）や依存のコードを走らせる。そこへ鍵を置かない。
  it('更新の署名鍵は build に渡さず、更新物に署名する段だけに渡す', () => {
    const withKey = (list: string[]) => list.filter((s) => /TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?:/.test(s));
    const mac = withKey(steps(job('macos'), 6));
    expect(mac).toHaveLength(1);
    expect(mac[0]).toContain('repack-updater-macos.sh pack');
    const macBuild = steps(job('macos'), 6).find((s) => s.includes('npm run tauri -- build'));
    expect(macBuild).toBeDefined();
    expect(macBuild).not.toContain('TAURI_SIGNING');
    const win = withKey(steps(action, 4));
    expect(win).toHaveLength(1);
    expect(win[0]).toContain('signer sign');
    const winBuild = steps(action, 4).find((s) => s.includes('build --bundles nsis'));
    expect(winBuild).toBeDefined();
    expect(winBuild).not.toContain('TAURI_SIGNING');
    // 署名はインストーラができた後で、入れて確かめる段より前に付ける（署名はファイルを書き換えない）。
    expect(at(action, '-- signer sign $setup')).toBeGreaterThan(at(action, '-- build --bundles nsis'));
    expect(at(action, '-- signer sign $setup')).toBeLessThan(at(action, "-ArgumentList '/S' -Wait -PassThru"));
    expect(action).toContain('value: ${{ steps.sign.outputs.sig }}');
  });
  it('第三者の action は版の SHA で固定し、元の版をコメントに書く', () => {
    const uses = [...release.matchAll(/uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    const third = uses.filter(([, ref]) => !ref!.startsWith('actions/') && !ref!.startsWith('./'));
    expect(third.map(([, ref]) => ref!.split('@')[0]).sort()).toEqual(['Swatinem/rust-cache', 'Swatinem/rust-cache', 'dtolnay/rust-toolchain', 'dtolnay/rust-toolchain', 'softprops/action-gh-release']);
    for (const [, ref, rest] of third) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/^ # \S+/);
    }
  });
  // 書き込みの権限のあるジョブで、checkout が token を .git/config に残すと、build の script から読める。
  it('checkout は token を残さない', () => {
    const checkouts = release.split('\n').map((l, i) => [l, i] as const).filter(([l]) => l.includes('uses: actions/checkout@'));
    expect(checkouts.length).toBeGreaterThan(0);
    const lines = release.split('\n');
    for (const [, i] of checkouts) {
      const block = lines.slice(i + 1, i + 6).join('\n');
      expect(block, `line ${i + 1}`).toMatch(/with:\n(?: {10}.*\n)*? {10}persist-credentials: false/);
    }
  });
});

// plan の関門は、タグのコミットへの main の push で走った ci の run が成功していることを見る。
// GitHub の concurrency は、cancel-in-progress が false でも、同じ group で待っている run を新しい run が来たときに取り消す。
// main も ref ごとの 1 つの group にするので、続けて入れたときに間のコミットの ci は cancelled になる（タグは ci が緑のコミットに打つ）。
// 並列でマージすると main の run が重なり、PR とランナーを取り合うため、待ちは最新の 1 本だけにする（2026-10-15）。
describe('ci.yml の concurrency', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const block = /^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)\n/m.exec(ci);
  it('group は ref ごとにし、main への push は走っている run を取り消さない', () => {
    expect(block, 'top-level concurrency').not.toBeNull();
    const [, group, cancel] = block!;
    // ref ごとなので、別の PR 同士や PR と main は互いを止めない。
    expect(group).toBe('ci-${{ github.ref }}');
    // push の run は走っている途中でも取り消さない。PR は同じ枝に続けて押したとき、走っている古い実行も打ち切る。
    expect(cancel).toBe("${{ github.event_name != 'push' }}");
    // push で走るのは main だけである（ほかの枝の push に広げると、PR と同じ枝で 2 つの group が走る）。
    expect(ci).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/m);
  });
});

// release.yml の plan ジョブは npm ci をしない。Node が型を剥がすだけで動き、GitHub の出力の形で書く。
describe('release.yml から呼ぶ形', () => {
  const v = readVersions(root)['apps/desktop/src-tauri/tauri.conf.json']!;
  const planOut = (required: boolean) => `version=${v}\nprerelease=${isPrerelease(v)}\ntauri-config=${isPrerelease(v) ? PRERELEASE_TAURI_CONFIG : ''}\nchannel-tag=${PRERELEASE_CHANNEL_TAG}\nsigning-required=${required}\nrelease-notes=${isPrerelease(v) ? '' : releaseNotesFile(v)}\n`;
  it('plan は版と prerelease と重ねる設定と署名の要否を key=value で書き、食い違えば 0 以外で終わる', () => {
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, 'plan', `v${v}`, root], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(out).toBe(planOut(false));
    const bad = node(['plan', 'v99.0.0', root]);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('99.0.0');
  });
  it('plan は本家で署名の secret が無ければ何も書かずに止め、fork では警告を標準エラーに出して続ける', () => {
    const upstream = { GITHUB_REPOSITORY: UPSTREAM_REPO };
    const missing = node(['plan', `v${v}`, root], { ...upstream, HAS_MACOS_SIGN: 'false', HAS_UPDATER_KEY: 'true' });
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('HANGAR_SIGN_P12_BASE64');
    const ok = node(['plan', `v${v}`, root], { ...upstream, HAS_MACOS_SIGN: 'true', HAS_UPDATER_KEY: 'true' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe(planOut(true));
    const fork = node(['plan', `v${v}`, root], { GITHUB_REPOSITORY: 'someone/agent-hangar', HAS_MACOS_SIGN: 'false', HAS_UPDATER_KEY: 'false' });
    expect(fork.status, fork.stderr).toBe(0);
    expect(fork.stdout).toBe(planOut(false));
    expect(fork.stderr).toMatch(/^::warning/m);
    // 警告は GITHUB_OUTPUT へ流れる標準出力に混ぜない。
    expect(fork.stdout).not.toContain('::');
  });
  it('plan は、正式な版なら本文のファイルの場所を書き、無ければ何も書かずに止まる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
    for (const f of VERSION_FILES) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(dir, f));
    }
    expect(node(['set-version', '9.9.9', dir]).status).toBe(0);
    const missing = node(['plan', 'v9.9.9', dir]);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('docs/release-notes/9.9.9.md');
    fs.mkdirSync(path.join(dir, 'docs/release-notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/release-notes/9.9.9.md'), '# Hangar 9.9.9\n');
    const ok = node(['plan', 'v9.9.9', dir]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('\nprerelease=false\n');
    expect(ok.stdout).toMatch(/\nrelease-notes=docs\/release-notes\/9\.9\.9\.md\n$/);
  });
  it('gate は、main の祖先かと ci の run の一覧（API の応答のまま）を受け、通らなければ 0 以外で終わる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
    const sha = 'c'.repeat(40);
    const runs = path.join(dir, 'runs.json');
    fs.writeFileSync(runs, JSON.stringify({ total_count: 1, workflow_runs: [{ run_number: 3, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: sha, event: 'push', head_branch: 'main' }] }));
    const ok = node(['gate', sha, 'true', runs]);
    expect(ok.status, ok.stderr).toBe(0);
    const off = node(['gate', sha, 'false', runs]);
    expect(off.status).not.toBe(0);
    expect(off.stderr).toContain('not on main');
    // true と false のほかは受けない（git の失敗を「祖先でない」と取り違えない）。
    expect(node(['gate', sha, '', runs]).status).not.toBe(0);
    fs.writeFileSync(runs, '{"message":"Bad credentials"}');
    expect(node(['gate', sha, 'true', runs]).status).not.toBe(0);
  });
  it('assets は、Release の資産の名前（1 行に 1 つ）を受け、足りなければ名前を挙げて 0 以外で終わる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
    const names = path.join(dir, 'names.txt');
    const base = ['dmg', 'dmg.sha256', 'zip', 'zip.sha256'].map((s) => `Hangar-v9.9.9-macos-arm64.${s}`)
      .concat(['Hangar-v9.9.9-windows-x64-setup.exe', 'Hangar-v9.9.9-windows-x64-setup.exe.sha256']);
    fs.writeFileSync(names, `${base.join('\n')}\n`);
    expect(node(['assets', 'v9.9.9', 'false', names]).status).toBe(0);
    const r = node(['assets', 'v9.9.9', 'true', names]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('latest.json');
  });
  it('channel は、試しの道の目録を置き換えるかを true か false で書く（目録が無ければ true）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
    const existing = path.join(dir, 'latest.json');
    expect(node(['channel', existing, '0.2.0-rc.1']).stdout).toBe('true\n');
    fs.writeFileSync(existing, JSON.stringify({ version: '0.2.0-rc.2' }));
    expect(node(['channel', existing, '0.2.0-rc.1']).stdout).toBe('false\n');
    expect(node(['channel', existing, '0.2.0']).stdout).toBe('true\n');
    // 読めない目録は「無い」と取り違えずに止める（古い版で置き換えない）。
    fs.writeFileSync(existing, '<html>rate limited</html>');
    expect(node(['channel', existing, '0.2.0']).status).not.toBe(0);
    fs.writeFileSync(existing, '{}');
    expect(node(['channel', existing, '0.2.0']).status).not.toBe(0);
  });
});
