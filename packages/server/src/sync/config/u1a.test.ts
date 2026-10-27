import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangeOut } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient } from '../../../test/fake-cloud.ts';
import { openDb } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { applyRemoteChange } from '../apply.ts';
import { configBackupsDir } from './paths.ts';
import { ConfigSyncService } from './service.ts';

// U1a：画面が使うサーバと shared の型の足し（missingEnv、世代の target、notices、知らないキーの数）。
let tmp: string;
let shared: FakeCloudClient;
const MISSING_A = 'U1A_NEVER_SET_ONE';
const MISSING_B = 'U1A_NEVER_SET_TWO';

function pc(id: string, name: string) {
  const dir = path.join(tmp, id);
  const claudeDir = path.join(dir, 'claude');
  const home = path.join(dir, 'home');
  const opencodeDir = path.join(dir, 'opencode');
  for (const d of [claudeDir, home, opencodeDir]) fs.mkdirSync(d, { recursive: true });
  const db = openDb(':memory:');
  const cloud = shared.asDevice(id);
  void cloud.health();
  cloud.calls.length = 0;
  const service = new ConfigSyncService({
    db, deviceId: id, deviceName: name, claudeDir, home, cloud, keyring: cloud.keyring,
    enabled: () => true, switchedOn: () => true, approval: () => 'each', now: () => 1_700_000_000_000,
    targetSwitches: () => ({ opencode: true, 'opencode-mcp': true }),
    agentsEnabled: () => ({ codex: false, opencode: true }),
    targetPaths: { opencodeDir },
  });
  return { id, name, db, claudeDir, home, opencodeDir, service };
}
type Pc = ReturnType<typeof pc>;
const addDevices = (ps: Pc[]): void => { for (const p of ps) for (const q of ps) upsertShared(p.db, 'devices', { id: q.id, name: q.name, platform: 'darwin' }, q.id); };
async function sync(from: Pc, to: Pc): Promise<void> {
  await from.service.send();
  for (const row of from.db.prepare('select * from config_snapshots').all() as Record<string, unknown>[]) {
    const c: ChangeOut = { tableName: 'config_snapshots', rowId: String(row.device_id), op: 'upsert', payload: row, updatedAt: Number(row.updated_at), seq: 1, deviceId: from.id };
    applyRemoteChange(to.db, c, { ownDeviceId: to.id, skipOwn: true });
  }
  await to.service.receive();
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1a-')); shared = new FakeCloudClient(); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('U1a', () => {
  it('届いた opencode の項目に、この PC に無い環境変数の名前を missingEnv で添える（設定と MCP の両方）', async () => {
    const a = pc('dev-a', 'mac'); const b = pc('dev-b', 'mini');
    addDevices([a, b]);
    fs.writeFileSync(path.join(a.opencodeDir, 'opencode.json'), JSON.stringify({
      model: `{env:${MISSING_A}}`, theme: 'plain',
      mcp: { docs: { type: 'local', command: ['npx', 'docs'], environment: { TOKEN: `{env:${MISSING_B}}` } }, calm: { type: 'local', command: ['npx', 'calm'] } },
    }));
    fs.writeFileSync(path.join(b.opencodeDir, 'opencode.json'), '{}');
    await sync(a, b);
    const by = Object.fromEntries(b.service.inbox().items.map((i) => [i.id, i.missingEnv]));
    expect(by['opencode:json:model']).toEqual([MISSING_A]);
    expect(by['opencode:json:theme']).toBeUndefined();
    const docs = b.service.inbox().items.find((i) => i.kind === 'opencode-mcp' && i.label.includes('docs'));
    expect(docs?.missingEnv).toEqual([MISSING_B]);
    const calm = b.service.inbox().items.find((i) => i.kind === 'opencode-mcp' && i.label.includes('calm'));
    expect(calm?.missingEnv).toBeUndefined();
  });

  it('世代の行に対象名が入り、Claude の古い世代は claude になる', () => {
    const a = pc('dev-a', 'mac');
    fs.mkdirSync(path.join(configBackupsDir(a.home), '20260101-000000'), { recursive: true });
    fs.writeFileSync(path.join(configBackupsDir(a.home), '20260101-000000', 'x'), 'x');
    expect(a.service.backups().generations.map((g) => g.target)).toEqual(['claude']);
  });

  it('dto().notices は opencode の json と jsonc の併存を返す', () => {
    const a = pc('dev-a', 'mac');
    expect(a.service.dto().notices).toBeUndefined();
    fs.writeFileSync(path.join(a.opencodeDir, 'opencode.json'), '{}');
    fs.writeFileSync(path.join(a.opencodeDir, 'opencode.jsonc'), '{}');
    expect(a.service.dto().notices).toEqual([{ target: 'opencode', code: 'both-json-jsonc' }]);
  });

  it('知らないキーは送らなかった項目の一覧には出るが、unsentCount・unsent には数えず unknownKeyCount で分ける', () => {
    const a = pc('dev-a', 'mac');
    fs.writeFileSync(path.join(a.claudeDir, 'settings.json'), JSON.stringify({ model: 'opus', someFutureKey: 1, permissions: { allow: ['Bash(ls)', 'Read(//Users/x/**)'] } }));
    const o = a.service.outgoing();
    expect(a.service.unsent().items.map((i) => i.kind).sort()).toEqual(['permission-rule', 'unknown-key']);
    expect(o.unsentCount).toBe(1);
    expect(o.unknownKeyCount).toBe(1);
    expect(a.service.dto()).toMatchObject({ unsent: 1, unknownKeyCount: 1 });
  });
});
