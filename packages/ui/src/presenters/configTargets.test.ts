import { describe, expect, it } from 'vitest';
import type { ConfigInboxItemDto, ConfigSyncDto, ConfigUnsentItemDto, SettingsDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { EMPTY_CONFIG_DETAIL, initialStore, type ConfigDetail, type Store } from '../store/store.ts';
import { presentConfigDialog, presentConfigSection } from './configSync.ts';
import { presentNotices } from './notices.ts';

const NOW = Date.parse('2026-10-27T12:00:00+09:00');
const dto = (over: Partial<ConfigSyncDto> & Record<string, unknown> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...over });
const settings = (over: Partial<SettingsDto> & { configTargets?: Record<string, boolean> } = {}): SettingsDto => ({ ...initialStore().settings, ...over } as SettingsDto);
const storeOf = (c: ConfigSyncDto | null, detail: Partial<ConfigDetail> = {}, over: Partial<Store> = {}): Store => ({ ...initialStore(), configSync: c, configDetail: { ...EMPTY_CONFIG_DETAIL, ...detail }, ...over });
const open = (part: 'review'): State => ({ ...initialState(), overlay: { kind: 'configSync', part, working: false } });
const inb = (id: string, kind: ConfigInboxItemDto['kind'], label: string, op: ConfigInboxItemDto['op'], over: Partial<ConfigInboxItemDto> & Record<string, unknown> = {}): ConfigInboxItemDto => ({ id, kind, label, op, fromDeviceId: 'dev-a', fromDevice: 'Studio', size: 100, marks: [], head: '', held: null, needsApproval: false, ...over });
const uns = (id: string, kind: ConfigUnsentItemDto['kind'], reason: string, over: Partial<ConfigUnsentItemDto> = {}): ConfigUnsentItemDto => ({ id, kind, itemId: id, label: id, reason, allowed: false, ...over });

