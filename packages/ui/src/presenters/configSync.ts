import type { ConfigApplyOrderEntryIn, ConfigApproval, ConfigBackupGenerationDto, ConfigConflictDto, ConfigExecMark, ConfigHeldReason, ConfigInboxItemDto, ConfigInboxOp, ConfigItemKind, ConfigUnsentItemDto, RetentionPreviewLine, Translate } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { absoluteTime, relativeTime } from './format.ts';
import { translatorOf } from './i18n.ts';

/**
 * 設定の同期（作り直した実装）の画面の形。
 * 設計は docs/superpowers/specs/2026-10-09-stage4-screens-design.md の 2.5（a1、b1、c2、d1、e2）。
 * 件数と状態は ConfigSyncDto（bootstrap と config.update）が正で、項目の一覧は節とダイアログを開いたときに取った中身（Store の configDetail）である。
 */

/** 種類の並び。ダイアログの群はこの順に出す。 */
export const KIND_ORDER: readonly ConfigItemKind[] = ['claude-md', 'settings', 'skills', 'commands', 'agents', 'memory', 'keybindings'];
/** 操作の並び。危ないもの、取り返しのつきにくいものを上に置く。 */
export const OP_ORDER: readonly ConfigInboxOp[] = ['conflict', 'delete', 'overwrite', 'create'];
/** 項目が多いとき、最初から畳む種類（実行される指示とメモリ）。 */
const FOLDED_WHEN_BIG: ReadonlySet<ConfigItemKind> = new Set(['skills', 'commands', 'agents', 'memory']);
/** 「多い」の境目。これを超えたら、畳む種類を最初から畳む。 */
export const BIG = 12;
/** 畳んだ群の見出しに添える名前の数。 */
const PEEK = 3;

/** 他の PC から届いた設定を適用するときの、ターミナルの呼び方。hangar の呼び方は、シェル連携の取得で届いた入れ方のコマンドからそろえる。 */
const hangarCommand = (store: Store, tail: string): string => {
  const base = store.shellHook?.command ?? 'hangar shell install';
  return /\sshell install$/.test(base) ? base.replace(/\sshell install$/, ` ${tail}`) : `hangar ${tail}`;
};

export function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 種類の見出しの鍵。鍵にハイフンは使えないので、claude-md だけ読み替える。 */
const kindKey = (kind: ConfigItemKind) => (kind === 'claude-md' ? 'claudeMd' : kind);

const markLabels = (t: Translate, marks: ConfigExecMark[]): string[] => marks.map((m) => t(`configSyncUi.mark.${m}`));

/** 項目の名前は、ファイルなら末尾の手前の名前が目印になる（skills/foo/SKILL.md の foo）。 */
function shortName(label: string): string {
  const parts = label.split('/');
  return parts.length >= 2 ? parts[1]! : label;
}

/** 畳んだ群の見出しに添える、先頭の名前（「a、b、c、ほか 4」）。 */
function peekOf(t: Translate, labels: string[]): string | null {
  if (labels.length === 0) return null;
  const names = labels.slice(0, PEEK).map(shortName).join(t('configSyncUi.peek.sep'));
  return labels.length > PEEK ? t('configSyncUi.peek.more', { names, n: labels.length - PEEK }) : names;
}

/** 群の中の 1 行。 */
export type ConfigRowProps = {
  id: string; label: string;
  /** settings の鍵の値。ほかは null。 */
  value: string | null;
  /** 右端に出す小さな字（大きさ、送り主、理由）。 */
  side: string;
  marks: string[];
  /** 行の札（承諾が要る、保留）。無ければ null。 */
  tag: { tone: 'warn' | 'off'; text: string } | null;
  /** 行をうすく出す（保留）。 */
  dim: boolean;
  /** 「それでも送る」を出す項目の id。 */
  sendId: string | null;
};
export type ConfigGroupProps = {
  id: string; title: string; count: number;
  /** 畳んだときに見出しへ添える先頭の名前。 */
  peek: string | null;
  /** 群が何をするかの 1 文。無ければ null。 */
  note: string | null;
  /** 最初から開いているか。 */
  open: boolean;
  rows: ConfigRowProps[];
};

// ---- (a) 送るものの一覧 ----

/** 送らなかった項目の理由。秘密らしい文字列は、見つけた文字列ではなく形の名前だけを言う。 */
export function unsentReason(t: Translate, u: ConfigUnsentItemDto): string {
  if (u.reason.startsWith('secret:')) return t('configSyncUi.unsent.secret', { form: u.reason.slice('secret:'.length) });
  if (u.reason === 'absolute-path') return t('configSyncUi.unsent.path');
  return u.reason;
}

