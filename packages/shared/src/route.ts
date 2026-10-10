/**
 * 設定の画面で開く先。
 * 節の名前（general、cloud、integrations、summary、tools、info）は、左の目次で選んだ節をそのまま URL に持つ（戻ると進むで節も戻る）。
 * `sync` は、ヘッダーの同期の語が使うクラウド同期の節の別名、`accounts` は連携の節のアカウントの位置である。
 */
export const SETTINGS_SECTIONS = ['general', 'cloud', 'integrations', 'summary', 'tools', 'info'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingsAt = SettingsSection | 'accounts' | 'sync';
const SETTINGS_AT: readonly string[] = [...SETTINGS_SECTIONS, 'accounts', 'sync'];

/** 開く先から、右に出す節を決める。無ければ「一般」。 */
export function settingsSectionOf(at: SettingsAt | undefined): SettingsSection {
  if (at === 'sync') return 'cloud';
  if (at === 'accounts') return 'integrations';
  return at ?? 'general';
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
