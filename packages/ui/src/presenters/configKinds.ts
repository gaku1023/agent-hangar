import { codexEnabledOf, configKindModeOf, opencodeEnabledOf, type ConfigConflictDto, type ConfigHistoryDto, type ConfigInboxItemDto, type ConfigItemKind, type ConfigKindKey, type ConfigKindMode, type ConfigSyncDto, type SettingsDto, type Translate } from '@agent-hangar/shared';
import type { IconName } from '../views/primitives/Icon.tsx';
import type { Store } from '../store/store.ts';
import { absoluteTime, relativeTime } from './format.ts';

/**
 * 設定の同期の「種類ごとの行」と「届いたもの」の形（2026-11-13 の決定、試作の C 性質ごと）。
 * 状態は SettingsDto.configKinds（切、確認、自動。会話の本文は切と自動）。件数と履歴は ConfigSyncDto が正で、項目の数は送るものの一覧から数える。
 */

/** 種類の見出しの鍵。鍵にハイフンは使えないので、claude-md を claudeMd のように読み替える。 */
const KIND_KEYS = {
  'claude-md': 'claudeMd', settings: 'settings', keybindings: 'keybindings', skills: 'skills', commands: 'commands', agents: 'agents', memory: 'memory',
  'claude-mcp': 'claudeMcp', 'claude-hooks': 'claudeHooks', 'claude-statusline': 'claudeStatusline', plugins: 'plugins',
  'codex-file': 'codexFile', 'codex-config': 'codexConfig', 'codex-mcp': 'codexMcp',
  'opencode-file': 'opencodeFile', 'opencode-config': 'opencodeConfig', 'opencode-cli': 'opencodeCli', 'opencode-mcp': 'opencodeMcp',
  'agents-skills': 'agentsSkills', 'hangar-pref': 'hangarPref',
} as const satisfies Record<ConfigItemKind, string>;
export const kindKey = <K extends ConfigItemKind>(kind: K): (typeof KIND_KEYS)[K] => KIND_KEYS[kind];

/** 承認を待つ項目（確認の種類で、保留でも競合でもない）。 */
export const needsPick = (i: ConfigInboxItemDto): boolean => i.held === null && i.needsApproval && i.op !== 'conflict';

export type BundleId = 'conv' | 'instr' | 'skill' | 'mem' | 'conf' | 'exec';
type BundleSpec = { id: BundleId; icon: IconName | null; titleKey: string | null; kinds: readonly ConfigKindKey[] };
/** 束の並びと中身。左の段、右の段の順に出す。自動で走るコードの束だけ実行の印が付く。 */
const BUNDLES: readonly BundleSpec[] = [
  { id: 'conv', icon: null, titleKey: null, kinds: ['transcript'] },
  { id: 'instr', icon: 'log', titleKey: 'configKindsUi.bundle.instr', kinds: ['claude-md', 'codex-file', 'opencode-file'] },
  { id: 'skill', icon: 'tool', titleKey: 'configKindsUi.bundle.skill', kinds: ['skills', 'commands', 'agents', 'agents-skills'] },
  { id: 'mem', icon: 'thinking', titleKey: 'configKindsUi.bundle.mem', kinds: ['memory'] },
  { id: 'conf', icon: 'general', titleKey: 'configKindsUi.bundle.conf', kinds: ['settings', 'keybindings', 'codex-config', 'opencode-config', 'opencode-cli', 'hangar-pref'] },
  { id: 'exec', icon: 'bolt', titleKey: 'configKindsUi.bundle.exec', kinds: ['claude-mcp', 'claude-hooks', 'claude-statusline', 'plugins', 'codex-mcp', 'opencode-mcp'] },
];
const LEFT: readonly BundleId[] = ['conv', 'instr', 'skill', 'mem'];

/** 自動で走るコードの種類。自動にするときだけ、行の下に 1 文の帯を開く。 */
export const EXEC_KINDS: readonly ConfigKindKey[] = BUNDLES.find((b) => b.id === 'exec')!.kinds;

const shown = (kind: ConfigKindKey, s: SettingsDto | null): boolean => {
  if (kind.startsWith('codex-')) return s !== null && codexEnabledOf(s);
  if (kind.startsWith('opencode-')) return s !== null && opencodeEnabledOf(s);
  if (kind === 'agents-skills') return s !== null && (codexEnabledOf(s) || opencodeEnabledOf(s));
  return true;
};

export type KindRowProps = {
  key: ConfigKindKey; name: string;
  /** 手元の項目の数。送るものの一覧がまだ無ければ null（会話の本文は数えない）。 */
  count: number | null;
  mode: ConfigKindMode;
  /** 切と自動の 2 つだけを取る（会話の本文）。 */
  two: boolean;
  exec: boolean;
  /** リンクで外した項目の名前（Claude の入れ物の分だけ）。 */
  links: string[];
};
export type KindBundleProps = {
  id: BundleId; title: string | null; icon: IconName | null; exec: boolean;
  /** 束のつまみ。中が揃っていなければ mixed、行が 1 つの束は null（つまみを出さない）。 */
  mode: ConfigKindMode | 'mixed' | null;
  rows: KindRowProps[];
};
export type KindsProps = { left: KindBundleProps[]; right: KindBundleProps[] };