describe('対象ごとの入切の行（1A、2A）', () => {
  it('Codex と opencode が無効な PC では、その行と共通の skills を出さない。並びは Claude の対象、MCP、エージェント、Hangar', () => {
    const p = presentConfigSection(storeOf(dto(), {}, { settings: settings() }), NOW);
    expect(p.targets.rows.map((r) => r.name)).toEqual(['claude-keys2', 'claude-hooks', 'claude-plugins', 'claude-mcp', 'hangar']);
  });
  it('有効なら Codex と opencode の行、その MCP、共通の skills を出す', () => {
    const p = presentConfigSection(storeOf(dto(), {}, { settings: settings({ codexEnabled: true, opencodeEnabled: true }) }), NOW);
    expect(p.targets.rows.map((r) => r.name)).toEqual(['claude-keys2', 'claude-hooks', 'claude-plugins', 'claude-mcp', 'codex-mcp', 'opencode-mcp', 'codex', 'opencode', 'agents-skills', 'hangar']);
    const only = presentConfigSection(storeOf(dto(), {}, { settings: settings({ codexEnabled: true }) }), NOW);
    expect(only.targets.rows.map((r) => r.name)).toContain('agents-skills');
    expect(only.targets.rows.map((r) => r.name)).not.toContain('opencode');
  });
  it('入切は configTargets から読み、無ければ切。一度も選んでいない対象に「新」を付ける', () => {
    const p = presentConfigSection(storeOf(dto(), {}, { settings: settings({ configTargets: { 'claude-hooks': true, hangar: false } }) }), NOW);
    const by = Object.fromEntries(p.targets.rows.map((r) => [r.name, r]));
    expect([by['claude-hooks']!.on, by['hangar']!.on, by['claude-keys2']!.on]).toEqual([true, false, false]);
    expect([by['claude-hooks']!.isNew, by['hangar']!.isNew, by['claude-keys2']!.isNew]).toEqual([false, false, true]);
    expect(p.targets.showNew).toBe(false);
  });
  it('どの対象もまだ選んでいなければ、増えた知らせの帯を出す', () => {
    const p = presentConfigSection(storeOf(dto(), {}, { settings: settings() }), NOW);
    expect(p.targets.showNew).toBe(true);
    expect(p.targets.rows.every((r) => r.isNew && !r.on)).toBe(true);
  });
  it('承諾が要る対象に承諾制の札、名前と説明は文面の表から', () => {
    const p = presentConfigSection(storeOf(dto(), {}, { settings: settings({ codexEnabled: true, opencodeEnabled: true }) }), NOW);
    const by = Object.fromEntries(p.targets.rows.map((r) => [r.name, r]));
    expect(p.targets.rows.filter((r) => r.approve).map((r) => r.name)).toEqual(['claude-hooks', 'claude-plugins', 'claude-mcp', 'codex-mcp', 'opencode-mcp', 'codex', 'opencode', 'agents-skills']);
    expect(by['claude-hooks']).toMatchObject({ title: 'hooks と statusLine', desc: '自動で実行するコマンドとスクリプト' });
    expect(by['hangar']).toMatchObject({ title: 'Hangar の設定', desc: '言語、承諾の仕方など。PC ごとの設定は同期しません。' });
  });
  it('入れ物が Git などで管理されていれば、その入れ物を使う行に札と文を持たせる（vcs が無ければ出さない）', () => {
    const p = presentConfigSection(storeOf(dto({ vcs: [{ target: 'claude', tools: ['git'] }, { target: 'opencode', tools: ['chezmoi'] }] }), {}, { settings: settings({ opencodeEnabled: true }) }), NOW);
    const by = Object.fromEntries(p.targets.rows.map((r) => [r.name, r]));
    expect(by['claude-hooks']!.vcs).toEqual({ chip: 'Git で管理', tip: '~/.claude は Git で管理されています。Hangar の同期と重なると、競合することがあります。', title: 'Git の管理と重なります', body: '~/.claude は Git で管理されています。同期を有効にすると、Git と Hangar が同じファイルに書き込むため、競合することがあります。' });
    expect(by['opencode']!.vcs?.chip).toBe('chezmoi で管理');
    expect(by['opencode-mcp']!.vcs?.chip).toBe('chezmoi で管理');
    expect(by['claude-mcp']!.vcs).toBeNull();
    expect(by['hangar']!.vcs).toBeNull();
    const none = presentConfigSection(storeOf(dto(), {}, { settings: settings() }), NOW);
    expect(none.targets.rows.every((r) => r.vcs === null)).toBe(true);
  });
  it('opencode の json と jsonc の併存を opencode の行の知らせに出す', () => {
    const p = presentConfigSection(storeOf(dto({ notices: [{ target: 'opencode', code: 'both-json-jsonc' }] }), {}, { settings: settings({ opencodeEnabled: true }) }), NOW);
    const by = Object.fromEntries(p.targets.rows.map((r) => [r.name, r]));
    expect(by['opencode']!.notice).toBe('opencode.json と opencode.jsonc が両方あります（opencode は jsonc を読み込み、json に書き込みます）');
    expect(by['codex-mcp']).toBeUndefined();
    expect(by['claude-hooks']!.notice).toBeNull();
  });
});

describe('送らなかった項目を理由ごとの群に（3A）', () => {
  const items = [uns('u1', 'secret', 'secret:aws-key'), uns('u2', 'permission-rule', 'absolute-path'), uns('u3', 'unknown-key', 'unknown-key'), uns('u4', 'secret', 'secret:mcp-credential')];
  it('シークレット、この PC だけ、未対応のキーの順に群を作り、未対応のキーは件数に入れない', () => {
    const p = presentConfigSection(storeOf(dto({ unsent: 3, unknownKeyCount: 1 }), { unsent: { items } }), NOW);
    expect(p.unsent.count).toBe(3);
    expect(p.unsent.unknown).toBe(1);
    expect(p.unsent.groups.map((g) => [g.id, g.title, g.rows.map((r) => r.id)])).toEqual([
      ['secret', 'シークレットと思われる値を含む項目', ['u1', 'u4']],
      ['pc', 'この PC だけの設定', ['u2']],
      ['unknown', '未対応のキー', ['u3']],
    ]);
    expect(p.unsent.groups[0]!.note).toBe('シークレットと思われる値があるため、送っていません。送るかどうかは選べます。');
  });
  it('MCP の認証情報は形の名前ではなく言葉で言い、それでも送るを出す', () => {
    const p = presentConfigSection(storeOf(dto({ unsent: 4 }), { unsent: { items } }), NOW);
    const row = p.unsent.groups[0]!.rows.find((r) => r.id === 'u4')!;
    expect(row.side).toBe('MCP サーバーの認証情報と思われる値');
    expect(row.sendId).toBe('u4');
    expect(p.unsent.groups[2]!.rows[0]!.sendId).toBeNull();
  });
  it('ベルの件数にも未対応のキーを数えない。未対応のキーだけなら知らせない', () => {
    const t = (c: ConfigSyncDto) => presentNotices(initialState(), { ...storeOf(c), configSync: c }, NOW).rows.filter((n) => n.kind === 'config');
    expect(t(dto({ unsent: 2, unknownKeyCount: 1 }))[0]!.title).toContain('2');
    expect(t(dto({ unsent: 0, unknownKeyCount: 2 }))).toEqual([]);
  });
});