export type ConfigSendDialogProps = {
  part: 'send'; loading: boolean;
  /** 送る項目の数。 */
  total: number;
  groups: ConfigGroupProps[];
  /** 送らないもの（運ばない鍵、絶対パスの規則、秘密らしい文字列のあった項目）。 */
  dropped: ConfigGroupProps | null;
  /** 切のままでも一覧は読める。すでに入っているなら「送り直す」ではなく読むだけ。 */
  alreadyOn: boolean;
};

function presentSend(state: State, store: Store, t: Translate): ConfigSendDialogProps {
  const o = store.configDetail.outgoing;
  const items = o?.items ?? [];
  const big = items.length > BIG;
  const groups: ConfigGroupProps[] = KIND_ORDER.flatMap((kind) => {
    const xs = items.filter((i) => i.kind === kind);
    if (xs.length === 0) return [];
    const closed = big && FOLDED_WHEN_BIG.has(kind);
    return [{
      id: kind, title: t(`configSyncUi.kind.${kindKey(kind)}`), count: xs.length, peek: closed ? peekOf(t, xs.map((x) => x.label)) : null, note: null, open: !closed,
      rows: xs.map((x) => ({ id: x.id, label: x.label, value: x.value, side: sizeLabel(x.size), marks: markLabels(t, x.marks), tag: null, dim: false, sendId: null })),
    }];
  });
  // 落とす鍵は理由ごとの語で、送らなかった項目（絶対パスの規則、秘密らしい文字列）は 1 件ずつ。
  const droppedRows: ConfigRowProps[] = [
    ...(o?.droppedKeys ?? []).map((d) => ({ id: `drop:${d.key}`, label: d.key, value: null, side: t(`configSyncUi.drop.${d.reason}`), marks: [], tag: null, dim: true, sendId: null })),
    ...(store.configDetail.unsent?.items ?? []).map((u) => ({ id: u.id, label: u.label, value: null, side: unsentReason(t, u), marks: [], tag: null, dim: true, sendId: null })),
  ];
  return {
    part: 'send', loading: o === null, total: items.length, groups, alreadyOn: store.configSync?.enabled === true,
    dropped: droppedRows.length === 0 ? null : { id: 'dropped', title: t('configSyncUi.send.dropped'), count: droppedRows.length, peek: null, note: t('configSyncUi.send.droppedNote'), open: !big, rows: droppedRows },
  };
}

// ---- (b) 適用内容の確認 ----

const heldNote = (t: Translate, h: ConfigHeldReason): string => t(h === 'no-project' ? 'configSyncUi.held.noProject' : 'configSyncUi.held.blocked');

function inboxRow(t: Translate, i: ConfigInboxItemDto): ConfigRowProps {
  return {
    id: i.id, label: i.label, value: null, side: i.fromDevice, marks: markLabels(t, i.marks), dim: i.held !== null,
    tag: i.held ? { tone: 'off', text: heldNote(t, i.held) } : needsPick(i) ? { tone: 'warn', text: t('configSyncUi.review.needsApproval') } : null,
    sendId: null,
  };
}

/** 承諾の表で選ぶ項目か。競合は、採る側を競合の札で選ぶので、承諾の表には入れない。 */
export const needsPick = (i: ConfigInboxItemDto): boolean => i.held === null && i.needsApproval && i.op !== 'conflict';

/** 適用の指示書へ入れられる項目か。競合は採る側を選ぶので別、保留は書けない、承諾の要るものは承諾の表で選ぶ。 */
export const appliesNow = (i: ConfigInboxItemDto): boolean => i.held === null && i.op !== 'conflict' && !i.needsApproval;

export type ConfigReviewDialogProps = {
  part: 'review'; loading: boolean;
  /** 「適用…」で書く項目の数。 */
  total: number;
  /** 操作ごとの数を並べた 1 行（「競合 1　削除 2　上書き 3　新規 4」）。 */
  summary: string;
  groups: ConfigGroupProps[];
  /** 承諾の表で選ぶスキルなどの数と、競合の数。0 でなければ、ダイアログの中から開く入口を出す。 */
  awaiting: number; conflicts: number;
  entries: ConfigApplyOrderEntryIn[];
  working: boolean;
  /** 殻があるか。無ければ、適用の指示書を書いたあと、ターミナルで hangar config apply を実行する。 */
  native: boolean;
};

