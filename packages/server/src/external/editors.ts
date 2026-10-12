import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { customArgv, EDITOR_NAMES, KNOWN_EDITORS, splitCommandLine, type EditorCandidateDto, type EditorSetting, type EditorVia, type KnownEditorId } from '@agent-hangar/shared';
import { isCommandName, isExecutableFile } from '../platform/exec.ts';
import { which } from '../config/tools.ts';

// エディタの表と、見つけ方と、起こし方（0.5.0 のエディタの選択）。
// 子プロセスは起こさない。見るのはファイルの有無と PATH だけである（版を読むのは呼び手）。

/**
 * 外の世界への差し込み口。試験は見せかけの PC を渡す。
 * exists はファイルかフォルダがあるか、isExec は実行できるファイルか、which は名前を PATH と既知の置き場から探す、readdir はフォルダの中の名前。
 */
export type EditorHost = {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string;
  exists: (p: string) => boolean; isExec: (p: string) => boolean; which: (name: string) => string | null; readdir: (dir: string) => string[];
};

export function defaultEditorHost(): EditorHost {
  return {
    platform: process.platform, env: process.env, home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    isExec: (p) => isExecutableFile(p),
    which: (name) => which(name),
    readdir: (d) => { try { return fs.readdirSync(d); } catch { return []; } },
  };
}

/** 行の渡し方。code の仲間は -g path:line、Zed は path:line、JetBrains は --line N path。 */
type LineStyle = 'goto' | 'colon' | 'jetbrains';

/**
 * macOS の表の 1 行。apps は /Applications と ~/Applications で探す .app の名前、inApp は .app の中の CLI。
 * cli は PATH に無いときに見る既知の場所（~ はホーム）。url は CLI の無いときに使う URL の仕組みで、無ければ open -a に落とす。
 */
type MacSpec = { apps: string[]; inApp: string; cli: string[]; url: string | null };
/**
 * Windows の表の 1 行。%NAME% は環境変数で、無ければその場所は飛ばす。
 * cli は CLI（.cmd か .exe）の既知の場所、apps はアプリの実行ファイルの場所である。
 * jetbrains は Program Files\JetBrains の下の版ごとのフォルダ（名前の頭）と、その bin の中の実行ファイルの名前。
 */
type WinSpec = { cli: string[]; apps: string[]; jetbrains?: { prefix: string; exe: string } };
type Spec = { names: string[]; line: LineStyle; mac: MacSpec; win: WinSpec };

const TOOLBOX_MAC = '~/Library/Application Support/JetBrains/Toolbox/scripts';
const TOOLBOX_WIN = '%LOCALAPPDATA%\\JetBrains\\Toolbox\\scripts';

