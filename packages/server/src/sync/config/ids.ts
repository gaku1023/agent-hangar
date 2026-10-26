import { isSafeKeyId, isSafeRelPath, type ConfigItemKind } from '@agent-hangar/shared';
import { isCarriedSettingsKey } from './settingsSort.ts';
import { parseTargetItemId } from './targets/index.ts';
import { isCarriedPath } from './targets/codexKeys.ts';
import { ocPathId, OC_CLI_PREFIX, OC_JSON_PREFIX } from './targets/opencodeKeys.ts';

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
  | { type: 'memory'; projectId: string; rel: string }
  // Codex（`$CODEX_HOME`）。codex-file は入れ物からの相対パス、codex-toml は config.toml の鍵の道。
  | { type: 'codex-file'; rel: string }
  | { type: 'codex-toml'; path: string[] }
  /** opencode（`opencode:file:`、`opencode:json:`、`opencode:cli:`）。json と cli の path は鍵の道（段ごと）。 */
  | { type: 'opencode-file'; rel: string }
  | { type: 'opencode-json'; path: string[] }
  | { type: 'opencode-cli'; path: string[] }
  /** hangar の好み（`hangar:<鍵>`、hangar の settings.json の鍵 1 つ）。 */
  | { type: 'hangar'; key: string };

/** id を解く。持ち主の対象に任せる薄い関数。形が悪い、運ばない場所を指す、知らない頭、のどれかなら null。 */
export function parseItemId(id: string): { kind: ConfigItemKind; ref: ItemRef } | null {
  return parseTargetItemId(id);
}

/** Claude（`file:`、`settings:`、`memory:`）の id を解く。対象 claude の parseId。 */
export function parseClaudeItemId(id: string): { kind: ConfigItemKind; ref: ItemRef } | null {
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

// ---- Codex（`codex:file:<相対>`、`codex:toml:<鍵の道>`） ----

export const CODEX_FILE_PREFIX = 'codex:file:';
export const CODEX_TOML_PREFIX = 'codex:toml:';
export const CODEX_CONFIG_FILE = 'config.toml';

/** Codex の入れ物で、運ぶファイルの相対パスか。Codex が書く状態（default.rules、skills/.system、installation_id、Windows の .sandbox*、tmp/）は運ばない。 */
export function kindOfCodexRel(rel: string): 'codex-file' | null {
  if (!isSafeRelPath(rel)) return null;
  const segs = rel.split('/');
  if (segs.some((s) => EXCLUDE_SEGMENTS.has(s) || OURS_RE.test(s))) return null;
  if (rel === 'AGENTS.md' || rel === 'AGENTS.override.md' || rel === 'hooks.json') return 'codex-file';
  if (segs.length === 1) return /^[^.][^/]*\.config\.toml$/.test(rel) ? 'codex-file' : null;
  if (segs[0] === 'rules') return segs.length === 2 && segs[1]!.endsWith('.rules') && segs[1] !== 'default.rules' ? 'codex-file' : null;
  if (segs[0] === 'skills') return segs[1] !== '.system' ? 'codex-file' : null;
  return null;
}

const encSeg = (s: string): string => encodeURIComponent(s).replace(/\./g, '%2E');
const decSeg = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };

export const codexFileId = (rel: string): string => `${CODEX_FILE_PREFIX}${rel}`;
export const codexTomlId = (path: readonly string[]): string => `${CODEX_TOML_PREFIX}${path.map(encSeg).join('.')}`;

/** Codex の id を解く。形が悪い、運ばない鍵や場所を指す、のどれかなら null。 */
export function parseCodexItemId(id: string): { kind: ConfigItemKind; ref: ItemRef } | null {
  if (id.startsWith(CODEX_FILE_PREFIX)) {
    const rel = id.slice(CODEX_FILE_PREFIX.length);
    return kindOfCodexRel(rel) ? { kind: 'codex-file', ref: { type: 'codex-file', rel } } : null;
  }
  if (id.startsWith(CODEX_TOML_PREFIX)) {
    const parts = id.slice(CODEX_TOML_PREFIX.length).split('.');
    const path = parts.map(decSeg);
    if (path.some((p) => p === null || p === '' || p.length > 200)) return null;
    const keys = path as string[];
    if (codexTomlId(keys) !== id) return null;
    return isCarriedPath(keys) ? { kind: 'codex-config', ref: { type: 'codex-toml', path: keys } } : null;
  }
  return null;
}

/**
 * Claude 以外の対象の ref の、画面に出す名前と書き込み先。書き込み先は、適用の指示書の target と同じ形で、対象の write が突き合わせる。
 * Claude の ref（file、settings、memory）は service.ts が自分で決めるので、ここでは扱わない。
 */
export function otherRefLabelTarget(ref: Exclude<ItemRef, { type: 'file' | 'settings' | 'memory' }>): { label: string; target: string } {
  switch (ref.type) {
    case 'codex-file': return { label: ref.rel, target: ref.rel };
    case 'codex-toml': return { label: ref.path.join('.'), target: `${CODEX_CONFIG_FILE}#${ref.path.join('.')}` };
    case 'hangar': return { label: ref.key, target: `hangar-settings.json#${ref.key}` };
    case 'opencode-file': return { label: ref.rel, target: ref.rel };
    case 'opencode-json': return { label: ref.path.join('.'), target: `opencode.json#${ocPathId(OC_JSON_PREFIX, ref.path).slice(OC_JSON_PREFIX.length)}` };
    case 'opencode-cli': return { label: ref.path.join('.'), target: `cli.json#${ocPathId(OC_CLI_PREFIX, ref.path).slice(OC_CLI_PREFIX.length)}` };
  }
}
