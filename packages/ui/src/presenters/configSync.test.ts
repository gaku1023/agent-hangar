import { describe, expect, it } from 'vitest';
import type { ConfigConflictDto, ConfigInboxItemDto, ConfigOutgoingItemDto, ConfigSyncDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { EMPTY_CONFIG_DETAIL, initialStore, type ConfigDetail, type Store } from '../store/store.ts';
import { appliesNow, isHotLine, needsPick, presentConfigDialog, presentConfigSection, sizeLabel } from './configSync.ts';

const NOW = Date.parse('2026-10-10T12:00:00+09:00');
const dto = (over: Partial<ConfigSyncDto> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...over });
const storeOf = (c: ConfigSyncDto | null, detail: Partial<ConfigDetail> = {}, over: Partial<Store> = {}): Store => ({ ...initialStore(), configSync: c, configDetail: { ...EMPTY_CONFIG_DETAIL, ...detail }, ...over });
const open = (part: 'send' | 'review' | 'approve' | 'conflicts', working = false): State => ({ ...initialState(), overlay: { kind: 'configSync', part, working } });

const out = (id: string, kind: ConfigOutgoingItemDto['kind'], label: string, over: Partial<ConfigOutgoingItemDto> = {}): ConfigOutgoingItemDto => ({ id, kind, label, size: 100, marks: [], value: null, ...over });
const inb = (id: string, kind: ConfigInboxItemDto['kind'], label: string, op: ConfigInboxItemDto['op'], over: Partial<ConfigInboxItemDto> = {}): ConfigInboxItemDto => ({ id, kind, label, op, fromDeviceId: 'dev-a', fromDevice: 'Studio', size: 100, marks: [], head: '', held: null, needsApproval: false, ...over });

describe('送るものの一覧（a1）', () => {
  it('種類の順に群を作り、見出しに件数を持ち、settings.json は鍵と値を持つ', () => {
    const items = [
      out('file:skills/a/SKILL.md', 'skills', 'skills/a/SKILL.md'), out('settings:model', 'settings', 'model', { value: '"opus"', size: 6 }), out('file:CLAUDE.md', 'claude-md', 'CLAUDE.md'),
    ];
    const p = presentConfigDialog(open('send'), storeOf(dto({ enabled: false }), { outgoing: { enabled: false, items, droppedKeys: [], unsentCount: 0, lastSentAt: null } }));
    expect(p).toMatchObject({ part: 'send', loading: false, total: 3, alreadyOn: false });
    if (p?.part !== 'send') throw new Error('part');
    expect(p.groups.map((g) => [g.id, g.count, g.open])).toEqual([['claude-md', 1, true], ['settings', 1, true], ['skills', 1, true]]);
    expect(p.groups[1]!.rows[0]).toMatchObject({ label: 'model', value: '"opus"', side: '6 B' });
    expect(p.dropped).toBeNull();
  });
  it('項目が多いとき、実行される種類とメモリは畳み、見出しに先頭の名前を添える（8 項目では畳まない）', () => {
    const many = (kind: ConfigOutgoingItemDto['kind'], dir: string, n: number) => Array.from({ length: n }, (_, i) => out(`file:${dir}/x${i}.md`, kind, `${dir}/x${i}.md`));
    const small = presentConfigDialog(open('send'), storeOf(dto(), { outgoing: { enabled: true, items: many('skills', 'skills', 8), droppedKeys: [], unsentCount: 0, lastSentAt: null } }));
    if (small?.part !== 'send') throw new Error('part');
    expect(small.groups[0]!.open).toBe(true);
    expect(small.groups[0]!.peek).toBeNull();
    const items = [...many('skills', 'skills', 22), ...many('commands', 'commands', 9), ...many('memory', 'memory', 14), out('file:CLAUDE.md', 'claude-md', 'CLAUDE.md'), out('settings:model', 'settings', 'model')];
    const big = presentConfigDialog(open('send'), storeOf(dto(), { outgoing: { enabled: true, items, droppedKeys: [], unsentCount: 0, lastSentAt: null } }));
    if (big?.part !== 'send') throw new Error('part');
    const by = Object.fromEntries(big.groups.map((g) => [g.id, g]));
    expect([by['skills']!.open, by['commands']!.open, by['memory']!.open, by['claude-md']!.open, by['settings']!.open]).toEqual([false, false, false, true, true]);
    expect(by['skills']!.peek).toBe('x0.md、x1.md、x2.md、ほか 19');
  });
  it('送らないものは、落とす鍵を理由の語で、送らなかった項目を形の名前で言い、本文の断片は出さない', () => {
    const p = presentConfigDialog(open('send'), storeOf(dto(), {
      outgoing: { enabled: true, items: [], droppedKeys: [{ key: 'env', reason: 'execution' }, { key: 'permissions.additionalDirectories', reason: 'path' }], unsentCount: 2, lastSentAt: null },
      unsent: { items: [{ id: 'secret:file:skills/x/SKILL.md', kind: 'secret', itemId: 'file:skills/x/SKILL.md', label: 'skills/x/SKILL.md', reason: 'secret:ghp_', allowed: false }, { id: 'rule:allow:1', kind: 'permission-rule', itemId: 'settings:permissions.allow', label: 'Read(//v/**)', reason: 'absolute-path', allowed: false }] },
    }));
    if (p?.part !== 'send') throw new Error('part');
    expect(p.dropped?.rows.map((r) => [r.label, r.side])).toEqual([['env', '実行される設定'], ['permissions.additionalDirectories', '絶対パス'], ['skills/x/SKILL.md', '秘密らしい文字列（ghp_ の形）'], ['Read(//v/**)', '絶対パスの規則']]);
  });
  it('読み込み前は loading で、すでに入っていれば alreadyOn', () => {
    const p = presentConfigDialog(open('send'), storeOf(dto()));
    expect(p).toMatchObject({ part: 'send', loading: true, total: 0, alreadyOn: true });
  });
});

