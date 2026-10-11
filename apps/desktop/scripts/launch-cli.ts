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
import { decideLanguage, osDisplayLanguage } from '../../../packages/server/src/i18n/osLanguage.ts';

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

/** 見つからないときの文の言語。殻の札と同じく、日本語と英語の 2 つだけである。 */
export type Lang = 'ja' | 'en';

/**
 * 見つからないときの文の言語を決める。サーバの設定の読み込みと殻の札（src-tauri の bootfail.rs）と同じ決め方で、読み口も同じ関数である（decideLanguage）。
 * 設定（settings.json）の language、設定はあるが言語が無ければ日本語、設定が無いか読めなければ OS の表示言語。
 * この入口は設定を書かない。初めての起動の言語を書くのは、殻かサーバである。
 */
export function cliLanguage(settingsText: string | undefined, os: () => Lang | undefined = osDisplayLanguage): Lang {
  return decideLanguage(settingsText, os).language;
}

/** Windows で Node を入れる命令。README の Windows の前提と、殻の札（node.rs の winget_command）と同じ形にする。 */
export const WINGET_NODE = (major: number): string => `winget install -e --id OpenJS.NodeJS.${major}`;

const TEXT = {
  ja: {
    notFound: (w: Want) => `Node ${w.nodeMajor}（${w.arch}）が見つかりません。`,
    running: (what: string, at: string) => `いま動いている Node：${what}、${at}`,
    runningOf: (p: Probed) => `${p.major}（${p.arch}）`,
    unknownVersion: '版は不明',
    noPlaces: '調べた場所はありません。',
    places: '調べた場所（この順に探し、版とアーキテクチャが合う最初の 1 つを使います）：',
    place: (i: number, node: string, what: string) => `  ${i}. ${node}：${what}`,
    missing: 'ファイルが無い',
    failed: '起動できないか、Node として答えない',
    timeout: '時間内に答えない',
    probed: (p: Probed) => `Node ${p.major}（${p.arch}）`,
    wrongVersion: (what: string) => `${what}。版が違う`,
    wrongArch: (what: string) => `${what}。アーキテクチャが違う`,
    winget: (w: Want) => `PowerShell で ${WINGET_NODE(w.nodeMajor)} を実行して入れれば、次から見つけます。`,
    nvm: (w: Want) => `nvm-windows を使うなら、nvm install ${w.nodeMajor} で入れた版も見つけます（fnm、Volta、scoop で入れた版と、PATH にある版も探します）。`,
    elsewhere: (settings: string) => `ほかの場所に入れたなら、環境変数 HANGAR_NODE か ${settings} の nodePath で場所を指定してください。`,
  },
  en: {
    notFound: (w: Want) => `Node ${w.nodeMajor} (${w.arch}) was not found.`,
    running: (what: string, at: string) => `Node running now: ${what}, ${at}`,
    runningOf: (p: Probed) => `${p.major} (${p.arch})`,
    unknownVersion: 'unknown version',
    noPlaces: 'No places to check.',
    places: 'Places checked (in this order; the first one whose version and architecture match is used):',
    place: (i: number, node: string, what: string) => `  ${i}. ${node}: ${what}`,
    missing: 'no such file',
    failed: 'cannot start it, or it does not answer as Node',
    timeout: 'no answer in time',
    probed: (p: Probed) => `Node ${p.major} (${p.arch})`,
    wrongVersion: (what: string) => `${what}, wrong version`,
    wrongArch: (what: string) => `${what}, wrong architecture`,
    winget: (w: Want) => `Install it with ${WINGET_NODE(w.nodeMajor)} in PowerShell and it is found from then on.`,
    nvm: (w: Want) => `With nvm-windows, a version installed with nvm install ${w.nodeMajor} is found too (Hangar also looks in fnm, Volta, scoop, and PATH).`,
    elsewhere: (settings: string) => `If it is installed somewhere else, set the HANGAR_NODE environment variable or nodePath in ${settings} to its location.`,
  },
} as const;

const describeResult = (want: Want, r: ProbeResult, lang: Lang): string => {
  const t = TEXT[lang];
  if (r === 'missing') return t.missing;
  if (r === 'failed') return t.failed;
  if (r === 'timeout') return t.timeout;
  const what = t.probed(r);
  if (r.major !== want.nodeMajor) return t.wrongVersion(what);
  if (r.arch !== want.arch) return t.wrongArch(what);
  return what;
};

