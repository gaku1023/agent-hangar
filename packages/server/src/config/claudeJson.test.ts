import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeJsonPath, upsertUserMcpServer } from './claudeJson.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cj-'));
  file = path.join(dir, '.claude.json');
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('claudeJsonPath', () => {
  it('既定は ~/.claude.json で、CLAUDE_CONFIG_DIR があればその下（実物で確認）', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeJsonPath('/tmp/h')).toBe(path.join('/tmp/h', '.claude.json'));
    process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg';
    expect(claudeJsonPath('/tmp/h')).toBe(path.join('/tmp/cfg', '.claude.json'));
  });
});

describe('upsertUserMcpServer', () => {
  it('無ければ 0600 で作る', () => {
    upsertUserMcpServer(file, 'hangar', { type: 'http', url: 'http://x/mcp' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { hangar: { type: 'http', url: 'http://x/mcp' } } });
  });

  it('他の項目と他のサーバを残し、元の mode を保つ', () => {
    fs.writeFileSync(file, JSON.stringify({ userID: 'u1', mcpServers: { other: { type: 'stdio' } } }), { mode: 0o600 });
    upsertUserMcpServer(file, 'hangar', { type: 'http', url: 'http://x/mcp' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ userID: 'u1', mcpServers: { other: { type: 'stdio' }, hangar: { type: 'http', url: 'http://x/mcp' } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['.claude.json']);
  });

  it('壊れた JSON は上書きせずに投げる。中身は message に出さない', () => {
    fs.writeFileSync(file, '{ 壊れている', { mode: 0o600 });
    let message = '';
    try {
      upsertUserMcpServer(file, 'hangar', {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(file);
    expect(message).not.toContain('壊れている');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ 壊れている');
  });
});