describe('適用内容の確認（b1）', () => {
  const items = [
    inb('file:CLAUDE.md', 'claude-md', 'CLAUDE.md', 'conflict'),
    inb('file:skills/old/SKILL.md', 'skills', 'skills/old/SKILL.md', 'delete'),
    inb('file:skills/a/SKILL.md', 'skills', 'skills/a/SKILL.md', 'overwrite', { needsApproval: true }),
    inb('file:memory/m.md', 'memory', 'memory/m.md', 'overwrite'),
    inb('settings:model', 'settings', 'model', 'create'),
    inb('memory:p9/memory/MEMORY.md', 'memory', 'proj/MEMORY.md', 'create', { held: 'no-project' }),
  ];
  const p = () => presentConfigDialog(open('review'), storeOf(dto({ incoming: 4, conflicts: 1, held: 1 }), { inbox: { items, approval: 'each' } }, { desktop: true }));
  it('競合、削除、上書き、新規、保留の順に群を作り、群ごとに何が起きるかの 1 文を持つ', () => {
    const r = p();
    if (r?.part !== 'review') throw new Error('part');
    expect(r.groups.map((g) => [g.id, g.count])).toEqual([['conflict', 1], ['delete', 1], ['overwrite', 2], ['create', 1], ['held', 1]]);
    expect(r.groups.every((g) => g.note !== null)).toBe(true);
    expect(r.summary).toBe('競合 1、削除 1、上書き 2、新規 1');
  });
  it('適用の指示書に入れるのは、競合でも保留でも承諾の要るものでもない項目だけ', () => {
    const r = p();
    if (r?.part !== 'review') throw new Error('part');
    expect(r.entries).toEqual([{ id: 'file:skills/old/SKILL.md' }, { id: 'file:memory/m.md' }, { id: 'settings:model' }]);
    expect(r.total).toBe(3);
    expect(r.awaiting).toBe(1);
    expect(r.conflicts).toBe(1);
    expect(r.native).toBe(true);
    expect(items.filter(appliesNow).length).toBe(3);
  });
  it('承諾が必要な行と保留の行に札を付ける。競合の行には承諾の札を付けない', () => {
    const r = presentConfigDialog(open('review'), storeOf(dto(), { inbox: { items: [...items, inb('file:skills/c/SKILL.md', 'skills', 'skills/c/SKILL.md', 'conflict', { needsApproval: true })], approval: 'each' } }));
    if (r?.part !== 'review') throw new Error('part');
    const row = (id: string) => r.groups.flatMap((g) => g.rows).find((x) => x.id === id)!;
    expect(row('file:skills/a/SKILL.md').tag).toEqual({ tone: 'warn', text: '承諾が必要' });
    expect(row('file:skills/c/SKILL.md').tag).toBeNull();
    expect(row('memory:p9/memory/MEMORY.md')).toMatchObject({ dim: true, tag: { tone: 'off', text: 'この PC にそのプロジェクトがありません' } });
  });
  it('承諾の仕方が自動なら、承諾の要るものも指示書に入る（needsApproval が偽）', () => {
    const r = presentConfigDialog(open('review'), storeOf(dto({ approval: 'auto' }), { inbox: { items: [inb('file:skills/a/SKILL.md', 'skills', 'skills/a/SKILL.md', 'create')], approval: 'auto' } }));
    if (r?.part !== 'review') throw new Error('part');
    expect(r.entries).toEqual([{ id: 'file:skills/a/SKILL.md' }]);
  });
  it('適用の返事を待つあいだは working で、殻が無ければ native が偽', () => {
    const r = presentConfigDialog(open('review', true), storeOf(dto(), { inbox: { items, approval: 'each' } }));
    expect(r).toMatchObject({ working: true, native: false });
  });
});

