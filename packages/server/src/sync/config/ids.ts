import { isSafeKeyId, isSafeRelPath, type ConfigItemKind } from '@agent-hangar/shared';
import { isCarriedSettingsKey } from './settingsSort.ts';

/**
 * 設定の同期の項目の id。端末をまたいで同じ項目を指す名前で、束の目録にも基準の表にも載る。
 *
 * - `file:<設定の入れ物からの相対パス>`：CLAUDE.md、keybindings.json、skills、commands、agents、~/.claude/memory の下のファイル。
 * - `settings:<鍵>`：settings.json の鍵 1 つ（権限は `permissions.allow` のように 1 段下まで）。
 * - `memory:<プロジェクトの id>/<memory/ の下の相対パス>`：プロジェクトのメモリ。
 *   Claude Code はメモリを `projects/<パスの slug>/memory/` に置き、slug は PC ごとのパスから決まる。
 *   PC をまたぐので、hangar のプロジェクトの id で運び、受け手が自分のパスから slug を作る。
 *
 * 他の PC から届いた id は外から来た入力である。parseItemId が形と置き場を検査し、通らないものは受け取らない。
 */

/** 運ばない名前。ほかのツールの置き場と、同期そのものが作る名前。 */
const EXCLUDE_SEGMENTS = new Set(['node_modules', '.git', '__pycache__', '.venv', '.DS_Store']);
const OURS_RE = /\.conflict-[^/]*$|\.hangar-tmp-[^/]*$|\.part$/;

/** 運ぶファイルの相対パスの種類。運ばない場所は null。 */
export function kindOfRel(rel: string): ConfigItemKind | null {
  if (!isSafeRelPath(rel)) return null;
  const segs = rel.split('/');
  if (segs.some((s) => EXCLUDE_SEGMENTS.has(s) || OURS_RE.test(s))) return null;
  if (rel === 'CLAUDE.md') return 'claude-md';
  if (rel === 'keybindings.json') return 'keybindings';
  if (segs.length < 2) return null;
  switch (segs[0]) {
    case 'skills': return 'skills';
    case 'commands': return 'commands';
    case 'agents': return 'agents';
    case 'memory': return 'memory';
    default: return null;
  }
}

export const fileId = (rel: string): string => `file:${rel}`;
export const settingsId = (key: string): string => `settings:${key}`;
export const memoryId = (projectId: string, rel: string): string => `memory:${projectId}/${rel}`;

export type ItemRef =
  | { type: 'file'; rel: string }
  | { type: 'settings'; key: string }
  | { type: 'memory'; projectId: string; rel: string };

/** id を解く。形が悪い、運ばない場所を指す、のどれかなら null。 */
export function parseItemId(id: string): { kind: ConfigItemKind; ref: ItemRef } | null {
  if (id.startsWith('file:')) {
    const rel = id.slice('file:'.length);
    const kind = kindOfRel(rel);
    return kind ? { kind, ref: { type: 'file', rel } } : null;
  }
  if (id.startsWith('settings:')) {
    const key = id.slice('settings:'.length);
    return isCarriedSettingsKey(key) ? { kind: 'settings', ref: { type: 'settings', key } } : null;
  }
  if (id.startsWith('memory:')) {
    const rest = id.slice('memory:'.length);
    const i = rest.indexOf('/');
    if (i < 0) return null;
    const projectId = rest.slice(0, i);
    const rel = rest.slice(i + 1);
    if (!isSafeKeyId(projectId) || !isSafeRelPath(rel)) return null;
    if (rel.split('/').some((s) => EXCLUDE_SEGMENTS.has(s) || OURS_RE.test(s))) return null;
    return { kind: 'memory', ref: { type: 'memory', projectId, rel } };
  }
  return null;
}

/** Claude Code が `projects/` の下の名前にする、パスの slug。英数字以外を - にする。 */
export function slugOfPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}
