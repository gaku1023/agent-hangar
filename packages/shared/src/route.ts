/** 設定の画面で、開いたときに見える位置へ移る先。 */
export type SettingsAt = 'accounts';

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
    case 'settings': return params.get('at') === 'accounts' ? { name: 'settings', at: 'accounts' } : { name: 'settings' };
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