const SPECS: Record<KnownEditorId, Spec> = {
  vscode: {
    names: ['code'], line: 'goto',
    mac: { apps: ['Visual Studio Code.app'], inApp: 'Contents/Resources/app/bin/code', cli: [], url: 'vscode' },
    win: { cli: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd', '%ProgramFiles%\\Microsoft VS Code\\bin\\code.cmd'], apps: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe', '%ProgramFiles%\\Microsoft VS Code\\Code.exe'] },
  },
  cursor: {
    names: ['cursor'], line: 'goto',
    mac: { apps: ['Cursor.app'], inApp: 'Contents/Resources/app/bin/cursor', cli: [], url: 'cursor' },
    win: { cli: ['%LOCALAPPDATA%\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd'], apps: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'] },
  },
  windsurf: {
    names: ['windsurf'], line: 'goto',
    mac: { apps: ['Windsurf.app'], inApp: 'Contents/Resources/app/bin/windsurf', cli: ['~/.codeium/windsurf/bin/windsurf'], url: 'windsurf' },
    win: { cli: ['%LOCALAPPDATA%\\Programs\\Windsurf\\bin\\windsurf.cmd'], apps: ['%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe'] },
  },
  zed: {
    names: ['zed'], line: 'colon',
    mac: { apps: ['Zed.app'], inApp: 'Contents/MacOS/cli', cli: [], url: 'zed' },
    // Windows 版の CLI の場所と引数は実機で確かめていない（設計書のエディタの節）。
    win: { cli: ['%LOCALAPPDATA%\\Programs\\Zed\\bin\\zed.exe'], apps: ['%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe'] },
  },
  idea: {
    names: ['idea'], line: 'jetbrains',
    mac: { apps: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app'], inApp: 'Contents/MacOS/idea', cli: [`${TOOLBOX_MAC}/idea`], url: null },
    win: { cli: [`${TOOLBOX_WIN}\\idea.cmd`], apps: [], jetbrains: { prefix: 'IntelliJ IDEA', exe: 'idea64.exe' } },
  },
  webstorm: {
    names: ['webstorm'], line: 'jetbrains',
    mac: { apps: ['WebStorm.app'], inApp: 'Contents/MacOS/webstorm', cli: [`${TOOLBOX_MAC}/webstorm`], url: null },
    win: { cli: [`${TOOLBOX_WIN}\\webstorm.cmd`], apps: [], jetbrains: { prefix: 'WebStorm', exe: 'webstorm64.exe' } },
  },
};

const pathOf = (h: EditorHost) => (h.platform === 'win32' ? path.win32 : path.posix);

/** ~ と %NAME% を直す。直せない環境変数を含む場所は null（探さない）。 */
function expand(p: string, h: EditorHost): string | null {
  let missing = false;
  const out = p.replace(/%([A-Za-z0-9_()]+)%/g, (_m, name: string) => {
    const v = h.env[name];
    if (v === undefined || v === '') { missing = true; return ''; }
    return v;
  });
  if (missing) return null;
  if (out === '~' || out.startsWith('~/')) return pathOf(h).join(h.home, out.slice(2));
  return out;
}

/** 見つけたもの。state の app は CLI が無くアプリだけあること。inAppCli はアプリに入っている起動用のファイルで、無ければ null。 */
export type EditorFound = { state: 'found' | 'app' | 'none'; cli: string | null; app: string | null; inAppCli: string | null };

/** 設定のパスが動くか。名前だけなら PATH から探す。 */
function configured(raw: string | null, h: EditorHost): string | null {
  if (raw === null || raw.trim() === '') return null;
  const p = raw.trim();
  if (isCommandName(p, h.platform)) return h.which(p);
  const full = expand(p, h);
  return full !== null && h.isExec(full) ? full : null;
}

/**
 * エディタを探す。探す順は、設定のパス、PATH と既知の置き場（which）、表の既知の CLI の場所、アプリ。
 * macOS の .app は /Applications と ~/Applications を見る（Spotlight を切っている機械があるので mdfind には頼らない）。
 */
export function findEditor(id: KnownEditorId, h: EditorHost, configuredPath: string | null): EditorFound {
  const spec = SPECS[id];
  const set = configured(configuredPath, h);
  if (set) return { state: 'found', cli: set, app: null, inAppCli: null };
  for (const n of spec.names) {
    const f = h.which(n);
    if (f) return { state: 'found', cli: f, app: null, inAppCli: null };
  }
  const win = h.platform === 'win32';
  if (!win && h.platform !== 'darwin') return { state: 'none', cli: null, app: null, inAppCli: null };
  for (const c of win ? spec.win.cli : spec.mac.cli) {
    const f = expand(c, h);
    if (f && h.isExec(f)) return { state: 'found', cli: f, app: null, inAppCli: null };
  }
  if (win) {
    const apps = spec.win.apps.map((a) => expand(a, h)).filter((a): a is string => a !== null);
    const jb = spec.win.jetbrains;
    const pf = expand('%ProgramFiles%\\JetBrains', h);
    if (jb && pf) {
      // 版の新しいものを先に見る（名前の並びを逆にする）。
      for (const d of h.readdir(pf).filter((n) => n.startsWith(jb.prefix)).sort().reverse()) apps.push(path.win32.join(pf, d, 'bin', jb.exe));
    }
    for (const a of apps) if (h.isExec(a)) return { state: 'app', cli: null, app: a, inAppCli: a };
    return { state: 'none', cli: null, app: null, inAppCli: null };
  }
  for (const base of ['/Applications', pathOf(h).join(h.home, 'Applications')]) {
    for (const name of spec.mac.apps) {
      const app = path.posix.join(base, name);
      if (!h.exists(app)) continue;
      const inApp = path.posix.join(app, spec.mac.inApp);
      return { state: 'app', cli: null, app, inAppCli: h.isExec(inApp) ? inApp : null };
    }
  }
  return { state: 'none', cli: null, app: null, inAppCli: null };
}

/** 設定の候補の一覧。版は呼び手が CLI の --version で埋める。 */
export function detectEditors(h: EditorHost, configuredPath: { id: string; path: string | null } | null = null): EditorCandidateDto[] {
  return KNOWN_EDITORS.map((id) => {
    const f = findEditor(id, h, configuredPath?.id === id ? configuredPath.path : null);
    return { id, name: EDITOR_NAMES[id], state: f.state, path: f.state === 'found' ? f.cli : f.app, version: null };
  });
}

/** 開くもの。line は行で、ファイルのときだけ使う。dir はフォルダを開くこと。 */
export type EditorTarget = { path: string; line: number | null; dir: boolean };
/**
 * 起こし方。exec はそのファイルを引数で起こす。missing はエディタが見つからない（lastPath は最後に指していた場所）。
 * badCommand は任意のコマンドに {path} が無い。
 */
export type EditorLaunch = { kind: 'exec'; via: EditorVia; file: string; args: string[] } | { kind: 'missing'; lastPath: string | null } | { kind: 'badCommand' };

function lineArgs(style: LineStyle, t: EditorTarget): string[] {
  if (t.dir || t.line === null) return [t.path];
  if (style === 'goto') return ['-g', `${t.path}:${t.line}`];
  if (style === 'colon') return [`${t.path}:${t.line}`];
  return ['--line', String(t.line), t.path];
}

/** URL に載せるパス。区切りは / にそろえ、語の中の空白などは %XX にする。Windows のドライブは /C:/ の形にする。 */
function urlPath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  return encodeURI(slashed.startsWith('/') ? slashed : `/${slashed}`);
}

