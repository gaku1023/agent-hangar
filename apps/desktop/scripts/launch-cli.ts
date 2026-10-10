/**
 * Windows の `bin\hangar.cmd` が呼ぶ入口。hangar.sh の Windows 版にあたる。
 * 配布版に同梱した cli.mjs は、better-sqlite3 などのネイティブモジュールを隣から読む。
 * ネイティブモジュールは Node の ABI に縛られるので、manifest.json と同じメジャー版とアーキテクチャの Node だけで動かす。
 * cmd は batch で JSON を読めないので、PATH などで見つけた Node でこの入口だけを動かし、残りはここで決める。
 * この入口は依存を持たない。同梱の束の中で単独の 1 ファイルとして動く。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Want = { nodeMajor: number; arch: string };
export type Probed = { major: number; arch: string };
/**
 * 候補を 1 つ調べた答え。
 * 版とアーキが読めたとき（Probed）のほか、ファイルが無い（missing）、起動できないか Node として答えない（failed）、時間内に答えない（timeout）に分ける。
 * 見つからないときの文で、利用者が次の一手を選べるようにするためである。
 */
export type ProbeResult = Probed | 'missing' | 'failed' | 'timeout';
/** 調べた候補とその答え。 */
export type Tried = { node: string; result: ProbeResult };

/** 候補を 1 つ起動して版とアーキテクチャを訊く。 */
export function probeNode(node: string): ProbeResult {
  const r = spawnSync(node, ['-p', 'process.versions.node.split(".")[0] + " " + process.arch'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    if (code === 'ETIMEDOUT') return 'timeout';
    return 'failed';
  }
  if (r.status !== 0) return 'failed';
  // 前置きや後置きの行が混ざっても拾えるように、全行から探す。
  for (const line of r.stdout.split(/\r?\n/).reverse()) {
    const m = /^(\d+) ([a-z0-9]+)$/.exec(line.trim());
    if (m) return { major: Number(m[1]), arch: m[2]! };
  }
  return 'failed';
}

const isProbed = (r: ProbeResult): r is Probed => typeof r === 'object';

/**
 * 候補を先頭から見て、版もアーキも合う最初の 1 つを返す。
 * 合うものを見つけるまでに調べた候補と、その答えも返す。見つからないときの文に使う。
 * 同じ場所は 1 度しか探らない。Windows のパスは大文字小文字を区別しない。
 */
export function chooseNode(candidates: string[], want: Want, probe: (node: string) => ProbeResult): { node: string | undefined; tried: Tried[] } {
  const seen = new Set<string>();
  const tried: Tried[] = [];
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const result = probe(c);
    tried.push({ node: c, result });
    if (isProbed(result) && result.major === want.nodeMajor && result.arch === want.arch) return { node: c, tried };
  }
  return { node: undefined, tried };
}

const describeResult = (want: Want, r: ProbeResult): string => {
  if (r === 'missing') return 'ファイルが無い';
  if (r === 'failed') return '起動できないか、Node として答えない';
  if (r === 'timeout') return '時間内に答えない';
  const what = `Node ${r.major}（${r.arch}）`;
  if (r.major !== want.nodeMajor) return `${what}。版が違う`;
  if (r.arch !== want.arch) return `${what}。アーキテクチャが違う`;
  return what;
};

/**
 * 合う Node が見つからなかったときの文。
 * 何を探したか、いま動いている Node が何か、どの場所をどの順に調べて、それぞれがなぜ合わなかったかを並べ、最後に次の一手を書く。
 */
export function describeNotFound(want: Want, mine: { path: string; result: ProbeResult }, tried: Tried[], settingsFile: string): string {
  const lines = [`Node ${want.nodeMajor}（${want.arch}）が見つかりません。`, `いま動いている Node：${isProbed(mine.result) ? `${mine.result.major}（${mine.result.arch}）` : '版は不明'}、${mine.path}`];
  if (tried.length === 0) {
    lines.push('調べた場所はありません。');
  } else {
    lines.push('調べた場所（この順に探し、版とアーキテクチャが合う最初の 1 つを使います）：');
    tried.forEach((t, i) => lines.push(`  ${i + 1}. ${t.node}：${describeResult(want, t.result)}`));
  }
  lines.push(`Node ${want.nodeMajor}（${want.arch}）を入れるか、環境変数 HANGAR_NODE か ${settingsFile} の nodePath で場所を指定してください。`);
  return lines.join('\n') + '\n';
}

const versionKey = (name: string): [number, number, number] | undefined => {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/** 環境変数の値を、名前の大文字小文字を問わず引く。Windows の PATH は Path と書かれることが多い。 */
const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
};

/**
 * Windows で Node がありそうな場所。
 * 順は、HANGAR_NODE、settings.json の nodePath、公式のインストーラの入れ先、nvm-windows（新しい版が先）、PATH の順。
 * HANGAR_NODE のあとは、殻（src-tauri の node.rs の windows_node_paths）の探索と同じ並びにそろえてある。
 * PATH は、項目ごとの node.exe のうち実在するものを、PATH の順にすべて並べる。
 * winget の Packages や Links、fnm、volta など、PATH に入っていればどの入れ方の Node でも候補になる。
 * nvm-windows と PATH は、実在しないものを並べない。見つからないときの文が読みにくくなるためである（殻と同じ）。
 * パスは常に Windows の書式で組むので、どの OS 上でも同じ答えになる。
 */
