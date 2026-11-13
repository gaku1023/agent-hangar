import { describe, expect, it } from 'vitest';
import type { ConfigHistoryDto, ConfigOutgoingItemDto, ConfigSyncDto, SettingsDto } from '@agent-hangar/shared';
import { translatorOf } from './i18n.ts';
import { presentInbox, presentKinds, presentSyncBadges } from './configKinds.ts';
import { EMPTY_CONFIG_DETAIL, initialStore, type ConfigDetail, type Store } from '../store/store.ts';
import { syncBadgeOf } from './shell.ts';

const NOW = Date.parse('2026-11-13T21:30:00+09:00');
const dto = (over: Partial<ConfigSyncDto> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...over });
const settings = (kinds: Partial<SettingsDto['configKinds']> = {}, over: Partial<SettingsDto> = {}): SettingsDto => ({ configKinds: kinds as SettingsDto['configKinds'], ...over } as SettingsDto);
const storeOf = (c: ConfigSyncDto | null, s: SettingsDto | null, detail: Partial<ConfigDetail> = {}, over: Partial<Store> = {}): Store => ({ ...initialStore(), configSync: c, settings: s, configDetail: { ...EMPTY_CONFIG_DETAIL, ...detail }, ...over });
const rowsOf = (p: ReturnType<typeof presentKinds>) => [...p.left, ...p.right].flatMap((b) => b.rows);
const bundle = (p: ReturnType<typeof presentKinds>, id: string) => [...p.left, ...p.right].find((b) => b.id === id)!;

describe('種類の行の束ね方（C 性質ごと）', () => {
  it('会話の本文を先頭に、指示・スキルとコマンド・記憶を左の段、設定・自動で走るコードを右の段に置く', () => {
    const p = presentKinds(storeOf(dto(), settings()), translatorOf(initialStore()));
    expect(p.left.map((b) => b.id)).toEqual(['conv', 'instr', 'skill', 'mem']);
    expect(p.right.map((b) => b.id)).toEqual(['conf', 'exec']);
    expect(rowsOf(p).find((r) => r.key === 'transcript')).toMatchObject({ two: true, mode: 'auto' });
  });
  it('既定は、自動で走るコードの 6 種類だけが確認で、ほかは自動', () => {
    const p = presentKinds(storeOf(dto(), settings()), translatorOf(initialStore()));
    const confirm = rowsOf(p).filter((r) => r.mode === 'confirm').map((r) => r.key).sort();
    expect(confirm).toEqual(['claude-hooks', 'claude-mcp', 'claude-statusline', 'codex-mcp', 'opencode-mcp', 'plugins'].filter((k) => rowsOf(p).some((r) => r.key === k)).sort());
    expect(bundle(p, 'exec').exec).toBe(true);
    expect(bundle(p, 'exec').rows.every((r) => r.exec)).toBe(true);
    expect(rowsOf(p).filter((r) => r.exec).map((r) => r.key).every((k) => bundle(p, 'exec').rows.some((x) => x.key === k))).toBe(true);
  });
  it('Codex と opencode の行は、そのエージェントが有効なときだけ出す', () => {
    const t = translatorOf(initialStore());
    const off = rowsOf(presentKinds(storeOf(dto(), settings()), t)).map((r) => r.key);
    expect(off).not.toContain('codex-file');
    expect(off).not.toContain('opencode-mcp');
    expect(off).not.toContain('agents-skills');
    const on = rowsOf(presentKinds(storeOf(dto(), settings({}, { codexEnabled: true, opencodeEnabled: true })), t)).map((r) => r.key);
    expect(on).toEqual(expect.arrayContaining(['codex-file', 'codex-config', 'codex-mcp', 'opencode-file', 'opencode-config', 'opencode-cli', 'opencode-mcp', 'agents-skills']));
  });
  it('束の状態は、中が揃っていれば その値、揃っていなければ mixed、行が 1 つの束はつまみを持たない', () => {
    const t = translatorOf(initialStore());
    const same = presentKinds(storeOf(dto(), settings({ 'claude-hooks': 'auto', 'claude-statusline': 'auto', plugins: 'auto', 'claude-mcp': 'auto' })), t);
    expect(bundle(same, 'exec').mode).toBe('auto');
    const mixed = presentKinds(storeOf(dto(), settings({ 'claude-hooks': 'auto' })), t);
    expect(bundle(mixed, 'exec').mode).toBe('mixed');
    expect(bundle(mixed, 'conv').mode).toBeNull();
    expect(bundle(mixed, 'mem').mode).toBeNull();
    expect(bundle(mixed, 'conf').mode).toBe('auto');
  });
  it('項目の数は送るものの一覧から数え、一覧が無ければ数を出さない。リンクで外した名前は行に添える', () => {
    const t = translatorOf(initialStore());
    expect(rowsOf(presentKinds(storeOf(dto(), settings()), t)).every((r) => r.count === null)).toBe(true);
    const items: ConfigOutgoingItemDto[] = ['a', 'b', 'c'].map((x) => ({ id: `file:skills/${x}`, kind: 'skills', label: `skills/${x}`, size: 1, marks: [], value: null }));
    const p = presentKinds(storeOf(dto({ linkSkipped: { skills: ['skills/benkyo', 'skills/zentei'] } }), settings(), { outgoing: { enabled: true, items, droppedKeys: [], unsentCount: 0, lastSentAt: null } }), t);
    const skills = rowsOf(p).find((r) => r.key === 'skills')!;
    expect(skills.count).toBe(3);
    expect(skills.links).toEqual(['skills/benkyo', 'skills/zentei']);
    expect(rowsOf(p).find((r) => r.key === 'memory')!.count).toBe(0);
  });
});