describe('承諾の表（c2）', () => {
  const hooky = inb('file:skills/h/SKILL.md', 'skills', 'skills/h/SKILL.md', 'create', { needsApproval: true, marks: ['hooks'], size: 900, head: '---\nname: h\nhooks:\n  PreToolUse:\n---\nbody' });
  const plain = inb('file:commands/p.md', 'commands', 'commands/p.md', 'overwrite', { needsApproval: true, head: '# p' });
  const conflict = inb('file:skills/c/SKILL.md', 'skills', 'skills/c/SKILL.md', 'conflict', { needsApproval: true });
  it('承諾の要る行だけを出し、競合と保留は含めない。印のある行は marked', () => {
    const r = presentConfigDialog(open('approve'), storeOf(dto(), { inbox: { items: [hooky, plain, conflict, inb('file:skills/z/SKILL.md', 'skills', 'skills/z/SKILL.md', 'create', { needsApproval: true, held: 'local-blocked' })], approval: 'each' } }));
    if (r?.part !== 'approve') throw new Error('part');
    expect(r.rows.map((x) => [x.label, x.marked, x.marks, x.opLabel, x.from])).toEqual([['skills/h/SKILL.md', true, ['フック'], '新規', 'Studio'], ['commands/p.md', false, [], '上書き', 'Studio']]);
    expect(r.from).toBe('Studio');
    expect(needsPick(conflict)).toBe(false);
  });
  it('中身の先頭を行に分け、実行の印の付く行に hot を付ける。先頭だけの表示なら truncated', () => {
    const r = presentConfigDialog(open('approve'), storeOf(dto(), { inbox: { items: [{ ...hooky, head: 'x'.repeat(400), size: 900 }, hooky], approval: 'each' } }));
    if (r?.part !== 'approve') throw new Error('part');
    expect(r.rows[0]!.truncated).toBe(true);
    expect(r.rows[1]!.truncated).toBe(false);
    expect(r.rows[1]!.head.filter((l) => l.hot).map((l) => l.text)).toEqual(['hooks:', '  PreToolUse:']);
    expect(isHotLine('Current schema: !`psql -c x`')).toBe(true);
    expect(isHotLine('Read the changes')).toBe(false);
  });
});

describe('競合の札（d1）', () => {
  const c: ConfigConflictDto = { id: 'file:CLAUDE.md', kind: 'claude-md', label: 'CLAUDE.md', marks: [], local: { deviceName: 'MacBook', at: NOW - 3_600_000, size: 40 }, remote: { deviceName: 'Studio', at: NOW, size: 83 }, diff: [{ kind: 'ctx', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'c' }] };
  it('差分をそのまま持ち、双方の時刻と相手の名前を言う', () => {
    const r = presentConfigDialog(open('conflicts'), storeOf(dto(), { conflicts: [c] }));
    if (r?.part !== 'conflicts') throw new Error('part');
    expect(r.cards).toHaveLength(1);
    expect(r.cards[0]).toMatchObject({ id: 'file:CLAUDE.md', remoteName: 'Studio', lines: c.diff });
    expect(r.cards[0]!.remoteWhen).toMatch(/2026-10-10/);
  });
  it('片側が消えているときは「消えています」と言う', () => {
    const r = presentConfigDialog(open('conflicts'), storeOf(dto(), { conflicts: [{ ...c, remote: null }, { ...c, local: null }] }));
    if (r?.part !== 'conflicts') throw new Error('part');
    expect([r.cards[0]!.remoteWhen, r.cards[1]!.localWhen]).toEqual(['消えています', '消えています']);
    expect(r.cards[0]!.remoteName).toBe('相手');
  });
});