export function presentKinds(store: Store, t: Translate): KindsProps {
  const s = store.settings;
  const c = store.configSync;
  const tt = t as (key: string) => string;
  const bundles = BUNDLES.map((b): KindBundleProps => {
    const rows = b.kinds.filter((k) => shown(k, s)).map((key): KindRowProps => {
      const isItem = key !== 'transcript';
      return {
        key,
        name: key === 'transcript' ? tt('configKindsUi.kind.transcript') : tt(`configSyncUi.kind.${kindKey(key as ConfigItemKind)}`),
        count: isItem ? (c?.kindCounts?.[key as ConfigItemKind] ?? null) : null,
        mode: configKindModeOf(s, key),
        two: key === 'transcript',
        exec: b.id === 'exec',
        links: isItem ? (c?.linkSkipped?.[key as ConfigItemKind] ?? []) : [],
      };
    });
    const modes = new Set(rows.map((r) => r.mode));
    return { id: b.id, title: b.titleKey === null ? null : tt(b.titleKey), icon: b.icon, exec: b.id === 'exec', mode: rows.length < 2 ? null : modes.size === 1 ? rows[0]!.mode : 'mixed', rows };
  }).filter((b) => b.rows.length > 0);
  return { left: bundles.filter((b) => LEFT.includes(b.id)), right: bundles.filter((b) => !LEFT.includes(b.id)) };
}

/** ヘッダの札の件数。確認の件数（askCount と競合）と、自動で入って未読の回数。0 は null で、札を出さない。 */
export function presentSyncBadges(c: ConfigSyncDto | null): { ask: number | null; quiet: number | null } {
  if (!c) return { ask: null, quiet: null };
  const ask = (c.askCount ?? 0) + c.conflicts;
  const quiet = c.autoUnseen ?? 0;
  return { ask: ask > 0 ? ask : null, quiet: quiet > 0 ? quiet : null };
}

export type InboxItemProps = { id: string; label: string; kind: string };
export type HistoryItemProps = { id: string; label: string; kind: string; op: 'create' | 'overwrite' | 'delete' | 'conflict'; undone: boolean; canUndo: boolean };
export type HistoryBatchProps = { id: number; when: string; from: string | null; kinds: string; unseen: boolean; items: HistoryItemProps[]; canUndoBatch: boolean };
export type InboxProps = {
  ask: InboxItemProps[]; conflicts: InboxItemProps[]; history: HistoryBatchProps[];
  autoError: string | null;
  /** 戻す入口を出すか（殻が restoreConfigHistory を持つとき）。 */
  canRestore: boolean;
  /** 自動で入って、まだ開いていない回数。履歴の見出しの札と、既読の口を呼ぶかどうかに使う。 */
  unseen: number;
};

function historyOf(t: Translate, h: ConfigHistoryDto, canRestore: boolean): HistoryBatchProps {
  const undone = new Set(h.undone);
  const items = h.items.map((i): HistoryItemProps => ({
    id: i.id, label: i.label, kind: (t as (key: string) => string)(`configSyncUi.kind.${kindKey(i.kind)}`), op: i.op, undone: undone.has(i.id),
    canUndo: canRestore && i.restorable === true && !undone.has(i.id),
  }));
  return {
    id: h.id, when: absoluteTime(t, h.at).slice(5), from: h.fromDevice, kinds: [...new Set(items.map((i) => i.kind))].join(t('configSyncUi.peek.sep')), unseen: !h.seen, items,
    canUndoBatch: items.some((i) => i.canUndo),
  };
}

export function presentInbox(store: Store, now: number, t: Translate): InboxProps {
  const c = store.configSync;
  const canRestore = store.canRestoreHistory;
  const label = (kind: ConfigItemKind) => (t as (key: string) => string)(`configSyncUi.kind.${kindKey(kind)}`);
  const ask = (store.configDetail.inbox?.items ?? []).filter(needsPick).map((i): InboxItemProps => ({ id: i.id, label: i.label, kind: label(i.kind) }));
  const conflicts = (store.configDetail.conflicts ?? []).map((x: ConfigConflictDto): InboxItemProps => ({ id: x.id, label: x.label, kind: label(x.kind) }));
  return {
    ask, conflicts,
    history: (c?.history ?? []).map((h) => historyOf(t, h, canRestore)),
    autoError: c?.lastAutoError ? t('configKindsUi.inbox.autoError', { time: relativeTime(t, c.lastAutoError.at, now), message: c.lastAutoError.message }) : null,
    canRestore,
    unseen: c?.autoUnseen ?? 0,
  };
}
