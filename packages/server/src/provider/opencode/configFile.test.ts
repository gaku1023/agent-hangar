import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opencodeConfigPath } from './configFile.ts';

describe('opencodeConfigPath', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-config-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('XDG_CONFIG_HOME が無ければ HOME の下の .config/opencode', () => {
    expect(opencodeConfigPath(home, {})).toBe(path.join(home, '.config', 'opencode', 'opencode.json'));
  });

  it('利用者が XDG_CONFIG_HOME を置いていれば、serve と同じくその下を読む', () => {
    const xdg = path.join(home, 'xdg-config');
    expect(opencodeConfigPath(home, { XDG_CONFIG_HOME: xdg })).toBe(path.join(xdg, 'opencode', 'opencode.json'));
    fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'opencode', 'opencode.jsonc'), '{}');
    expect(opencodeConfigPath(home, { XDG_CONFIG_HOME: xdg })).toBe(path.join(xdg, 'opencode', 'opencode.jsonc'));
  });

  it('空の XDG_CONFIG_HOME は無いものとして読む', () => {
    expect(opencodeConfigPath(home, { XDG_CONFIG_HOME: '' })).toBe(path.join(home, '.config', 'opencode', 'opencode.json'));
  });
});
