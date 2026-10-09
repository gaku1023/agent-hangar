import type { CompatDto, CompatState, ReadinessDto, ToolCheckDto } from '@agent-hangar/shared';
import { presentCompat, type CompatProps } from './compat.ts';

/**
 * 欄の下の 1 行の検証（設定の B1）。
 * ok なら「✓ text（note）」、そうでなければ「✗ text」の後ろに直し方（fix か fixCommand）を並べる。
 * soft は無くても動くもので、赤ではなく弱い色で出す。
 */
export type VerifyLine = { ok: boolean; soft: boolean; text: string; note: string | null; fix: string | null; fixCommand: string | null };

export type ToolKey = 'tmux' | 'claude' | 'code' | 'node';

/** tmux の役を担う道具の入れ方。Windows は psmux を入れる。 */
export function muxInstallCommand(platform: string): string {
  return platform === 'win32' ? 'winget install marlocarlo.psmux' : 'brew install tmux';
}

/**
 * 画面を開いている PC の OS。
 * hangar の画面は、サーバと同じ PC のブラウザか WebView で開くので、ブラウザの名乗りから読む。
 */
export function clientPlatform(userAgent: string | undefined = globalThis.navigator?.userAgent): string {
  return userAgent !== undefined && /Windows/.test(userAgent) ? 'win32' : 'darwin';
}

/** ツールごとの直し方。コマンドで直せるものはコマンドを、そうでなければ文を持つ。tmux の入れ方だけは OS で変わるので、toolLine で差し替える。 */
const FIX: Record<ToolKey, { fix: string | null; fixCommand: string | null; soft: boolean }> = {
  tmux: { fix: null, fixCommand: 'brew install tmux', soft: false },
  claude: { fix: 'claude コマンドの絶対パスを入れてください', fixCommand: null, soft: false },
  code: { fix: 'VS Code から code コマンドを入れてください', fixCommand: null, soft: true },
  node: { fix: '同梱のサーバと同じメジャー版の Node のパスを入れてください', fixCommand: null, soft: false },
};

/** 動かせない理由の文。パスがあればパスを主語にする。 */
function problemText(c: ToolCheckDto): string {
  if (c.path === null || c.problem === 'unset') return '見つかりません';
  if (c.problem === 'notFile') return `${c.path} はファイルではありません`;
  if (c.problem === 'notExecutable') return `${c.path} には実行権がありません`;
  return `${c.path} が見つかりません`;
}

export function toolLine(key: ToolKey, c: ToolCheckDto & { auto?: boolean }, platform: string = clientPlatform()): VerifyLine {
  const f = FIX[key];
  if (c.ok) {
    const auto = key === 'node' && c.auto ? '自動で見つけました' : null;
    const note = [c.version, auto].filter((x): x is string => x !== null).join('、');
    return { ok: true, soft: false, text: c.path ?? '', note: note === '' ? null : note, fix: null, fixCommand: null };
  }
  return { ok: false, soft: f.soft, text: problemText(c), note: f.soft ? '無くても動きます' : null, fix: f.fix, fixCommand: key === 'tmux' ? muxInstallCommand(platform) : f.fixCommand };
}

/** ワークスペースの検証。登録したプロジェクトが 1 つも無いのも ✗ にする。何も始められないからである。 */
export function workspaceLine(w: ReadinessDto['workspace']): VerifyLine {
  if (!w.exists) return { ok: false, soft: false, text: `${w.path} が見つかりません`, note: null, fix: 'セッションのあるディレクトリをまとめた場所を入れてください', fixCommand: null };
  if (w.projectCount === 0) return { ok: false, soft: false, text: '直下に、Claude のセッションがあるディレクトリがありません', note: null, fix: null, fixCommand: null };
  return { ok: true, soft: false, text: w.path, note: `プロジェクト ${w.projectCount} 件`, fix: null, fixCommand: null };
}

/** 確認の行の調子。info は止めていない知らせ（未確認の版）で、灰色の ⓘ にする。 */
export type CheckTone = 'ok' | 'info' | 'soft' | 'ng';

/**
 * 始める前の確認の 1 行。
 * path は ✓ のときに添える見つかった場所（互換の行は「X（Y）」）、detail は何のためのものか、または ✗ の理由。
 * command はターミナルで打つ直し方、action は設定で直すための道。
 * tone は印と色、spoken は読み上げの名前に添える状態の語である。
 * compat は互換の行だけが持ち、ずれのときに止めた機能と細目を出す（A4）。
 */
