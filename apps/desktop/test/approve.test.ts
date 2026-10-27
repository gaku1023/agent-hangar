import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { approveEn } from '../../../packages/shared/src/i18n/en/approve.ts';
import { approveJa } from '../../../packages/shared/src/i18n/ja/approve.ts';
import { BACKUP_STAMP as CLI_STAMP, SECRET_MASK as CLI_MASK } from '../../../packages/cli/src/setupPlan.ts';

// 承諾の窓（loading/approve.js）。殻が自分の窓で開く、殻に同梱した頁で、サーバを通らない。
// 頁は UI の辞書を持たないので、承諾の窓の文の写しを持つ。写しが辞書とずれていないことと、見立てからの出し方をここで見る。
type Line = { k: string; t: string };
type View = Record<string, unknown>;
type Model = {
  lang: string; title: string; stage: string; warn: boolean; tabs: { id: string; label: string; selected: boolean }[];
  files: { path: string; op: string; opLabel: string; what: string; header: string; lines: Line[]; own: boolean; binary: boolean; targetLabel: string | null }[];
  showTargets: boolean;
  command: string; kv: [string, string][]; primary: { label: string; danger: boolean };
  done: { title: string; after: string; backups: string[]; note: string | null }; fail: { title: string; detail: string } | null;
};
type Mod = {
  WORDS: Record<'ja' | 'en', Record<string, string>>; SECRET_MASK: string; BACKUP_STAMP: string;
  model(v: View, tab?: string): Model; render(m: Model): string; diffHtml(m: Model): string;
  shortPath(p: string, home: string): string; generationLabel(n: string): string;
};
const loading = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'loading');
const m = (await import(pathToFileURL(path.join(loading, 'approve.js')).href)) as Mod;
const KANA_KANJI = /[぀-ヿ㐀-鿿]/;

const FP = '0'.repeat(64);
const mcpPlan = {
  target: 'mcp-install', state: 'ready', reason: null, secret: true, fingerprint: FP,
  backup: '/Users/u/.agent-hangar/backups/claude.json-YYYYMMDDhhmmss',
  files: [{ path: '/Users/u/.claude.json', op: 'modify', what: 'mcp.add', where: 'json', watch: 'x', lines: [
    { k: 'ctx', t: '"mcpServers": {' }, { k: 'ctx', t: '  "github": { … },' }, { k: 'add', t: '  "hangar": {' },
    { k: 'add', t: `      "Authorization": "Bearer ${CLI_MASK}"` }, { k: 'add', t: '  }' }, { k: 'ctx', t: '}' },
  ] }],
};
const setupView = (lang: string, extra: View = {}): View => ({ lang, job: 'setup', target: 'mcp-install', name: null, stage: 'confirm', plan: mcpPlan, result: null, failure: null, home: '/Users/u', hangarHome: '/Users/u/.agent-hangar', windows: false, ...extra });
const applyView = (lang: string): View => ({
  lang, job: 'apply', target: 'apply', name: null, stage: 'confirm', result: null, failure: null, home: '/Users/u', hangarHome: '/Users/u/.agent-hangar', windows: false,
  plan: {
    createdAt: 1, counts: {}, byKind: {}, instructions: 1, exec: [{ label: 'skills/a/SKILL.md', marks: ['hooks'] }], fingerprint: FP,
    files: [
      { rel: 'CLAUDE.md', path: '/Users/u/.claude/CLAUDE.md', op: 'modify', binary: false, lines: [{ kind: 'del', text: '- a' }, { kind: 'add', text: '- b' }] },
      { rel: 'skills/a/SKILL.md', path: '/Users/u/.claude/skills/a/SKILL.md', op: 'create', binary: false, lines: [{ kind: 'add', text: 'name: a' }] },
    ],
  },
});

describe('承諾の窓の文', () => {
  it('写しの表は、UI の辞書（approve.*）とちょうど同じ', () => {
    expect(m.WORDS.ja).toEqual(approveJa);
    expect(m.WORDS.en).toEqual(approveEn);
  });
  it('伏せ字の印は CLI と同じ', () => {
    expect(m.SECRET_MASK).toBe(CLI_MASK);
  });
  it('バックアップの名前の日時の置き場は CLI と同じ', () => {
    expect(m.BACKUP_STAMP).toBe(CLI_STAMP);
  });
});

// 複数の対象に書く適用。files[].target は書く先の store の名前、plan.targets は書く対象の名前（claude-hooks など）。
const multiView = (lang: string, extra: View = {}): View => ({
  ...applyView(lang),
  plan: {
    createdAt: 1, counts: {}, byKind: {}, instructions: 0, exec: [], fingerprint: FP, targets: ['claude', 'claude-hooks', 'codex', 'agents-skills'],
    files: [
      { rel: 'CLAUDE.md', path: '/Users/u/.claude/CLAUDE.md', op: 'modify', binary: false, target: 'claude', lines: [{ kind: 'add', text: 'a' }] },
      { rel: 'config.toml', path: '/Users/u/.codex/config.toml', op: 'modify', binary: false, target: 'codex', lines: [{ kind: 'add', text: 'b' }] },
      { rel: 'skills/x/SKILL.md', path: '/Users/u/.agents/skills/x/SKILL.md', op: 'create', binary: false, target: 'agents-skills', lines: [{ kind: 'add', text: 'c' }] },
    ],
  },
  ...extra,
});

