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
  files: { path: string; op: string; opLabel: string; what: string; header: string; lines: Line[]; own: boolean; binary: boolean }[];
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
