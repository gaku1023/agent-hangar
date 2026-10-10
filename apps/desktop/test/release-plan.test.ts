import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareVersions, isPrerelease, manifestUrl, planRelease, PRERELEASE_CHANNEL_TAG, PRERELEASE_TAURI_CONFIG,
  readVersions, setVersionIn, shouldUpdateChannel, versionOfTag, VERSION_FILES,
} from '../scripts/release-plan.ts';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../..');
const script = path.join(app, 'scripts/release-plan.ts');
const node = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args], { encoding: 'utf8' });

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
  it('正式な版は、最新の Release にして、目録は安定版の道（Release の最新）だけに置く', () => {
    expect(planRelease('v0.2.0', same('0.2.0'))).toEqual({ version: '0.2.0', prerelease: false, tauriConfig: '' });
  });
  it('試しの版は prerelease にして、試しの道の endpoint を焼き込む設定を重ねる', () => {
    expect(planRelease('v0.2.0-rc.1', same('0.2.0-rc.1'))).toEqual({ version: '0.2.0-rc.1', prerelease: true, tauriConfig: PRERELEASE_TAURI_CONFIG });
  });
  it('どれか 1 つのファイルの版がタグと違えば、どのファイルが何かを挙げて止める', () => {
    const files = { ...same('0.2.0-rc.1'), 'apps/desktop/src-tauri/Cargo.toml': '0.1.0' };
    expect(() => planRelease('v0.2.0-rc.1', files)).toThrow(/Cargo\.toml.*0\.1\.0/);
    // tauri.conf.json がまだ前の版のまま（版を上げる PR を入れずにタグを打った）
    expect(() => planRelease('v0.2.0', same('0.1.0'))).toThrow(/tauri\.conf\.json/);
    // ファイルが読めなかった（版が見つからない）も止める。
    const missing: Record<string, string | undefined> = { ...same('0.2.0'), 'package-lock.json': undefined };
    expect(() => planRelease('v0.2.0', missing)).toThrow(/package-lock\.json/);
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

describe('リポジトリの版', () => {
  // 版を上げる PR が 1 つのファイルを上げ忘れると、ここで落ちる（タグを打つ前に気づける）。
  it('版の在りかの 5 つが同じ版を名乗る', () => {
    const v = readVersions(root);
    expect(Object.keys(v).sort()).toEqual([...VERSION_FILES].sort());
    const values = new Set(Object.values(v));
    expect(values.size, JSON.stringify(v)).toBe(1);
    expect([...values][0]).toMatch(/^\d+\.\d+\.\d+/);
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
  it('plan ジョブが計画を決め、作るジョブはすべてその後に回る', () => {
    expect(job('plan')).toContain('release-plan.ts plan "$GITHUB_REF_NAME"');
    expect(job('macos')).toMatch(/needs: plan\n/);
    expect(job('windows')).toMatch(/needs: plan\n/);
    expect(job('updater-manifest')).toMatch(/needs: \[plan, /);
    // 照合は plan の 1 か所にする（tauri.conf.json だけを見る古い段は残さない）。
    expect(release).not.toContain("require('./apps/desktop/src-tauri/tauri.conf.json').version");
  });
  it('試しの版は prerelease で、Release の最新にしない', () => {
    expect(job('macos')).toContain("prerelease: ${{ needs.plan.outputs.prerelease == 'true' }}");
    expect(job('macos')).toContain("make_latest: ${{ needs.plan.outputs.prerelease == 'true' && 'false' || 'true' }}");
  });
  it('試しの版の build は、macOS も Windows も試しの道の endpoint を重ねる', () => {
    expect(job('macos')).toContain('EXTRA_CONFIG: ${{ needs.plan.outputs.tauri-config }}');
    expect(job('macos')).toContain('--config "$EXTRA_CONFIG"');
    expect(job('windows')).toContain('extra-config: ${{ needs.plan.outputs.tauri-config }}');
    expect(action).toContain("$extra += @('--config', $env:EXTRA_CONFIG)");
  });
  it('試しの道の目録は prerelease の Release に、新しいときだけ置く', () => {
    const m = job('updater-manifest');
    expect(m).toContain('--prerelease');
    expect(m).toContain('isPrerelease');
    expect(m).toContain('release-plan.ts channel');
    expect(m).toContain('CHANNEL: ${{ needs.plan.outputs.channel-tag }}');
  });
});

// release.yml の plan ジョブは npm ci をしない。Node が型を剥がすだけで動き、GitHub の出力の形で書く。
describe('release.yml から呼ぶ形', () => {
  it('plan は版と prerelease と重ねる設定を key=value で書き、食い違えば 0 以外で終わる', () => {
    const v = readVersions(root)['apps/desktop/src-tauri/tauri.conf.json']!;
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, 'plan', `v${v}`, root], { encoding: 'utf8' });
    expect(out).toBe(`version=${v}\nprerelease=${isPrerelease(v)}\ntauri-config=${isPrerelease(v) ? PRERELEASE_TAURI_CONFIG : ''}\nchannel-tag=${PRERELEASE_CHANNEL_TAG}\n`);
    const bad = node(['plan', 'v99.0.0', root]);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('99.0.0');
  });
  it('channel は、試しの道の目録を置き換えるかを true か false で書く（目録が無ければ true）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
    const existing = path.join(dir, 'latest.json');
    expect(node(['channel', existing, '0.2.0-rc.1']).stdout).toBe('true\n');
    fs.writeFileSync(existing, JSON.stringify({ version: '0.2.0-rc.2' }));
    expect(node(['channel', existing, '0.2.0-rc.1']).stdout).toBe('false\n');
    expect(node(['channel', existing, '0.2.0']).stdout).toBe('true\n');
  });
});