function presentReview(state: State, store: Store, t: Translate): ConfigReviewDialogProps {
  const inbox = store.configDetail.inbox;
  const items = inbox?.items ?? [];
  const o = state.overlay;
  const groups: ConfigGroupProps[] = [];
  for (const op of OP_ORDER) {
    const xs = items.filter((i) => i.held === null && i.op === op);
    if (xs.length === 0) continue;
    const closed = items.length > BIG && op === 'create';
    groups.push({ id: op, title: t(`configSyncUi.op.${op}`), count: xs.length, peek: closed ? peekOf(t, xs.map((x) => x.label)) : null, note: t(`configSyncUi.opNote.${op}`), open: !closed, rows: xs.map((x) => inboxRow(t, x)) });
  }
  const held = items.filter((i) => i.held !== null);
  if (held.length > 0) groups.push({ id: 'held', title: t('configSyncUi.op.held'), count: held.length, peek: null, note: t('configSyncUi.opNote.held'), open: true, rows: held.map((x) => inboxRow(t, x)) });
  const entries = items.filter(appliesNow).map((i) => ({ id: i.id }));
  const count = (op: ConfigInboxOp) => items.filter((i) => i.held === null && i.op === op).length;
  return {
    part: 'review', loading: inbox === null, total: entries.length,
    summary: OP_ORDER.map((op) => `${t(`configSyncUi.op.${op}`)} ${count(op)}`).join(t('configSyncUi.review.summarySep')),
    groups, awaiting: items.filter(needsPick).length, conflicts: count('conflict'),
    entries, working: o.kind === 'configSync' && o.working, native: store.desktop,
  };
}

// ---- (c) 届いたスキル、コマンド、エージェントの承諾 ----

export type ConfigApproveRowProps = {
  id: string; label: string; kind: string; opLabel: string; from: string;
  /** 実行の印（フック、コマンド実行、スクリプト）。 */
  marks: string[];
  /** 印があれば、中身を開いて見てから 1 件ずつ選ぶ。 */
  marked: boolean;
  /** 中身の先頭。印のある行は、印の付く行を強調するので、行ごとに hot を持つ。 */
  head: { text: string; hot: boolean }[];
  /** 先頭の一部だけを見せているか。 */
  truncated: boolean;
};
export type ConfigApproveDialogProps = { part: 'approve'; loading: boolean; rows: ConfigApproveRowProps[]; from: string | null; working: boolean; native: boolean };