export function windowsNodeCandidates(env: NodeJS.ProcessEnv, settingsNodePath: string | undefined, listDir: (dir: string) => string[], isFile: (p: string) => boolean): string[] {
  const w = path.win32;
  const all: string[] = [];
  if (env.HANGAR_NODE) all.push(env.HANGAR_NODE);
  if (settingsNodePath) all.push(settingsNodePath);
  const programFiles = envValue(env, 'ProgramFiles');
  const localAppData = envValue(env, 'LOCALAPPDATA');
  const nvmSymlink = envValue(env, 'NVM_SYMLINK');
  const nvmHome = envValue(env, 'NVM_HOME');
  if (programFiles) all.push(w.join(programFiles, 'nodejs', 'node.exe'));
  if (localAppData) all.push(w.join(localAppData, 'Programs', 'nodejs', 'node.exe'));
  if (nvmSymlink) all.push(w.join(nvmSymlink, 'node.exe'));
  if (nvmHome) {
    const versions = listDir(nvmHome)
      .map((n) => ({ n, k: versionKey(n) }))
      .filter((x): x is { n: string; k: [number, number, number] } => x.k !== undefined)
      .sort((a, b) => b.k[0] - a.k[0] || b.k[1] - a.k[1] || b.k[2] - a.k[2]);
    for (const v of versions) {
      const p = w.join(nvmHome, v.n, 'node.exe');
      if (isFile(p)) all.push(p);
    }
  }
  for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // 相対の項目（. など）は、どこから打ったかで指す先が変わるので見ない。
    if (dir === '' || !/^([a-zA-Z]:[\\/]|[\\/]{2})/.test(dir)) continue;
    const p = w.join(dir, 'node.exe');
    if (isFile(p)) all.push(p);
  }
  // Windows のパスは大文字小文字を区別しない。
  const seen = new Set<string>();
  return all.filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
}

function readSettingsNodePath(hangarHome: string): string | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(hangarHome, 'settings.json'), 'utf8')) as { nodePath?: unknown };
    return typeof v.nodePath === 'string' && v.nodePath.trim() !== '' ? v.nodePath.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readWant(dist: string): Want | string {
  const file = path.join(dist, 'manifest.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return `${file} がありません。アプリの中身が壊れています。agent-hangar を入れ直してください。`;
  }
  try {
    const m = JSON.parse(text) as { nodeMajor?: unknown; arch?: unknown };
    if (typeof m.nodeMajor === 'number' && typeof m.arch === 'string') return { nodeMajor: m.nodeMajor, arch: m.arch };
  } catch {
    // 下の案内へ進む。
  }
  return `${file} から Node の版とアーキテクチャを読めません。アプリの中身が壊れています。agent-hangar を入れ直してください。`;
}

/**
 * dist は束の根（この入口の置き場）。
 * 走っている Node が合えばそのまま cli.mjs を動かす。
 * 合わなければ、合う Node を探して、同じ引数でこの入口を渡し直す。
 */
export async function run(dist: string, argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const want = readWant(dist);
  if (typeof want === 'string') {
    process.stderr.write(want + '\n');
    process.exitCode = 1;
    return;
  }
  const mine: Probed = { major: Number(process.versions.node.split('.')[0]), arch: process.arch };
  // 渡し直された側は、探した側が確かめた Node なので、もう一度は確かめない。輪になるのを避けるためでもある。
  if (env.HANGAR_LAUNCHED === '1' || (mine.major === want.nodeMajor && mine.arch === want.arch)) {
    // 同梱した UI の場所を、束の中から渡す。hangar start が子として起こす server.mjs もこの値を継ぐ。
    process.env.HANGAR_UI_DIST = path.join(dist, 'ui');
    await import(pathToFileURL(path.join(dist, 'cli.mjs')).href);
    return;
  }
  const home = env.HANGAR_HOME || path.join(os.homedir(), '.agent-hangar');
  const candidates = windowsNodeCandidates(
    env,
    readSettingsNodePath(home),
    (d) => {
      try {
        return fs.readdirSync(d);
      } catch {
        return [];
      }
    },
    (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
  );
  // いま動いている Node は、もう答えが分かっているので起こし直さない。
  const self = process.execPath.toLowerCase();
  const { node: found, tried } = chooseNode(candidates, want, (c) => (c.toLowerCase() === self ? mine : probeNode(c)));
  if (found) {
    const r = spawnSync(found, [path.join(dist, 'launch-cli.mjs'), ...argv], { stdio: 'inherit', env: { ...env, HANGAR_LAUNCHED: '1' }, windowsHide: true });
    process.exitCode = r.status ?? 1;
    return;
  }
  process.stderr.write(describeNotFound(want, { path: process.execPath, result: mine }, tried, path.join(home, 'settings.json')));
  process.exitCode = 1;
}