describe('承諾の窓：対象ごと', () => {
  it('適用：書く先のファイルに対象の名前を付け、対象の一覧と、対象ごとのバックアップの置き場を出す', () => {
    const v = m.model(multiView('ja'));
    expect(v.showTargets).toBe(true);
    expect(v.files.map((f) => f.targetLabel)).toEqual(['Claude Code', 'Codex', '共通のスキル']);
    expect(v.kv[0]).toEqual(['対象', 'Claude Code\nCodex\n共通のスキル']);
    const backup = v.kv.find(([k]) => k === 'バックアップ')![1];
    expect(backup.split('\n')).toEqual([
      '~/.agent-hangar/backups/claude-config/（新しい世代）',
      '~/.agent-hangar/backups/codex-config/（新しい世代）',
      '~/.agent-hangar/backups/agents-skills-config/（新しい世代）',
    ]);
    expect(m.render(v)).toContain('共通のスキル');
    const en = m.model(multiView('en'));
    expect(en.kv[0]).toEqual(['Targets', 'Claude Code\nCodex\nShared skills']);
  });
  it('Claude だけの適用は、今までの見え方のまま', () => {
    const v = m.model(applyView('ja'));
    expect(v.showTargets).toBe(false);
    expect(v.kv.map(([k]) => k)).toEqual(['バックアップ', '変更後', '補足']);
    // Claude だけでも、対象が codex だけのときは名前を出す。
    const only = m.model(multiView('ja', { plan: { ...(multiView('ja').plan as object), targets: ['codex'], files: [{ rel: 'c', path: '/Users/u/.codex/c', op: 'create', binary: false, target: 'codex', lines: [] }] } }));
    expect(only.showTargets).toBe(true);
    expect(only.kv[0]).toEqual(['対象', 'Codex']);
  });
  it('完了：対象ごとの世代の置き場を出し、古い CLI の generation だけの結果も読む', () => {
    const done = m.model(multiView('ja', { stage: 'done', result: { generation: '20261012-104002', generations: [{ target: 'claude', name: '20261012-104002' }, { target: 'codex', name: '20261012-104003' }] } }));
    expect(done.done.backups).toEqual(['~/.agent-hangar/backups/claude-config/20261012-104002', '~/.agent-hangar/backups/codex-config/20261012-104003']);
    const old = m.model(applyView('ja'));
    expect(old.done.backups).toEqual([]);
    const oldDone = m.model({ ...applyView('ja'), stage: 'done', result: { generation: '20261012-104002' } });
    expect(oldDone.done.backups).toEqual(['~/.agent-hangar/backups/claude-config/20261012-104002']);
  });
  it('戻す：題と置き場と同じコマンドに対象を出す。Windows の区切りも守る', () => {
    const base = { ...applyView('ja'), job: 'restore', target: 'restore', name: '20261011-210400', configTarget: 'opencode' };
    const v = m.model(base);
    expect(v.title).toBe('opencode のバックアップから復元（2026-10-11 21:04）');
    expect(v.command).toBe('hangar config restore --target opencode 20261011-210400');
    expect(v.kv.find(([k]) => k === 'バックアップ')![1]).toBe('~/.agent-hangar/backups/opencode-config/（新しい世代）');
    expect(m.model({ ...base, lang: 'en', configTarget: 'agents-skills' }).title).toBe('Restore Shared skills backup (2026-10-11 21:04)');
    const done = m.model({ ...base, stage: 'done', result: { safety: '20261011-220000' }, windows: true, home: 'C:\\Users\\u', hangarHome: 'C:\\Users\\u\\.agent-hangar' });
    expect(done.done.backups).toEqual(['~\\.agent-hangar\\backups\\opencode-config\\20261011-220000']);
    // 対象を持たない見立て（古い殻）は、今までどおり Claude の世代として読む。
    expect(m.model({ ...applyView('ja'), job: 'restore', target: 'restore', name: '20261011-210400' }).command).toBe('hangar config restore 20261011-210400');
  });
  it('英語では、対象の名前にも日本語が混ざらない', () => {
    const v = m.model(multiView('en'));
    const text = [v.title, ...v.files.map((f) => `${f.targetLabel} ${f.what}`), ...v.kv.map(([k, x]) => `${k} ${x}`)].join('\n');
    expect(text).not.toMatch(KANA_KANJI);
  });
});