/**
 * 合う Node が見つからなかったときの文。
 * 何を探したか、いま動いている Node が何か、どの場所をどの順に調べて、それぞれがなぜ合わなかったかを並べ、最後に次の一手を書く。
 * 次の一手は、winget の 1 行を先に案内し、nvm-windows はほかの入れ方として添える（殻の札と同じ）。
 */
export function describeNotFound(want: Want, mine: { path: string; result: ProbeResult }, tried: Tried[], settingsFile: string, lang: Lang = 'ja'): string {
  const t = TEXT[lang];
  const lines = [t.notFound(want), t.running(isProbed(mine.result) ? t.runningOf(mine.result) : t.unknownVersion, mine.path)];
  if (tried.length === 0) {
    lines.push(t.noPlaces);
  } else {
    lines.push(t.places);
    tried.forEach((x, i) => lines.push(t.place(i + 1, x.node, describeResult(want, x.result, lang))));
  }
  lines.push(t.winget(want), t.nvm(want), t.elsewhere(settingsFile));
  return lines.join('\n') + '\n';
}

const versionKey = (name: string): [number, number, number] | undefined => {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/**
 * fnm、Volta、scoop の版ごとのディレクトリの名前から版を読む。`v22.14.0` と `22.14.0` の 3 つ組だけを採る。
 * 殻（node.rs の parse_dir_version）と同じく、`current` のような別名は版と読まない。
 */
const dirVersionKey = (name: string): [number, number, number] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/** 版の新しい順に並べる。 */
const newestFirst = (a: { k: [number, number, number] }, b: { k: [number, number, number] }) => b.k[0] - a.k[0] || b.k[1] - a.k[1] || b.k[2] - a.k[2];

/** scoop で Node を入れるアプリの名前か。`nodejs`、`nodejs-lts`、versions の桶の `nodejs22` などを採る（殻の is_scoop_node_app と同じ）。 */
const isScoopNodeApp = (name: string): boolean => /^nodejs(-lts|\d+)?$/.test(name);

/** 環境変数の値を、名前の大文字小文字を問わず引く。Windows の PATH は Path と書かれることが多い。 */
const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
};

/**
 * Windows で Node がありそうな場所。
 * 順は、HANGAR_NODE、settings.json の nodePath、公式のインストーラの入れ先、nvm-windows（新しい版が先）、fnm、Volta、scoop（それぞれ新しい版が先）、PATH の順。
 * HANGAR_NODE のあとは、殻（src-tauri の node.rs の windows_node_paths）の探索と同じ並びにそろえてある。
 * fnm、Volta、scoop の置き場は、環境変数（FNM_DIR、VOLTA_HOME、SCOOP）があればそれ、無ければ既定の場所（%APPDATA%\fnm、%LOCALAPPDATA%\Volta、%USERPROFILE%\scoop）である。
 * PATH は、項目ごとの node.exe のうち実在するものを、PATH の順にすべて並べる。
 * winget の Packages や Links など、PATH に入っていればどの入れ方の Node でも候補になる。
 * nvm-windows、版の管理ツール、PATH は、実在しないものを並べない。見つからないときの文が読みにくくなるためである（殻と同じ）。
 * パスは常に Windows の書式で組むので、どの OS 上でも同じ答えになる。
 */
