import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../../db/open.ts';
import { collectAll, type TargetContext } from './index.ts';

let tmp: string;
let db: Db;
const put = (rel: string): void => { const f = path.join(tmp, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'body'); };

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-')); db = openDb(':memory:'); });
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('.trash の下は、どの対象でも集めない', () => {
  it('claude、agents-skills、codex、opencode の skills などの .trash を飛ばし、隣の本物は集める', () => {
    for (const base of ['claude/skills', 'claude/commands', 'claude/agents', 'agents/skills', 'codex/skills', 'codex/rules', 'opencode/skills', 'opencode/agents']) {
      put(`${base}/.trash/1790-1-abc/SKILL.md`);
      put(`${base}/real/SKILL.md`);
    }
    const ctx: TargetContext = {
      db, deviceId: 'd', home: path.join(tmp, 'hangar'), claudeDir: path.join(tmp, 'claude'), allowedUnsent: new Map(),
      codexHome: path.join(tmp, 'codex'), codexEnabled: true, opencodeDir: path.join(tmp, 'opencode'), opencodeEnabled: true,
      agentsSkillsDir: path.join(tmp, 'agents', 'skills'), claudeJsonPath: path.join(tmp, 'claude.json'), hangarSettingsPath: path.join(tmp, 'settings.json'),
      switches: { 'agents-skills': true },
    };
    const ids = collectAll(ctx).items.map((i) => i.id);
    expect(ids.filter((i) => i.includes('.trash'))).toEqual([]);
    expect(ids.filter((i) => i.includes('real')).length).toBeGreaterThanOrEqual(4);
  });
});