/** 実行の印が付く行（フロントマターの hooks、本文のコマンド実行）。中身の先頭の見える範囲で、目に付くようにする。 */
export const isHotLine = (line: string): boolean => /^\s*hooks\s*:|!`|^\s*(?:command|PreToolUse|PostToolUse|SessionStart|Stop)\s*:/i.test(line);

const HEAD_CHARS = 400;

function presentApprove(state: State, store: Store, t: Translate): ConfigApproveDialogProps {
  const inbox = store.configDetail.inbox;
  const items = (inbox?.items ?? []).filter(needsPick);
  const o = state.overlay;
  const rows = items.map((i): ConfigApproveRowProps => ({
    id: i.id, label: i.label, kind: t(`configSyncUi.kind.${kindKey(i.kind)}`), opLabel: t(`configSyncUi.op.${i.op}`), from: i.fromDevice, marks: markLabels(t, i.marks), marked: i.marks.length > 0,
    head: i.head === '' ? [] : i.head.split('\n').map((text) => ({ text, hot: isHotLine(text) })),
    truncated: i.head.length >= HEAD_CHARS && i.size > i.head.length,
  }));
  const from = [...new Set(items.map((i) => i.fromDevice))].join(t('configSyncUi.peek.sep'));
  return { part: 'approve', loading: inbox === null, rows, from: from === '' ? null : from, working: o.kind === 'configSync' && o.working, native: store.desktop };
}

// ---- (d) 競合 ----

export type ConfigConflictCardProps = {
  id: string; label: string; kind: string; marks: string[];
  /** 「相手」の側と「自分」の側の、いつ変えたか（「2026-10-09 08:40」、消えていれば「消えています」）。 */
  remoteWhen: string; localWhen: string;
  remoteName: string;
  lines: RetentionPreviewLine[];
};
export type ConfigConflictsDialogProps = { part: 'conflicts'; loading: boolean; cards: ConfigConflictCardProps[]; working: boolean; native: boolean };

/** 片側の「いつ」。時刻だけを言い、名前は札の文が言う。消えていれば「消えています」。 */
function sideWhen(t: Translate, side: ConfigConflictDto['local']): string {
  if (!side) return t('configSyncUi.conflict.gone');
  return side.at === null ? '' : absoluteTime(t, side.at);
}

function presentConflicts(state: State, store: Store, t: Translate): ConfigConflictsDialogProps {
  const list = store.configDetail.conflicts;
  const o = state.overlay;
  const cards = (list ?? []).map((c): ConfigConflictCardProps => ({
    id: c.id, label: c.label, kind: t(`configSyncUi.kind.${kindKey(c.kind)}`), marks: markLabels(t, c.marks),
    remoteWhen: sideWhen(t, c.remote), localWhen: sideWhen(t, c.local), remoteName: c.remote?.deviceName ?? t('configSyncUi.conflict.other'),
    lines: c.diff,
  }));
  return { part: 'conflicts', loading: list === null, cards, working: o.kind === 'configSync' && o.working, native: store.desktop };
}

export type ConfigDialogProps = ConfigSendDialogProps | ConfigReviewDialogProps | ConfigApproveDialogProps | ConfigConflictsDialogProps;

/** 開いているダイアログの形。設定の同期のダイアログを開いていなければ null。 */
export function presentConfigDialog(state: State, store: Store): ConfigDialogProps | null {
  const o = state.overlay;
  if (o.kind !== 'configSync') return null;
  const t = translatorOf(store);
  switch (o.part) {
    case 'send': return presentSend(state, store, t);
    case 'review': return presentReview(state, store, t);
    case 'approve': return presentApprove(state, store, t);
    case 'conflicts': return presentConflicts(state, store, t);
  }
}

// ---- 設定の節の「Claude Code の設定を同期」 ----

export type ConfigBackupRowProps = { name: string; when: string; files: string; /** 殻が無いときに、ターミナルで戻すコマンド。 */ command: string };
export type ConfigSyncSectionProps = {
  /** クラウドに参加していない（または、新しい実装を知らない古いサーバ）。スイッチを押せない。 */
  needsCloud: boolean;
  enabled: boolean;
  /** Worker がまだ束の行を知る版に届いていない。スイッチは入っているが、送っていない。 */
  workerPending: boolean;
  lastSent: string | null;
  approval: ConfigApproval;
  native: boolean;
  /** 適用の待ち（指示書がある）。殻が無いときに打つコマンドと、いつ書かれたか。 */
  order: { count: number; when: string; command: string } | null;
  incoming: { count: number; held: number; from: string | null };
  /** 承諾の表で選ぶスキルなどの数（承諾の仕方が毎回のとき）。 */
  awaiting: number;
  conflicts: number;
  unsent: { count: number; rows: ConfigRowProps[] };
  /** ベルの一覧の行から来た（at=unsent）。送らなかった項目の行を開き、見える所へ移る。 */
  focusUnsent: boolean;
  backups: { count: number; rows: ConfigBackupRowProps[] };
};

function backupRow(t: Translate, store: Store, g: ConfigBackupGenerationDto): ConfigBackupRowProps {
  return { name: g.name, when: g.at === null ? g.name : absoluteTime(t, g.at), files: t('configSyncUi.word.count', { n: g.files }), command: hangarCommand(store, `config restore ${g.name}`) };
}

export function presentConfigSection(store: Store, now: number, focusUnsent = false): ConfigSyncSectionProps {
  const t = translatorOf(store);
  const c = store.configSync;
  const d = store.configDetail;
  const inbox = d.inbox?.items ?? [];
  const from = [...new Set(inbox.filter((i) => i.held === null && i.op !== 'conflict').map((i) => i.fromDevice))];
  const rowOfUnsent = (u: ConfigUnsentItemDto): ConfigRowProps => ({
    id: u.id, label: u.label, value: null, side: unsentReason(t, u), marks: [],
    tag: u.allowed ? { tone: 'off', text: t('configSyncUi.unsent.allowed') } : null, dim: !u.allowed, sendId: u.allowed ? null : u.id,
  });
  return {
    needsCloud: c === null,
    enabled: c?.enabled ?? false,
    workerPending: c?.workerPending ?? false,
    lastSent: c?.lastSentAt != null ? relativeTime(t, c.lastSentAt, now) : null,
    approval: c?.approval ?? 'each',
    native: store.desktop,
    order: c?.applyOrder ? { count: c.applyOrder.count, when: relativeTime(t, c.applyOrder.createdAt, now), command: hangarCommand(store, 'config apply') } : null,
    incoming: { count: c?.incoming ?? 0, held: c?.held ?? 0, from: from.length === 0 ? null : from.join(t('configSyncUi.peek.sep')) },
    awaiting: c?.approval === 'each' ? inbox.filter(needsPick).length : 0,
    conflicts: c?.conflicts ?? 0,
    unsent: { count: c?.unsent ?? 0, rows: (c?.unsent ?? 0) === 0 ? [] : (d.unsent?.items ?? []).map(rowOfUnsent) },
    focusUnsent,
    backups: { count: c?.backups ?? 0, rows: (c?.backups ?? 0) === 0 ? [] : (d.backups?.generations ?? []).map((g) => backupRow(t, store, g)) },
  };
}