describe('ダイアログの有無', () => {
  it('設定の同期のダイアログを開いていなければ null', () => {
    expect(presentConfigDialog(initialState(), storeOf(dto()))).toBeNull();
  });
});

describe('設定の節の常設の行', () => {
  it('同期を組んでいない端末は needsCloud で、中身は空', () => {
    const p = presentConfigSection(storeOf(null), NOW);
    expect(p).toMatchObject({ needsCloud: true, enabled: false, order: null, incoming: { count: 0, held: 0, from: null }, unsent: { count: 0, rows: [] }, backups: { count: 0, rows: [] } });
  });
  it('件数は ConfigSyncDto が正で、件数が 0 なら取ってあった中身は出さない', () => {
    const detail: Partial<ConfigDetail> = { unsent: { items: [{ id: 'u', kind: 'secret', itemId: 'i', label: 'x', reason: 'secret:ghp_', allowed: false }] }, backups: { generations: [{ name: '20261010-110000', at: NOW, files: 3 }] } };
    const stale = presentConfigSection(storeOf(dto(), detail), NOW);
    expect(stale.unsent).toEqual({ count: 0, rows: [] });
    expect(stale.backups).toEqual({ count: 0, rows: [] });
    const live = presentConfigSection(storeOf(dto({ unsent: 1, backups: 1 }), detail), NOW);
    expect(live.unsent.rows.map((r) => [r.label, r.sendId, r.dim])).toEqual([['x', 'u', true]]);
    expect(live.backups.rows[0]).toMatchObject({ name: '20261010-110000', files: '3 件', command: 'hangar config restore 20261010-110000' });
  });
  it('「それでも送る」を押した項目は、送ると札で言い、もう押させない', () => {
    const p = presentConfigSection(storeOf(dto({ unsent: 1 }), { unsent: { items: [{ id: 'u', kind: 'secret', itemId: 'i', label: 'x', reason: 'secret:ghp_', allowed: true }] } }), NOW);
    expect(p.unsent.rows[0]).toMatchObject({ sendId: null, tag: { text: '送ります' } });
  });
  it('適用の待ちと、Worker の更新待ちと、最後に送った時刻を出す。ターミナルのコマンドは入れ方の呼び方にそろえる', () => {
    const store = storeOf(dto({ workerPending: true, lastSentAt: NOW - 120_000, applyOrder: { count: 5, createdAt: NOW - 60_000 } }), {}, { shellHook: { state: 'off', zshrc: '/z', line: 'l', command: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar shell install' } });
    const p = presentConfigSection(store, NOW);
    expect(p).toMatchObject({ workerPending: true, lastSent: '2 分前', order: { count: 5, when: '1 分前', command: '/Applications/Hangar.app/Contents/Resources/server/bin/hangar config apply' } });
  });
  it('承諾待ちは承諾の仕方が毎回のときだけ数え、届いている変更の送り主を並べる', () => {
    const inbox = { items: [inb('a', 'skills', 'skills/a/SKILL.md', 'create', { needsApproval: true }), inb('b', 'memory', 'memory/b.md', 'create', { fromDevice: 'Mini' })], approval: 'each' as const };
    const each = presentConfigSection(storeOf(dto({ incoming: 2 }), { inbox }), NOW);
    expect(each).toMatchObject({ awaiting: 1, incoming: { count: 2, from: 'Studio、Mini' } });
    expect(presentConfigSection(storeOf(dto({ incoming: 2, approval: 'auto' }), { inbox }), NOW).awaiting).toBe(0);
  });
  it('大きさの言い方', () => {
    expect([sizeLabel(83), sizeLabel(2150), sizeLabel(3 * 1024 * 1024)]).toEqual(['83 B', '2.1 KB', '3.0 MB']);
  });
});
