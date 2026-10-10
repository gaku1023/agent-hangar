import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookSettingsJson, writeHookSettings } from './hookSettings.ts';
import { pruneMcpConfigs, removeMcpConfig, runSettingsPath, writeMcpConfig } from './mcpConfig.ts';
import { expectMode } from '../../../../test/platform.ts';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-hookset-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const o = { node: '/opt/node/bin/node', script: '/h/bin/hangar-hook.mjs', mcpConfigPath: '/h/mcp/s1.json' };

describe('hookSettingsJson', () => {
  it('AskUserQuestion の前と後で、台本を shell を通さずに裏で起こす', () => {
    const hook = { type: 'command', command: o.node, args: [o.script, o.mcpConfigPath], async: true, timeout: 10 };
    const entry = [{ matcher: 'AskUserQuestion', hooks: [hook] }];
    expect(JSON.parse(hookSettingsJson(o))).toEqual({ hooks: { PreToolUse: entry, PostToolUse: entry, PostToolUseFailure: entry } });
  });

  it('鍵を書かない（鍵は MCP の設定ファイルにだけある）', () => {
    expect(hookSettingsJson(o)).not.toMatch(/Bearer|Authorization/);
  });
});

describe('writeHookSettings', () => {
  it('MCP の設定の隣に 0600 で書き、run の後始末で一緒に消える', () => {
    writeMcpConfig(home, 's1', 'http://x', 'tok');
    const file = writeHookSettings(home, 's1', o);
    expect(file).toBe(runSettingsPath(home, 's1'));
    expectMode(file, 0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe(hookSettingsJson(o));
    removeMcpConfig(home, 's1');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('掃除は、生きている run の設定を hook の設定ごと残す', () => {
    for (const id of ['s1', 's2']) {
      writeMcpConfig(home, id, 'http://x', 'tok');
      writeHookSettings(home, id, o);
    }
    expect(pruneMcpConfigs(home, ['s2']).sort()).toEqual(['s1.json', 's1.settings.json']);
    expect(fs.existsSync(runSettingsPath(home, 's2'))).toBe(true);
  });

  it('ファイル名に使えない id は拒む', () => {
    expect(() => writeHookSettings(home, '../x', o)).toThrow();
  });
});