export type CheckItem = { key: 'tmux' | 'claude' | 'workspace' | 'mcp' | 'statusline' | 'compat'; label: string; ok: boolean; soft: boolean; tone: CheckTone; spoken: string; path: string | null; detail: string; command: string | null; action: 'settings' | null; compat?: CompatProps };
export type ChecksProps = { items: CheckItem[]; progress: string };

const withNote = (l: VerifyLine) => (l.note ? `${l.text}（${l.note}）` : l.text);
/** 互換の行の調子。ずれは、MCP と statusline の ✗ と同じ注意の色にする。 */
const COMPAT_TONE: Record<CompatState, CheckTone> = { ok: 'ok', unverified: 'info', drift: 'soft' };
/** 互換の行の読み上げ。準備の語（準備できています、まだです）に寄せず、状態をそのまま言う。 */
const COMPAT_SPOKEN: Record<CompatState, string> = { ok: 'ずれはありません', unverified: 'まだ確かめていない版です', drift: 'ずれがあります' };

/**
 * 確認リストの 6 つ。設定画面の検証と同じ判定（toolLine、workspaceLine、presentCompat）を使う。
 * 「6 つ中 N つ」は ok の行を数える。互換の行は、未確認の版を済んだものとして数え、ずれは数えない。
 * compat はずれの中身（届いていなければ null）、hangarVersion は報告用の写しに書く hangar の版である。
 * compat の無い古いサーバの答えでは、互換の行を出さずに 5 つで数える。
 */
export function presentChecks(r: ReadinessDto, compat: CompatDto | null = null, hangarVersion = ''): ChecksProps {
  const tmux = toolLine('tmux', r.tools.tmux);
  const claude = toolLine('claude', r.tools.claude);
  const ws = workspaceLine(r.workspace);
  const sl = r.statusline;
  const rows: Omit<CheckItem, 'tone' | 'spoken'>[] = [
    { key: 'tmux', label: 'tmux', ok: tmux.ok, soft: false, path: tmux.ok ? withNote(tmux) : null, detail: tmux.ok ? 'ターミナルを動かすのに使います' : `tmux が${tmux.text === '見つかりません' ? '見つかりません' : `使えません。${tmux.text}`}`, command: tmux.ok ? null : 'brew install tmux', action: tmux.ok ? null : 'settings' },
    { key: 'claude', label: 'claude', ok: claude.ok, soft: false, path: claude.ok ? withNote(claude) : null, detail: claude.ok ? 'Claude Code' : `claude が${claude.text === '見つかりません' ? '見つかりません' : `使えません。${claude.text}`}`, command: null, action: claude.ok ? null : 'settings' },
    { key: 'workspace', label: 'ワークスペース', ok: ws.ok, soft: false, path: ws.ok ? withNote(ws) : null, detail: ws.ok ? '直下のディレクトリをプロジェクトとして登録しています' : r.workspace.exists ? `${r.workspace.path} の${ws.text}` : ws.text, command: null, action: ws.ok ? null : 'settings' },
    { key: 'mcp', label: 'MCP', ok: r.mcp.registered, soft: true, path: r.mcp.registered ? '登録済み' : null, detail: 'どのセッションからも hangar の検索と要約を使えるようにします', command: r.mcp.registered ? null : r.commands.mcp, action: null },
    { key: 'statusline', label: 'statusline', ok: sl.installed, soft: true, path: sl.installed ? '追記済み' : null, detail: sl.installed || sl.scriptPath ? 'ヘッダーの使用率ゲージの供給源です' : 'Claude Code の /statusline でスクリプトを作ってから、次を実行してください', command: sl.installed ? null : r.commands.statusline, action: null },
  ];
  const items = rows.map((i): CheckItem => ({ ...i, tone: i.ok ? 'ok' : i.soft ? 'soft' : 'ng', spoken: i.ok ? '準備できています' : 'まだです' }));
  // 古いサーバは compat を返さない。そのときは 6 行目を出さない。
  const summary = (r as Partial<ReadinessDto>).compat;
  if (summary) {
    const c = presentCompat(summary, compat, hangarVersion);
    items.push({ key: 'compat', label: 'Claude Code との互換', ok: c.state !== 'drift', soft: c.state === 'drift', tone: COMPAT_TONE[c.state], spoken: COMPAT_SPOKEN[c.state], path: c.note, detail: c.lead, command: null, action: null, compat: c });
  }
  return { items, progress: `${items.length} つ中 ${items.filter((i) => i.ok).length} つ` };
}
