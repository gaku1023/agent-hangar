/**
 * エージェントの絵の組。
 * 一覧、サイドバー、ターミナルのタブ、スマホの画面は、どれもここの絵を使う。
 * 絵を差し替えるときは、このファイルだけを直す。
 *
 * Claude Code の絵は Clawd（起動の見出しの文字絵）を升に起こしたもので、opencode の絵は opencode.ai/brand の公式の SVG である。
 * どちらも各社の商標で、hangar は非公式のツールである（README の「商標」の節）。
 * Codex（OpenAI）の絵は置かない。ロゴの使い方に承認が要るからである。
 */

/** 絵を持つエージェント。Codex はまだ絵を決めていないので入れない。 */
export const AGENT_ICON_KINDS = ['claude-code', 'opencode'] as const;
export type AgentIconKind = (typeof AGENT_ICON_KINDS)[number];
/** light は明るい地（一覧、サイドバー、選んでいないタブ）、dark は暗い地（ターミナルの板につながる、選んだタブ）に置く絵。 */
export type AgentIconTone = 'light' | 'dark';

/**
 * 1 つの絵。width と height は描く大きさ（px）。
 * stretch は縦横比を保たずに枠いっぱいに伸ばす（Clawd の縦 2 倍）。crisp は升の縁をぼかさない。
 */
export type AgentIconArt = { viewBox: string; width: number; height: number; stretch: boolean; crisp: boolean; paths: { d: string; fill: string }[] };

/** 行の題名の左に取る枠の大きさ（px）。どの行も同じ幅にして、題名の頭をそろえる。 */
export const AGENT_ICON_FRAME = { width: 20, height: 14 } as const;

/** 絵の名前。読み上げとツールチップに使う。製品の名前なので訳さない。 */
export const AGENT_LABEL: Record<AgentIconKind, string> = { 'claude-code': 'Claude Code', opencode: 'opencode' };

/**
 * Clawd の升。Claude Code の起動の見出しの文字絵（▐▛███▜▌ / ▝▜█████▛▘ / ▘▘ ▝▝）を、1 文字 2×2 の升に起こしたもの。
 * 文字の升は縦長なので、描くときに縦を 2 倍にする。
 */
export const CLAWD_ROWS: readonly string[] = [
  '...############...',
  '...##.######.##...',
  '.################.',
  '...############...',
  '....#.#....#.#....',
  '..................',
];
const CLAWD_COLOR = '#d97757';

/** 升の並びを、1×1 の四角を並べた 1 本の path にする。 */
function cellsPath(rows: readonly string[]): string {
  let d = '';
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') d += `M${x} ${y}h1v1h-1z`; }));
  return d;
}

const clawd: AgentIconArt = { viewBox: `0 0 ${CLAWD_ROWS[0]!.length} ${CLAWD_ROWS.length}`, width: 18, height: 12, stretch: true, crisp: true, paths: [{ d: cellsPath(CLAWD_ROWS), fill: CLAWD_COLOR }] };

/**
 * opencode の公式のロゴ（opencode.ai/brand の opencode-brand-assets.zip の Logo/opencode-logo-light.svg と -dark.svg、2026-10-25 に取得）。
 * 形と色は公式のまま。公式のファイルは全面の clipPath と mask で包んでいるが、絵は変わらないので外した（1 つの画面に何度も置くと id が重なるため）。
 * 公式の light は明るい地用（黒い枠）、dark は暗い地用（白い枠）である。
 */
const OPENCODE_INNER = 'M180 240H60V120H180V240Z';
const OPENCODE_OUTER = 'M180 60H60V240H180V60ZM240 300H0V0H240V300Z';
const opencode = (inner: string, outer: string): AgentIconArt => ({ viewBox: '0 0 240 300', width: 9.6, height: 12, stretch: false, crisp: false, paths: [{ d: OPENCODE_INNER, fill: inner }, { d: OPENCODE_OUTER, fill: outer }] });

export const AGENT_ICONS: Record<AgentIconKind, Record<AgentIconTone, AgentIconArt>> = {
  // Clawd の橙は暗い地でも読めるので、同じ絵を使う。
  'claude-code': { light: clawd, dark: clawd },
  opencode: { light: opencode('#CFCECD', '#211E1E'), dark: opencode('#4B4646', '#F1ECEC') },
};

/**
 * 行のエージェントの種類（SessionDto.provider、LiveSessionDto.agent）を絵の種類に読む。
 * 種類の無い行は Claude Code である（Claude の行には agent を付けない。古いサーバは provider を返さない）。
 * 知らない種類は絵を出さない（null）。違う会社の絵で取り違えさせないためである。
 */
export function agentIconKindOf(agent: string | null | undefined): AgentIconKind | null {
  if (agent === undefined || agent === null || agent === 'claude-code') return 'claude-code';
  if (agent === 'opencode') return 'opencode';
  return null;
}

/**
 * アイコンを出すか。
 * 設定の「opencode を有効にする」が切で、opencode の会話が 1 つも無いときは出さない（切のままなら、利用者の見た目は変わらない）。
 * どちらかが真なら、全部の行に出す（Claude の行にも Clawd を出し、題名の頭をそろえる）。
 * 有効にしたあと切にしても、opencode の会話が残っていれば出し続ける。その行がどのエージェントのものか分からなくなるからである。
 */
export function agentIconsShown(o: { opencodeEnabled: boolean; hasOpencode: boolean }): boolean {
  return o.opencodeEnabled || o.hasOpencode;
}

/** 絵を SVG の文字列にする。React を使わない画面（スマホ）や文字列で差し込む場所に使う。 */
export function agentIconSvg(kind: AgentIconKind, tone: AgentIconTone): string {
  const a = AGENT_ICONS[kind][tone];
  const attrs = [`viewBox="${a.viewBox}"`, `width="${a.width}"`, `height="${a.height}"`, ...(a.stretch ? ['preserveAspectRatio="none"'] : []), ...(a.crisp ? ['shape-rendering="crispEdges"'] : []), 'aria-hidden="true"'];
  return `<svg ${attrs.join(' ')} xmlns="http://www.w3.org/2000/svg">${a.paths.map((p) => `<path d="${p.d}" fill="${p.fill}"/>`).join('')}</svg>`;
}
