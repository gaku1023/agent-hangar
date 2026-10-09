import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbPath, openDb } from '@agent-hangar/server/src/cliEntry.ts';
import { writeApplyOrder } from '@agent-hangar/server/src/sync/config/applyOrder.ts';
import { writeInbox } from '@agent-hangar/server/src/sync/config/inbox.ts';
import { applyOrderPath, configBackupsDir } from '@agent-hangar/server/src/sync/config/paths.ts';
import { runConfigApply, runConfigRestore } from './config.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();

let tmp: string;
let home: string;
let claudeDir: string;
let out: string[];
const log = (s: string): void => { out.push(s); };
const text = (): string => out.join('\n');
const read = (rel: string): string | null => { try { return fs.readFileSync(path.join(claudeDir, ...rel.split('/')), 'utf8'); } catch { return null; } };

/** 他の PC から、skills 1 件（フックの印つき）、commands 1 件、settings の鍵 1 件が届いた状態を作る。 */
function arrive(): void {
  const items = [
    { id: 'file:skills/demo/SKILL.md', kind: 'skills' as const, content: '---\nname: demo\nhooks: {}\n---\nbody', marks: ['hooks' as const] },
    { id: 'file:commands/hello.md', kind: 'commands' as const, content: 'say hello', marks: [] },
    { id: 'settings:model', kind: 'settings' as const, content: '"opus"', marks: [] },
  ];
  const blobs = new Map(items.map((i) => [sha(i.content), Buffer.from(i.content)]));
  writeInbox(home, 'dev-b', { manifest: { version: 1, deviceId: 'dev-b', createdAt: NOW, items: items.map((i) => ({ id: i.id, kind: i.kind, sha256: sha(i.content), size: Buffer.byteLength(i.content), marks: i.marks })) }, blobs, skipped: 0 }, { bundleSha256: 'b', forRowSha256: 'r', at: NOW, itemCount: items.length, skipped: 0 });
  writeApplyOrder(home, 'dev-a', [
    { id: items[0]!.id, kind: 'skills', op: 'create', take: 'remote', fromDeviceId: 'dev-b', sha256: sha(items[0]!.content), target: 'skills/demo/SKILL.md' },
    { id: items[1]!.id, kind: 'commands', op: 'overwrite', take: 'remote', fromDeviceId: 'dev-b', sha256: sha(items[1]!.content), target: 'commands/hello.md' },
    { id: items[2]!.id, kind: 'settings', op: 'create', take: 'remote', fromDeviceId: 'dev-b', sha256: sha(items[2]!.content), target: 'settings.json#model' },
  ], NOW);
}

const opts = () => ({ home, claudeDir, log, now: () => NOW });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cli-config-'));
  home = path.join(tmp, 'home');
  claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'commands/hello.md'), 'old hello');
  out = [];
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('hangar config apply', () => {
  it('指示書が無ければ、案内を出して失敗で終わる（JSON のときは理由の符号つき）', async () => {
    expect(await runConfigApply({ ...opts(), yes: true })).toBe(1);
    expect(text()).toContain('適用の指示書がありません');
    out = [];
    expect(await runConfigApply({ ...opts(), plan: true, json: true })).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, code: 'no-order' });
  });

  it('--plan は件数と種類、実行される指示、フックの印を見せるだけで、何も書かない', async () => {
    arrive();
    expect(await runConfigApply({ ...opts(), plan: true })).toBe(0);
    const t = text();
    expect(t).toContain('新規 2 件');
    expect(t).toContain('上書き 1 件');
    expect(t).toContain('スキル 1');
    expect(t).toContain('settings.json の鍵 1');
    expect(t).toContain('実行される内容');
    expect(t).toContain('skills/demo/SKILL.md');
    expect(t).toContain('フック');
    expect(t).toContain('控え');
    expect(read('commands/hello.md')).toBe('old hello');
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
  });

  it('--plan --json は、見立てをそのまま JSON で出す（殻の確認が読む）', async () => {
    arrive();
    expect(await runConfigApply({ ...opts(), plan: true, json: true })).toBe(0);
    const j = JSON.parse(out.join('')) as { ok: boolean; plan: { counts: Record<string, number>; instructions: number; exec: { id: string; marks: string[] }[] } };
    expect(j.ok).toBe(true);
    expect(j.plan.counts).toMatchObject({ create: 2, overwrite: 1 });
    expect(j.plan.instructions).toBe(2);
    expect(j.plan.exec).toMatchObject([{ id: 'file:skills/demo/SKILL.md', marks: ['hooks'] }]);
  });

  it('対話でない端末で --yes が無ければ、聞けないので何も書かない', async () => {
    arrive();
    expect(await runConfigApply({ ...opts(), interactive: false })).toBe(1);
    expect(text()).toContain('--yes');
    expect(read('commands/hello.md')).toBe('old hello');
  });

  it('断られたら何も書かず、指示書も残す', async () => {
    arrive();
    const asked: string[] = [];
    expect(await runConfigApply({ ...opts(), interactive: true, ask: async (q) => { asked.push(q); return false; } })).toBe(1);
    expect(asked).toHaveLength(1);
    expect(text()).toContain('適用しませんでした');
    expect(read('commands/hello.md')).toBe('old hello');
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
  });

  it('承諾されたら書き、控えの世代の名前と戻し方を伝え、指示書を消す', async () => {
    arrive();
    expect(await runConfigApply({ ...opts(), interactive: true, ask: async () => true })).toBe(0);
    expect(read('commands/hello.md')).toBe('say hello');
    expect(read('skills/demo/SKILL.md')).toContain('name: demo');
    expect(JSON.parse(read('settings.json')!)).toEqual({ model: 'opus' });
    expect(fs.existsSync(applyOrderPath(home))).toBe(false);
    expect(fs.readFileSync(path.join(configBackupsDir(home), '20261010-120000', 'commands/hello.md'), 'utf8')).toBe('old hello');
    expect(text()).toContain('hangar config restore 20261010-120000');
    // 基準が更新されている（DB は CLI が開いて書いた）。
    const db = openDb(dbPath(home));
    try { expect(db.prepare('select sha256 from config_base where item_id = ?').get('file:commands/hello.md')).toEqual({ sha256: sha('say hello') }); } finally { db.close(); }
  });

  it('--order は、確認した指示書にだけ適用する（確認のあとに選び直されていたら書かない）', async () => {
    arrive();
    expect(await runConfigApply({ ...opts(), yes: true, json: true, order: NOW + 1 })).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, code: 'stale' });
    expect(read('commands/hello.md')).toBe('old hello');
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
    out = [];
    expect(await runConfigApply({ ...opts(), yes: true, json: true, order: NOW })).toBe(0);
    expect(read('commands/hello.md')).toBe('say hello');
  });

  it('--yes --json は聞かずに書き、結果を JSON で出す', async () => {
    arrive();
    expect(await runConfigApply({ ...opts(), yes: true, json: true })).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, result: { generation: '20261010-120000', written: 3, removed: 0, keptMine: 0 } });
    expect(read('commands/hello.md')).toBe('say hello');
  });

  it('途中で書けなかったら、失敗で終わり、書きかけを残さない', async () => {
    arrive();
    // settings.json を壊して、設定の鍵を書けない状態にする。
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ broken');
    expect(await runConfigApply({ ...opts(), yes: true })).toBe(1);
    expect(text()).toContain('settings.json');
    expect(read('commands/hello.md')).toBe('old hello');
    expect(read('skills/demo/SKILL.md')).toBeNull();
    expect(fs.existsSync(applyOrderPath(home))).toBe(true);
  });
});

