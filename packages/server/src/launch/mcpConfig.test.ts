import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpConfigJson, mcpConfigPath, pruneMcpConfigs, removeMcpConfig, writeMcpConfig } from './mcpConfig.ts';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcpcfg-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('mcpConfigJson', () => {
  it('hangar という名前の http サーバを Bearer 付きで書く', () => {
    expect(JSON.parse(mcpConfigJson('http://x/mcp/s/s1', 'tok'))).toEqual({ mcpServers: { hangar: { type: 'http', url: 'http://x/mcp/s/s1', headers: { Authorization: 'Bearer tok' } } } });
  });
});

describe('writeMcpConfig', () => {
  it('0600 のファイルに書き、そのパスを返す', () => {
    const file = writeMcpConfig(home, 's1', 'http://x/mcp/s/s1', 'tok');
    expect(file).toBe(mcpConfigPath(home, 's1'));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe(mcpConfigJson('http://x/mcp/s/s1', 'tok'));
    // 置き場も他人に読ませない。
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
  });

  it('二度目は同じパスに上書きし、0600 を保つ', () => {
    fs.mkdirSync(path.join(home, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(home, 'mcp', 's1.json'), 'old', { mode: 0o644 });
    const file = writeMcpConfig(home, 's1', 'http://x/mcp/s/s1', 'tok2');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toContain('tok2');
  });

  it('ファイル名に使えない id は拒む', () => {
    expect(() => writeMcpConfig(home, '../escape', 'http://x', 'tok')).toThrow();
  });
});

describe('removeMcpConfig と pruneMcpConfigs', () => {
  it('消したファイルは無くなり、二度消しても投げない', () => {
    const file = writeMcpConfig(home, 's1', 'http://x', 'tok');
    removeMcpConfig(home, 's1');
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removeMcpConfig(home, 's1')).not.toThrow();
  });

  it('生きている run のもの以外を消す。置き場が無くても投げない', () => {
    writeMcpConfig(home, 's1', 'http://x', 'tok');
    writeMcpConfig(home, 's2', 'http://x', 'tok');
    writeMcpConfig(home, 's3', 'http://x', 'tok');
    fs.writeFileSync(path.join(home, 'mcp', 'other.txt'), 'x');
    const removed = pruneMcpConfigs(home, ['s2']);
    expect(removed.sort()).toEqual(['s1.json', 's3.json']);
    expect(fs.existsSync(mcpConfigPath(home, 's2'))).toBe(true);
    // .json 以外には触らない。
    expect(fs.existsSync(path.join(home, 'mcp', 'other.txt'))).toBe(true);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-mcpcfg-none-'));
    expect(pruneMcpConfigs(empty, [])).toEqual([]);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
