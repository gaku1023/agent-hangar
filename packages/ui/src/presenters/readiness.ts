import type { ReadinessDto, ToolCheckDto } from '@agent-hangar/shared';

/**
 * 欄の下の 1 行の検証（設定の B1）。
 * ok なら「✓ text（note）」、そうでなければ「✗ text」の後ろに直し方（fix か fixCommand）を並べる。
 * soft は無くても動くもので、赤ではなく弱い色で出す。
 */
export type VerifyLine = { ok: boolean; soft: boolean; text: string; note: string | null; fix: string | null; fixCommand: string | null };

export type ToolKey = 'tmux' | 'claude' | 'code' | 'node';

/** ツールごとの直し方。コマンドで直せるものはコマンドを、そうでなければ文を持つ。 */
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

export function toolLine(key: ToolKey, c: ToolCheckDto & { auto?: boolean }): VerifyLine {
  const f = FIX[key];
  if (c.ok) {
    const auto = key === 'node' && c.auto ? '自動で見つけました' : null;
    const note = [c.version, auto].filter((x): x is string => x !== null).join('、');
    return { ok: true, soft: false, text: c.path ?? '', note: note === '' ? null : note, fix: null, fixCommand: null };
  }
  return { ok: false, soft: f.soft, text: problemText(c), note: f.soft ? '無くても動きます' : null, fix: f.fix, fixCommand: f.fixCommand };
}

/** ワークスペースの検証。登録したプロジェクトが 1 つも無いのも ✗ にする。何も始められないからである。 */
export function workspaceLine(w: ReadinessDto['workspace']): VerifyLine {
  if (!w.exists) return { ok: false, soft: false, text: `${w.path} が見つかりません`, note: null, fix: 'セッションのあるディレクトリをまとめた場所を入れてください', fixCommand: null };
  if (w.projectCount === 0) return { ok: false, soft: false, text: '直下に、Claude のセッションがあるディレクトリがありません', note: null, fix: null, fixCommand: null };
  return { ok: true, soft: false, text: w.path, note: `プロジェクト ${w.projectCount} 件`, fix: null, fixCommand: null };
}

/**
 * 始める前の確認の 1 行。
 * path は ✓ のときに添える見つかった場所、detail は何のためのものか、または ✗ の理由。
 * command はターミナルで打つ直し方、action は設定で直すための道。
 */
export type CheckItem = { key: 'tmux' | 'claude' | 'workspace' | 'mcp' | 'statusline'; label: string; ok: boolean; soft: boolean; path: string | null; detail: string; command: string | null; action: 'settings' | null };
export type ChecksProps = { items: CheckItem[]; progress: string };

const withNote = (l: VerifyLine) => (l.note ? `${l.text}（${l.note}）` : l.text);

/** 確認リストの 5 つ。設定画面の検証と同じ判定（toolLine と workspaceLine）を使う。 */
export function presentChecks(r: ReadinessDto): ChecksProps {
  const tmux = toolLine('tmux', r.tools.tmux);
  const claude = toolLine('claude', r.tools.claude);
  const ws = workspaceLine(r.workspace);
  const sl = r.statusline;
  const items: CheckItem[] = [
    { key: 'tmux', label: 'tmux', ok: tmux.ok, soft: false, path: tmux.ok ? withNote(tmux) : null, detail: tmux.ok ? 'ターミナルを動かすのに使います' : `tmux が${tmux.text === '見つかりません' ? '見つかりません' : `使えません。${tmux.text}`}`, command: tmux.ok ? null : 'brew install tmux', action: tmux.ok ? null : 'settings' },
    { key: 'claude', label: 'claude', ok: claude.ok, soft: false, path: claude.ok ? withNote(claude) : null, detail: claude.ok ? 'Claude Code' : `claude が${claude.text === '見つかりません' ? '見つかりません' : `使えません。${claude.text}`}`, command: null, action: claude.ok ? null : 'settings' },
    { key: 'workspace', label: 'ワークスペース', ok: ws.ok, soft: false, path: ws.ok ? withNote(ws) : null, detail: ws.ok ? '直下のディレクトリをプロジェクトとして登録しています' : r.workspace.exists ? `${r.workspace.path} の${ws.text}` : ws.text, command: null, action: ws.ok ? null : 'settings' },
    { key: 'mcp', label: 'MCP', ok: r.mcp.registered, soft: true, path: r.mcp.registered ? '登録済み' : null, detail: 'どのセッションからも hangar の検索と要約を使えるようにします', command: r.mcp.registered ? null : r.commands.mcp, action: null },
    { key: 'statusline', label: 'statusline', ok: sl.installed, soft: true, path: sl.installed ? '追記済み' : null, detail: sl.installed || sl.scriptPath ? 'ヘッダーの使用率ゲージの供給源です' : 'Claude Code の /statusline でスクリプトを作ってから、次を実行してください', command: sl.installed ? null : r.commands.statusline, action: null },
  ];
  return { items, progress: `${items.length} つ中 ${items.filter((i) => i.ok).length} つ` };
}
