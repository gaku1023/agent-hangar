// watch の指定（相対パスか glob）と、全場面に効く共通の watch。import するものを持たない（packages/server の試験からも読むため）。

/** 全場面の見た目に効くファイル。共通の見た目（styles、primitives、ヘッダー、サイドバー、ホーム）と、見本のデータ・偽の claude・撮影の土台。変わったら全場面が古い。 */
export const COMMON_WATCH: string[] = [
  'packages/ui/src/styles/*.css',
  'packages/ui/src/views/primitives/*.{ts,tsx}',
  'packages/ui/src/views/{Shell,Header,Sidebar,SidebarGrip,SessionRows,SessionBadges,HomeScreen,HomeBand}.tsx',
  'packages/ui/src/brand/*',
  'packages/ui/src/Root.tsx',
  'scripts/readme-shots/{data,fake-claude,transcript}.mjs',
  'scripts/readme-shots/{mocks,env,stage}.ts',
];

function expandBraces(p: string): string[] {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m) return [p];
  return m[1]!.split(',').flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}

/** glob（** と * と {a,b}）か、ディレクトリ・ファイルの相対パス。ディレクトリを書いたら、その下を全部含む。試験のファイルは数えない。 */
export function matcher(patterns: string[]): (file: string) => boolean {
  const res = patterns.flatMap(expandBraces).map((pat) => {
    const body = pat.replace(/\/+$/, '').split('**').map((seg) => seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    return new RegExp(`^${body}(/.*)?$`);
  });
  return (file) => !/\.test\.[cm]?[jt]sx?$/.test(file) && res.some((r) => r.test(file));
}

