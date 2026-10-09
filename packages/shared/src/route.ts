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

export type Route =
  | { name: 'home' } | { name: 'projects' } | { name: 'project'; id: string }
  | { name: 'session'; id: string } | { name: 'sessions'; q?: string } | { name: 'settings'; at?: SettingsAt };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart);
  switch (parts[0]) {
    case undefined: return { name: 'home' };
    case 'projects': return { name: 'projects' };
    case 'project': return parts[1] ? { name: 'project', id: parts[1] } : { name: 'projects' };
    case 'session': return parts[1] ? { name: 'session', id: parts[1] } : { name: 'home' };
    case 'sessions': { const q = params.get('q'); return q ? { name: 'sessions', q } : { name: 'sessions' }; }
    case 'settings': { const at = params.get('at'); return at !== null && SETTINGS_AT.includes(at) ? { name: 'settings', at: at as SettingsAt } : { name: 'settings' }; }
    default: return { name: 'home' };
  }
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home': return '#/';
    case 'projects': return '#/projects';
    case 'project': return `#/project/${route.id}`;
    case 'session': return `#/session/${route.id}`;
    case 'sessions': return route.q ? `#/sessions?q=${encodeURIComponent(route.q)}` : '#/sessions';
    case 'settings': return route.at ? `#/settings?at=${route.at}` : '#/settings';
  }
}