describe('適用内容の確認を対象の札で 1 つに（4B、4a、4α）', () => {
  const items = [
    inb('file:CLAUDE.md', 'claude-md', 'CLAUDE.md', 'conflict'),
    inb('codex:file:rules/a.rules', 'codex-file', 'rules/a.rules', 'create', { needsApproval: true }),
    inb('settings:model', 'settings', 'model', 'overwrite'),
    inb('opencode:mcp:x', 'opencode-mcp', 'x', 'create', { missingEnv: ['API_KEY', 'TOKEN'] }),
    inb('hangar:language', 'hangar-pref', 'language', 'overwrite'),
    inb('claude-hooks:hooks', 'claude-hooks', 'hooks', 'overwrite', { held: 'other-os' }),
    inb('claude-mcp:y', 'claude-mcp', 'y', 'create', { held: 'command-missing' }),
  ];
  const r = () => {
    const p = presentConfigDialog(open('review'), storeOf(dto(), { inbox: { items, approval: 'each' } }));
    if (p?.part !== 'review') throw new Error('part');
    return p;
  };
  it('競合、承諾が必要なもの、そのまま適用するもの、保留（畳む）の順に群を作る', () => {
    expect(r().groups.map((g) => [g.id, g.count, g.open])).toEqual([['conflict', 1, true], ['approve', 1, true], ['auto', 3, true], ['held', 2, false]]);
    expect(r().groups[1]!.title).toBe('承諾が必要なもの');
    expect(r().groups[3]!.note).toBe('この PC の条件に合わないため、保留しています。条件が揃うと適用します。');
  });
  it('対象の札は、項目のある対象だけを件数つきで並べる（保留は数えない）', () => {
    expect(r().targets).toEqual([{ id: 'claude', label: 'Claude Code', count: 2 }, { id: 'codex', label: 'Codex', count: 1 }, { id: 'opencode', label: 'opencode', count: 1 }, { id: 'hangar', label: 'Hangar の設定', count: 1 }]);
    const row = (id: string) => r().groups.flatMap((g) => g.rows).find((x) => x.id === id)!;
    expect(row('codex:file:rules/a.rules').target).toBe('codex');
    expect(row('codex:file:rules/a.rules').targetLabel).toBe('Codex');
  });
  it('保留の新しい理由と、この PC に無い環境変数の添え書き', () => {
    const row = (id: string) => r().groups.flatMap((g) => g.rows).find((x) => x.id === id)!;
    expect(row('claude-hooks:hooks').tag).toEqual({ tone: 'off', text: '送信元の PC と OS が違うため、適用していません。' });
    expect(row('claude-mcp:y').tag?.text).toBe('MCP サーバーの起動コマンドがこの PC にありません。');
    expect(row('opencode:mcp:x').note).toBe('この PC に API_KEY、TOKEN がありません');
    expect(row('settings:model').note).toBeNull();
  });
});

describe('バックアップの世代に対象名', () => {
  it('世代の行に対象の名前を持つ', () => {
    const p = presentConfigSection(storeOf(dto({ backups: 2 }), { backups: { generations: [{ name: 'g1', at: null, files: 1 }, { name: 'g2', at: null, files: 2, target: 'codex' }, { name: 'g3', at: null, files: 1, target: 'claude-mcp' }] } }), NOW);
    expect(p.backups.rows.map((g) => g.targetLabel)).toEqual(['Claude Code', 'Codex', 'Claude の MCP']);
  });
});
