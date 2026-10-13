import type { FolderInspectDto, ProjectNestedDto } from '@agent-hangar/shared';

/**
 * 選んだ 1 つのフォルダの事前の問い合わせ（GET /api/workspace/inspect、0.6.2）。
 * 新しいセッションと作成のダイアログが、選んだフォルダが登録済みのプロジェクトの下か、ほかの PC から届いた同じプロジェクトがあるかを読む。
 * 持つのは最後に頼んだ 1 件だけで、path と name はそのときの問い（name は添えなかったら null）である。
 * ダイアログは path が自分の選んだフォルダと同じときだけ使う。
 */
export type FolderInspectState =
  | { path: string; name: string | null; status: 'loading' }
  | { path: string; name: string | null; status: 'ready'; data: FolderInspectDto }
  | { path: string; name: string | null; status: 'failed' };

/** 同じ問いか。古い問いの答えが、後から頼んだ問いの答えを上書きしないために比べる。 */
export function sameInspect(s: FolderInspectState | null, path: string, name: string | null): boolean {
  return s !== null && s.path === path && s.name === name;
}

/**
 * 区切りの違いを無視して、base の下の相対パスを返す。下でなければ null。
 * 409 の本文は包むプロジェクトの場所しか持たないので、その場の 1 行に出す下のフォルダをここで求める。
 */
export function relativeUnder(path: string, base: string): string | null {
  const trim = (p: string) => p.replace(/[\\/]+$/, '');
  const p = trim(path);
  const b = trim(base);
  if (p.length <= b.length || p.slice(0, b.length) !== b || !/[\\/]/.test(p[b.length]!)) return null;
  return p.slice(b.length + 1);
}

/**
 * 登録が 409（入れ子）で断られたときの、問い合わせの答えの代わり。
 * 事前の問い合わせより先に送られたときでも、ダイアログがその場の 1 行と「別のプロジェクトにする」を出せるようにする。
 */
export function nestedInspect(path: string, body: ProjectNestedDto): FolderInspectState {
  const relative = relativeUnder(path, body.enclosing.path) ?? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
  return { path, name: null, status: 'ready', data: { path, git: false, worktree: false, remote: null, registered: null, enclosing: { ...body.enclosing, relative }, link: null } };
}