/**
 * 任意のコマンドを起こす形にする。先頭の語が名前なら PATH から探し、パスならそのファイルがあるかを見る。
 * 見つからなければ missing で、lastPath に先頭の語を添える。
 */
function planCustom(e: EditorSetting, t: EditorTarget, h: EditorHost): EditorLaunch {
  const argv = customArgv(e, t);
  if (argv === null) return { kind: 'badCommand' };
  const [head, ...rest] = argv;
  if (!head) return { kind: 'badCommand' };
  const file = isCommandName(head, h.platform) ? h.which(head) : (() => { const f = expand(head, h); return f !== null && h.isExec(f) ? f : null; })();
  if (!file) return { kind: 'missing', lastPath: head };
  return { kind: 'exec', via: 'command', file, args: rest };
}

/** 任意のコマンドの先頭の語（見つからないときの文に使う）。 */
export function customHead(e: EditorSetting): string | null {
  return splitCommandLine(e.fileCmd)[0] ?? null;
}

/**
 * 設定のエディタでどう起こすかを決める。CLI があれば CLI。アプリだけなら、アプリの中の CLI（Windows はアプリの実行ファイル）を同じ引数で起こす。
 * macOS でアプリの中の CLI も無いときは、行のあるファイルは URL（vscode://file/...）で、それ以外は open -a で開く。
 * JetBrains は URL を持たないので open -na <app> --args で渡す。
 */
export function planEditorLaunch(e: EditorSetting, t: EditorTarget, h: EditorHost): EditorLaunch {
  if (e.id === 'custom') return planCustom(e, t, h);
  const spec = SPECS[e.id];
  const f = findEditor(e.id, h, e.path);
  if (f.state === 'found' && f.cli) return { kind: 'exec', via: 'cli', file: f.cli, args: lineArgs(spec.line, t) };
  if (f.state === 'app' && f.app) {
    if (f.inAppCli) return { kind: 'exec', via: 'app', file: f.inAppCli, args: lineArgs(spec.line, t) };
    if (spec.line === 'jetbrains') return { kind: 'exec', via: 'openA', file: 'open', args: ['-na', f.app, '--args', ...lineArgs(spec.line, t)] };
    if (spec.mac.url && !t.dir) return { kind: 'exec', via: 'url', file: 'open', args: [`${spec.mac.url}://file${urlPath(t.path)}${t.line !== null ? `:${t.line}` : ''}`] };
    return { kind: 'exec', via: 'openA', file: 'open', args: ['-a', f.app, t.path] };
  }
  return { kind: 'missing', lastPath: e.path };
}

/** 選んでいるエディタで開けるか。任意のコマンドは先頭の語が見つかるか（found か none）で、path は開くのに使う場所。 */
export function currentEditor(e: EditorSetting, h: EditorHost): { id: EditorSetting['id']; state: EditorFound['state']; path: string | null } {
  if (e.id === 'custom') {
    const plan = planCustom(e, { path: h.home, line: 1, dir: false }, h);
    return { id: 'custom', state: plan.kind === 'exec' ? 'found' : 'none', path: plan.kind === 'exec' ? plan.file : customHead(e) };
  }
  const f = findEditor(e.id, h, e.path);
  return { id: e.id, state: f.state, path: f.state === 'found' ? f.cli : f.app };
}
