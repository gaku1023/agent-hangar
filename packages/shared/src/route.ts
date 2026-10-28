/**
 * 設定の画面で開く先。
 * 節の名前（general、sessions、summary、cloud、environment、usage、agentClaude、agentCodex、agentOpencode、about）は、左の目次で選んだ節をそのまま URL に持つ（戻ると進むで節も戻る）。
 * 並びは目次の並びで、共通の節、「エージェント」の群（Claude Code、Codex、opencode を 1 節ずつ）、読むだけのもの、の順にする（2026-10-28 の組み直し。2026-10-25 の並びを引き継ぐ）。
 * エージェントに固有の設定（アカウント、新しいセッションの既定、渡す設定、会話の保持、連携、パス）は、そのエージェントの節に置く。
 * `sync` は、ヘッダーの同期の語が使うクラウド同期の節の別名、`unsent` はその節の「送らなかった項目」の行（ベルの一覧から開く）、`accounts` はセッションの節のアカウントの位置である。
 * `workspace` はセッションの節の作成先の欄、`tmux` は環境の節のパスの欄、`claude` は Claude Code の節のパスの欄、`compat` は Claude Code の節の互換性、`editor` は一般の節のエディタの欄で、ホームの準備の帯の「設定を開く」が、直す欄を指して開くのに使う。
 * `opencode` は opencode の節の面で、新しいセッションのモデルの小窓の「プロバイダーを管理…」が開く。`codex` は Codex の節の面で、未検証の Codex の版の札の「設定を開く」が開く。
 * 0.9.3 までの節の名前（tools、update、info）と、2026-10-28 までの連携の節（integrations）は、殻のディープリンクと利用者の履歴に残っているので、新しい節の別名として読み続ける。
 */
export const SETTINGS_SECTIONS = ['general', 'sessions', 'summary', 'cloud', 'environment', 'usage', 'agentClaude', 'agentCodex', 'agentOpencode', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
/** 節の中の、1 つの欄（か小さな節）を指す開く先。開いたら、その欄が見える所へ移って目立たせる。 */
export const SETTINGS_FIELDS = ['workspace', 'tmux', 'claude', 'compat', 'editor', 'codex', 'opencode'] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];
/** 0.9.3 までの節の名前。 */
const LEGACY_SECTIONS = { tools: 'environment', update: 'about', info: 'about', integrations: 'agentClaude' } as const;
type LegacySection = keyof typeof LEGACY_SECTIONS;
export type SettingsAt = SettingsSection | SettingsField | LegacySection | 'accounts' | 'sync' | 'unsent';
const SETTINGS_AT: readonly string[] = [...SETTINGS_SECTIONS, ...SETTINGS_FIELDS, ...Object.keys(LEGACY_SECTIONS), 'accounts', 'sync', 'unsent'];

/** 欄の開く先かどうか。 */
export function isSettingsField(at: SettingsAt | undefined): at is SettingsField {
  return at !== undefined && (SETTINGS_FIELDS as readonly string[]).includes(at);
}

/** 開く先から、右に出す節を決める。無ければ「一般」。 */
export function settingsSectionOf(at: SettingsAt | undefined): SettingsSection {
  if (at === 'sync' || at === 'unsent') return 'cloud';
  if (at === 'workspace') return 'sessions';
  if (at === 'accounts' || at === 'compat' || at === 'claude') return 'agentClaude';
  if (at === 'codex') return 'agentCodex';
  if (at === 'opencode') return 'agentOpencode';
  if (at === 'tmux') return 'environment';
  if (at === 'editor') return 'general';
  if (at !== undefined && at in LEGACY_SECTIONS) return LEGACY_SECTIONS[at as LegacySection];
  return (at as SettingsSection | undefined) ?? 'general';
}

/**
 * 画面の行き先。ホームは検索語（q）を持てる。
 * セッションの一覧の画面は無くなった（設計書 2.1）。`#/sessions` と `#/sessions?q=` は、殻のディープリンクと利用者の履歴に残っているので、parseRoute がホームの別名として読み続ける。
 */
export type Route =
  | { name: 'home'; q?: string } | { name: 'projects' } | { name: 'project'; id: string }
  | { name: 'session'; id: string } | { name: 'settings'; at?: SettingsAt };

function homeOf(params: URLSearchParams): Route {
  const q = params.get('q');
  return q ? { name: 'home', q } : { name: 'home' };
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart);
  switch (parts[0]) {
    case undefined: return homeOf(params);
    case 'projects': return { name: 'projects' };
    case 'project': return parts[1] ? { name: 'project', id: parts[1] } : { name: 'projects' };
    case 'session': return parts[1] ? { name: 'session', id: parts[1] } : { name: 'home' };
    case 'sessions': return homeOf(params);
    case 'settings': { const at = params.get('at'); return at !== null && SETTINGS_AT.includes(at) ? { name: 'settings', at: at as SettingsAt } : { name: 'settings' }; }
    default: return { name: 'home' };
  }
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home': return route.q ? `#/?q=${encodeURIComponent(route.q)}` : '#/';
    case 'projects': return '#/projects';
    case 'project': return `#/project/${route.id}`;
    case 'session': return `#/session/${route.id}`;
    case 'settings': return route.at ? `#/settings?at=${route.at}` : '#/settings';
  }
}