export function windowsNodeCandidates(env: NodeJS.ProcessEnv, settingsNodePath: string | undefined, listDir: (dir: string) => string[], isFile: (p: string) => boolean): string[] {
  const w = path.win32;
  const all: string[] = [];
  if (env.HANGAR_NODE) all.push(env.HANGAR_NODE);
  if (settingsNodePath) all.push(settingsNodePath);
  const programFiles = envValue(env, 'ProgramFiles');
  const localAppData = envValue(env, 'LOCALAPPDATA');
  const appData = envValue(env, 'APPDATA');
  const userProfile = envValue(env, 'USERPROFILE');
  const nvmSymlink = envValue(env, 'NVM_SYMLINK');
  const nvmHome = envValue(env, 'NVM_HOME');
  if (programFiles) all.push(w.join(programFiles, 'nodejs', 'node.exe'));
  if (localAppData) all.push(w.join(localAppData, 'Programs', 'nodejs', 'node.exe'));
  if (nvmSymlink) all.push(w.join(nvmSymlink, 'node.exe'));
  if (nvmHome) {
    const versions = listDir(nvmHome)
      .map((n) => ({ n, k: versionKey(n) }))
      .filter((x): x is { n: string; k: [number, number, number] } => x.k !== undefined)
      .sort(newestFirst);
    for (const v of versions) {
      const p = w.join(nvmHome, v.n, 'node.exe');
      if (isFile(p)) all.push(p);
    }
  }
  /** parent の下の版ごとのディレクトリの leaf にある Node を、実在するものだけ新しい版から並べる。 */
  const versioned = (parent: string, ...leaf: string[]): string[] =>
    listDir(parent)
      .map((n) => ({ n, k: dirVersionKey(n) }))
      .filter((x): x is { n: string; k: [number, number, number] } => x.k !== undefined)
      .sort(newestFirst)
      .map((v) => w.join(parent, v.n, ...leaf))
      .filter(isFile);
  const fnm = envValue(env, 'FNM_DIR') || (appData ? w.join(appData, 'fnm') : undefined);
  if (fnm) all.push(...versioned(w.join(fnm, 'node-versions'), 'installation', 'node.exe'));
  const volta = envValue(env, 'VOLTA_HOME') || (localAppData ? w.join(localAppData, 'Volta') : undefined);
  if (volta) all.push(...versioned(w.join(volta, 'tools', 'image', 'node'), 'node.exe'));
  const scoop = envValue(env, 'SCOOP') || (userProfile ? w.join(userProfile, 'scoop') : undefined);
  if (scoop) {
    const apps = w.join(scoop, 'apps');
    for (const app of listDir(apps).filter(isScoopNodeApp).sort()) all.push(...versioned(w.join(apps, app), 'node.exe'));
  }
  for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // 相対の項目（. など）は、どこから打ったかで指す先が変わるので見ない。
    if (dir === '' || !isFullWindowsPath(dir)) continue;
    const p = w.join(dir, 'node.exe');
    if (isFile(p)) all.push(p);
  }
  // Windows のパスは大文字小文字を区別しない。
  const seen = new Set<string>();
  return all.filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
}

/** ドライブから始まるか、UNC のパスか。相対のパスと、ドライブの無い \x は、どこから打ったかで指す先が変わる。 */
export const isFullWindowsPath = (p: string): boolean => /^([a-zA-Z]:[\\/]|[\\/]{2})/.test(p);

function readSettingsText(hangarHome: string): string | undefined {
  try {
    return fs.readFileSync(path.join(hangarHome, 'settings.json'), 'utf8');
  } catch {
    return undefined;
  }
}

function settingsNodePath(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as { nodePath?: unknown };
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
  // 印は読んだらすぐ消す。残すと cli.mjs から、hangar start が起こすサーバ、tmux、ペインの中の hangar まで届き、
  // ペインの中の hangar が版の確かめを飛ばして、PATH の先頭の Node で cli.mjs を直に読む。
  const launched = env.HANGAR_LAUNCHED === '1';
  delete env.HANGAR_LAUNCHED;
  delete process.env.HANGAR_LAUNCHED;
  if (launched || (mine.major === want.nodeMajor && mine.arch === want.arch)) {
    // 同梱した UI の場所を、束の中から渡す。hangar start が子として起こす server.mjs もこの値を継ぐ。
    process.env.HANGAR_UI_DIST = path.join(dist, 'ui');
    await import(pathToFileURL(path.join(dist, 'cli.mjs')).href);
    return;
  }
  const home = env.HANGAR_HOME || path.join(os.homedir(), '.agent-hangar');
  const settingsText = readSettingsText(home);
  const candidates = windowsNodeCandidates(
    env,
    settingsNodePath(settingsText),
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
  // 絶対パスでない候補（名前だけの nodePath など）は起こさない。起こすと PATH から引かれ、殻（node.rs）が使う Node と食い違う。
  const { node: found, tried } = chooseNode(candidates, want, (c) => (!isFullWindowsPath(c) && !path.isAbsolute(c) ? 'missing' : c.toLowerCase() === self ? mine : probeNode(c)));
  if (found) {
    const r = spawnSync(found, [path.join(dist, 'launch-cli.mjs'), ...argv], { stdio: 'inherit', env: { ...env, HANGAR_LAUNCHED: '1' }, windowsHide: true });
    process.exitCode = r.status ?? 1;
    return;
  }
  // OS の言語は、地域の書式（Intl の既定の locale）ではなく表示言語で読む。
  const lang = cliLanguage(settingsText);
  process.stderr.write(describeNotFound(want, { path: process.execPath, result: mine }, tried, path.join(home, 'settings.json'), lang));
  process.exitCode = 1;
}