describe('承諾の窓の出し方', () => {
  it('何をどこに：ファイル、新規か変更か、何をするかを出し、パスはホームを ~ で書く', () => {
    const v = m.model(setupView('ja'));
    expect(v.title).toBe('MCP サーバーを登録');
    expect(v.files[0]).toMatchObject({ path: '~/.claude.json', opLabel: '変更', what: approveJa['approve.what.mcpAdd'] });
    // 名前の日時は書き込みを押したときに決まるので、窓では日時の形のまま見せ、何の日時かを添える。
    expect(v.kv[0]).toEqual(['バックアップ', '~/.agent-hangar/backups/claude.json-YYYYMMDDhhmmss（YYYYMMDDhhmmss は書き込み日時）']);
    expect(m.model(setupView('en')).kv[0]![1]).toBe('~/.agent-hangar/backups/claude.json-YYYYMMDDhhmmss (YYYYMMDDhhmmss is the date and time of writing)');
    // 日時の形を持たない名前（古い CLI の見立て）は、そのまま出す。
    expect(m.model(setupView('ja', { plan: { ...mcpPlan, backup: '/Users/u/.agent-hangar/backups/claude.json-20261012103105' } })).kv[0]![1]).toBe('~/.agent-hangar/backups/claude.json-20261012103105');
    expect(v.kv[2]![1]).toContain(approveJa['approve.note.secret']);
    expect(v.kv[2]![1]).toContain(approveJa['approve.note.check']);
    expect(v.command).toBe('hangar mcp install');
    expect(v.primary).toEqual({ label: '書き込み', danger: false });
  });
  it('差分：トークンは黒い帯にし、伏せ字そのものも出さない', () => {
    const html = m.diffHtml(m.model(setupView('ja'), 'diff'));
    expect(html).toContain('class="mask"');
    expect(html).not.toContain(CLI_MASK);
    expect(html).toContain('+ ');
    expect(html).toContain('~/.claude.json');
  });
  it('解除は赤い釦で、完了と失敗の段を出す', () => {
    const u = m.model(setupView('ja', { target: 'mcp-uninstall', stage: 'confirm' }));
    expect(u.primary).toEqual({ label: '登録を解除', danger: true });
    const done = m.model(setupView('ja', { stage: 'done', result: { changed: true, backups: ['/Users/u/.agent-hangar/backups/claude.json-1'], note: null } }));
    expect(done.done).toMatchObject({ title: '書き込みました。', backups: ['~/.agent-hangar/backups/claude.json-1'] });
    expect(m.render(done)).toContain('閉じる');
    const fail = m.model(setupView('ja', { stage: 'fail', failure: { code: 'changed', message: 'x' } }));
    expect(fail.fail).toEqual({ title: '書き込めませんでした。ファイルは変更していません。', detail: approveJa['approve.fail.changed'], reasonLabel: '理由', reload: true });
    expect(m.render(fail)).toContain('再読み込み');
    const other = m.model(setupView('ja', { stage: 'fail', failure: { code: 'write-failed', message: 'ロックを取れません' } }));
    expect(other.fail!.detail).toBe('ロックを取れません');
  });
  it('設定の適用：実行される指示とフックを補足に書き、注意の見た目にする', () => {
    const v = m.model(applyView('ja'));
    expect(v.title).toBe('同期された設定を適用');
    expect(v.warn).toBe(true);
    expect(v.files.map((f) => [f.path, f.opLabel])).toEqual([['~/.claude/CLAUDE.md', '変更'], ['~/.claude/skills/a/SKILL.md', '新規']]);
    expect(v.kv[0]![1]).toBe('~/.agent-hangar/backups/claude-config/（新しい世代）');
    expect(v.kv[2]![1]).toContain('skills/a/SKILL.md');
    expect(m.diffHtml(m.model(applyView('ja'), 'diff'))).toContain('- - a');
  });
  it('世代へ戻す：題に世代の時刻を出し、同じコマンドは世代の名前つき', () => {
    const v = m.model({ ...applyView('ja'), job: 'restore', target: 'restore', name: '20261011-210400' });
    expect(v.title).toBe('バックアップから復元（2026-10-11 21:04）');
    expect(v.command).toBe('hangar config restore 20261011-210400');
    expect(v.primary.label).toBe('復元');
  });
  it('英語では、題、何をどこに、補足、釦に日本語が混ざらない', () => {
    for (const view of [setupView('en'), setupView('en', { target: 'statusline-uninstall' }), applyView('en'), setupView('en', { stage: 'fail', failure: { code: 'changed', message: '日本語' } })]) {
      const v = m.model(view);
      const text = [v.title, ...v.files.map((f) => `${f.opLabel} ${f.what}`), ...v.kv.map(([k, x]) => `${k} ${x}`), v.primary.label, v.fail?.title ?? '', v.fail?.detail ?? ''].join('\n');
      expect(text).not.toMatch(KANA_KANJI);
    }
  });
  it('Windows のパスも ~ で書く', () => {
    expect(m.shortPath('C:\\Users\\you\\.claude.json', 'C:\\Users\\you')).toBe('~\\.claude.json');
    expect(m.shortPath('/elsewhere/x', '/Users/u')).toBe('/elsewhere/x');
    expect(m.generationLabel('bad')).toBe('bad');
  });
});
