/**
 * エディタの選択（0.5.0）。
 * 「<名前> で開く」と、変更したファイルの行から開くときに使うアプリを、利用者が選ぶ。
 * 選べるのは決まった表のエディタと、任意のコマンドである。
 * 表の中身（探す場所、行の渡し方）はサーバの external/editors.ts にある。ここは画面とサーバが共に使う名前と形だけを持つ。
 */

/** 表にあるエディタ。並びは設定の候補の一覧の並びである。 */
export const KNOWN_EDITORS = ['vscode', 'cursor', 'windsurf', 'zed', 'idea', 'webstorm'] as const;
export type KnownEditorId = (typeof KNOWN_EDITORS)[number];
export type EditorId = KnownEditorId | 'custom';

/** 製品の名前。訳さない（用語集の決まり）。 */
export const EDITOR_NAMES: Record<KnownEditorId, string> = {
  vscode: 'VS Code', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed', idea: 'IntelliJ IDEA', webstorm: 'WebStorm',
};

/**
 * 任意のコマンドが、ターミナルの中で動くエディタ（vim、nvim、hx など）のとき、どこで起こすか。
 * none はふつうのアプリとしてそのまま起こす。shell はそのセッションのシェルタブを 1 枚足してその中で起こす（実行中の run が無いときは外部ターミナル）。
 * ext は設定のターミナルアプリの新しい窓で起こす。
 */
export const EDITOR_TERMINALS = ['none', 'shell', 'ext'] as const;
export type EditorTerminal = (typeof EDITOR_TERMINALS)[number];

/**
 * エディタの設定。
 * path は表のエディタの CLI の場所で、null なら自動で見つけた場所を使う。任意のコマンドでは使わない。
 * fileCmd と dirCmd は任意のコマンドだけが使う。fileCmd は {path}（必須）と {line} を差し込む。dirCmd が空なら fileCmd から作る（dirCommandOf）。
 */
export type EditorSetting = { id: EditorId; path: string | null; fileCmd: string; dirCmd: string; terminal: EditorTerminal };

export const DEFAULT_EDITOR: EditorSetting = { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' };

export function isEditorId(v: unknown): v is EditorId {
  return v === 'custom' || (KNOWN_EDITORS as readonly unknown[]).includes(v);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const nullableStr = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * 保存された値を EditorSetting に読み替える。
 * 0.4.0 までの設定は `codePath`（VS Code の code の場所）だけを持つので、editor が無ければ `{ id: 'vscode', path: codePath }` にする。
 * 知らない id や形の壊れた値は既定（VS Code、自動）にする。
 */
export function editorSettingOf(raw: unknown, legacyCodePath?: string | null): EditorSetting {
  if (raw === undefined || raw === null) return { ...DEFAULT_EDITOR, path: nullableStr(legacyCodePath) };
  if (typeof raw !== 'object') return { ...DEFAULT_EDITOR };
  const o = raw as Record<string, unknown>;
  const id = isEditorId(o.id) ? o.id : 'vscode';
  const terminal = (EDITOR_TERMINALS as readonly unknown[]).includes(o.terminal) ? (o.terminal as EditorTerminal) : 'none';
  return { id, path: nullableStr(o.path), fileCmd: str(o.fileCmd), dirCmd: str(o.dirCmd), terminal };
}

/** 画面に出す名前。任意のコマンドは null で、呼び手は「エディタ」と言う。 */
export function editorNameOf(id: EditorId): string | null {
  return id === 'custom' ? null : EDITOR_NAMES[id];
}

/**
 * コマンドの 1 行を語に分ける。シェルは通さない。
 * 空白で区切り、" か ' で包んだ所は空白を含めて 1 語にする（包みの記号は落とす）。閉じていない引用は行末までを 1 語にする。
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** フォルダを開くコマンドを、ファイルを開くコマンドから作る。{path}:{line} と {path}#{line} は {path} にし、残りの {line} を含む語は外す。 */
export function dirCommandOf(fileCmd: string): string {
  return splitCommandLine(fileCmd.replace(/\{path\}[:#]\{line\}/g, '{path}')).filter((w) => !w.includes('{line}')).map(quoteWord).join(' ');
}

const quoteWord = (w: string) => (w === '' || /\s/.test(w) ? `"${w}"` : w);

/**
 * 任意のコマンドの語の並び。{path} と {line} を差し込む。語の中での置き換えなので、空白を含むパスも 1 語のまま渡る。
 * {path} の無いコマンドは null（どのファイルを開くかが渡らない）。
 */
export function customArgv(o: { fileCmd: string; dirCmd: string }, target: { path: string; line: number | null; dir: boolean }): string[] | null {
  const tpl = target.dir ? (o.dirCmd.trim() !== '' ? o.dirCmd : dirCommandOf(o.fileCmd)) : o.fileCmd;
  if (!tpl.includes('{path}')) return null;
  const line = String(target.line ?? 1);
  const argv = splitCommandLine(tpl).map((w) => w.replaceAll('{path}', target.path).replaceAll('{line}', line));
  return argv.length > 0 ? argv : null;
}

/** 見本の 1 行。語に空白があれば " で包んで並べる（設定の欄の下の見本）。 */
export function previewCommand(argv: string[]): string {
  return argv.map(quoteWord).join(' ');
}

/**
 * この PC で見つけたエディタ（GET /api/editors）。
 * state の found は CLI がある、app はアプリだけある（CLI は無い）、none はどちらも無い。
 * path は found なら CLI の場所、app ならアプリの場所である。version は CLI の `--version` から読んだ版。
 */
export type EditorDetectState = 'found' | 'app' | 'none';
export type EditorCandidateDto = { id: KnownEditorId; name: string; state: EditorDetectState; path: string | null; version: string | null };
/**
 * 見つけたエディタの一覧と、選んでいるエディタの状態。
 * current は設定のエディタで開けるかで、任意のコマンドなら先頭の語が見つかるか（found か none）。path は開くのに使う場所。
 */
export type EditorsDto = { candidates: EditorCandidateDto[]; current: { id: EditorId; state: EditorDetectState; path: string | null } };
/**
 * 「テスト」（POST /api/editor/test）の答え。
 * via は実際に起こした経路で、cli は CLI、app はアプリの中の CLI か実行ファイル、url は URL、openA は macOS の open -a、command は任意のコマンド、terminal はターミナルの中。
 * file は開いた見本のファイル（3 行目を開く）。失敗したときは ok が偽で、message に理由がある。missing はエディタが見つからなかったこと。
 */
export type EditorTestDto = { ok: boolean; via: EditorVia | null; file: string; message: string | null; missing?: boolean };
export type EditorVia = 'cli' | 'app' | 'url' | 'openA' | 'command' | 'terminal';
/**
 * エディタで開く要求が、エディタが見つからなくて断られたときの答え（409）。
 * 画面は「<名前> が見つかりません」の面を出し、ほかに見つかっているエディタで今回だけ開く手を並べる。
 */
export type EditorMissingDto = { code: 'editor_missing'; error: string; editor: EditorId; name: string | null; lastPath: string | null; others: KnownEditorId[] };