describe('hangar config restore', () => {
  it('名前を省くと、世代の一覧を出す（無ければ無いと言う）', async () => {
    expect(await runConfigRestore({ ...opts() })).toBe(0);
    expect(text()).toContain('控えの世代はありません');
    arrive();
    await runConfigApply({ ...opts(), yes: true });
    out = [];
    expect(await runConfigRestore({ ...opts() })).toBe(0);
    expect(text()).toContain('20261010-120000');
    expect(text()).toContain('hangar config restore <世代>');
    out = [];
    expect(await runConfigRestore({ ...opts(), json: true })).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, generations: [{ name: '20261010-120000', files: 1 }] });
  });

  it('世代を指すと、戻す先と消す先を見せ、承諾で戻す。戻す前の状態も世代に取る', async () => {
    arrive();
    await runConfigApply({ ...opts(), yes: true });
    out = [];
    let t = NOW;
    const asked: string[] = [];
    expect(await runConfigRestore({ ...opts(), now: () => (t += 60_000), name: '20261010-120000', interactive: true, ask: async (q) => { asked.push(q); return true; } })).toBe(0);
    expect(asked).toHaveLength(1);
    expect(text()).toContain('commands/hello.md');
    expect(text()).toContain('skills/demo/SKILL.md');
    expect(read('commands/hello.md')).toBe('old hello');
    expect(read('skills/demo/SKILL.md')).toBeNull();
    expect(read('settings.json')).toBeNull();
    expect(text()).toContain('20261010-120100');
    const db = openDb(dbPath(home));
    try { expect(db.prepare('select count(*) n from config_base').get()).toEqual({ n: 0 }); } finally { db.close(); }
  });

  it('--plan は戻す先と消す先だけを出し、何も戻さない（--json は殻の確認が読む）', async () => {
    arrive();
    await runConfigApply({ ...opts(), yes: true });
    out = [];
    expect(await runConfigRestore({ ...opts(), name: '20261010-120000', plan: true, json: true })).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, plan: { name: '20261010-120000', restore: ['commands/hello.md'], remove: ['skills/demo/SKILL.md', 'settings.json'] } });
    expect(read('commands/hello.md')).toBe('say hello');
    out = [];
    expect(await runConfigRestore({ ...opts(), name: '20261010-120000', plan: true })).toBe(0);
    expect(text()).toContain('commands/hello.md');
    expect(read('commands/hello.md')).toBe('say hello');
    out = [];
    expect(await runConfigRestore({ ...opts(), name: 'nope', plan: true, json: true })).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, code: 'bad-name' });
  });

  it('断られたら何も戻さない。無い世代と対話でない端末は失敗で終わる', async () => {
    arrive();
    await runConfigApply({ ...opts(), yes: true });
    out = [];
    expect(await runConfigRestore({ ...opts(), name: '20261010-120000', interactive: true, ask: async () => false })).toBe(1);
    expect(read('commands/hello.md')).toBe('say hello');
    expect(await runConfigRestore({ ...opts(), name: '20261010-120000', interactive: false })).toBe(1);
    expect(read('commands/hello.md')).toBe('say hello');
    out = [];
    expect(await runConfigRestore({ ...opts(), name: '19990101-000000', yes: true })).toBe(1);
    expect(text()).toContain('その世代がありません');
  });
});