describe('ヘッダの札の件数', () => {
  it('確認の件数は askCount と conflicts の和、自動で入った件数は autoUnseen。0 は null', () => {
    expect(presentSyncBadges(dto({ askCount: 2, conflicts: 1, autoUnseen: 3 }))).toEqual({ ask: 3, quiet: 3 });
    expect(presentSyncBadges(dto())).toEqual({ ask: null, quiet: null });
    expect(presentSyncBadges(null)).toEqual({ ask: null, quiet: null });
    expect(presentSyncBadges(dto({ conflicts: 2 }))).toEqual({ ask: 2, quiet: null });
  });
  it('ヘッダの SyncProps に載る。同期が切のときは出さない', () => {
    const t = translatorOf(initialStore());
    expect(syncBadgeOf(storeOf(dto({ askCount: 1, autoUnseen: 2 }), settings()), t)).toMatchObject({ ask: { n: 1 }, quiet: { n: 2 } });
    expect(syncBadgeOf(storeOf(dto({ enabled: false, askCount: 1, autoUnseen: 2 }), settings()), t)).toEqual({ ask: null, quiet: null });
    expect(syncBadgeOf(storeOf(null, settings()), t)).toEqual({ ask: null, quiet: null });
  });
});

const batch = (over: Partial<ConfigHistoryDto> = {}): ConfigHistoryDto => ({
  id: 7, at: NOW - 60_000, mode: 'auto', fromDeviceId: 'm', fromDevice: 'MacBook', generations: [{ target: 'claude', name: '20261113-210700' }], undone: ['file:skills/b'], seen: false,
  items: [
    { id: 'file:skills/a', kind: 'skills', label: 'skills/a', op: 'create', restorable: true },
    { id: 'file:skills/b', kind: 'skills', label: 'skills/b', op: 'overwrite', restorable: true },
    { id: 'file:CLAUDE.md', kind: 'claude-md', label: 'CLAUDE.md', op: 'overwrite', restorable: false },
  ],
  ...over,
});

describe('右の「届いたもの」', () => {
  const t = translatorOf(initialStore());
  it('履歴の 1 回を、日時・元の PC・種類の名前・項目に開く。戻したものは undone、restorable が偽の項目は 1 項目の戻しを出さない', () => {
    const p = presentInbox(storeOf(dto({ history: [batch()] }), settings(), {}, { canRestoreHistory: true }), NOW, t);
    expect(p.history).toHaveLength(1);
    const h = p.history[0]!;
    expect(h).toMatchObject({ id: 7, from: 'MacBook', unseen: true, canUndoBatch: true });
    expect(h.kinds).toContain('スキル');
    expect(h.items.map((i) => [i.id, i.undone, i.canUndo])).toEqual([['file:skills/a', false, true], ['file:skills/b', true, false], ['file:CLAUDE.md', false, false]]);
  });
  it('restoreConfigHistory を持たない殻（canRestoreHistory が偽）では、戻す入口を全部出さない', () => {
    const p = presentInbox(storeOf(dto({ history: [batch()] }), settings(), {}, { canRestoreHistory: false }), NOW, t);
    expect(p.canRestore).toBe(false);
    expect(p.history[0]!.canUndoBatch).toBe(false);
    expect(p.history[0]!.items.every((i) => !i.canUndo)).toBe(true);
  });
  it('戻せる項目が残っていない回は、まとめて戻すを出さない', () => {
    const p = presentInbox(storeOf(dto({ history: [batch({ undone: ['file:skills/a', 'file:skills/b'] })] }), settings(), {}, { canRestoreHistory: true }), NOW, t);
    expect(p.history[0]!.canUndoBatch).toBe(false);
  });
  it('確認は届いた項目の承認待ちから、競合は競合の一覧から取る。件数はサーバの値を使う', () => {
    const inbox = { items: [{ id: 'settings:hooks', kind: 'claude-hooks' as const, label: 'PreToolUse', op: 'create' as const, fromDeviceId: 'm', fromDevice: 'MacBook', size: 1, marks: [], head: '', held: null, needsApproval: true }, { id: 'file:x', kind: 'skills' as const, label: 'x', op: 'create' as const, fromDeviceId: 'm', fromDevice: 'MacBook', size: 1, marks: [], head: '', held: null, needsApproval: false }], approval: 'each' as const };
    const conflicts = [{ id: 'file:keybindings.json', kind: 'keybindings' as const, label: 'keybindings.json', marks: [], local: { at: 1, deviceName: 'ここ' }, remote: { at: 2, deviceName: 'MacBook' }, diff: [] }];
    const p = presentInbox(storeOf(dto({ askCount: 1, conflicts: 1 }), settings(), { inbox, conflicts: conflicts as unknown as ConfigDetail['conflicts'] }), NOW, t);
    expect(p.ask.map((r) => r.id)).toEqual(['settings:hooks']);
    expect(p.conflicts.map((r) => r.id)).toEqual(['file:keybindings.json']);
  });
  it('自動の適用が失敗していれば、その行を出す。無ければ null', () => {
    expect(presentInbox(storeOf(dto({ lastAutoError: { at: NOW - 5000, message: 'EACCES' } }), settings()), NOW, t).autoError).toContain('EACCES');
    expect(presentInbox(storeOf(dto({ lastAutoError: null }), settings()), NOW, t).autoError).toBeNull();
  });
});
