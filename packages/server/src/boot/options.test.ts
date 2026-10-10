import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from './options.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const versionOf = (rel: string): string => (JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as { version: string }).version;

describe('サーバの版', () => {
  // /health と WebSocket の ready が名乗る版は、アプリの版と同じである。
  // 別に決め打ちすると、版を上げるたびに食い違い、利用者と調べる人がどちらの版かを取り違える。
  it('アプリの版（apps/desktop の package.json と tauri.conf.json）を名乗る', () => {
    expect(VERSION).toBe(versionOf('apps/desktop/package.json'));
    expect(VERSION).toBe(versionOf('apps/desktop/src-tauri/tauri.conf.json'));
  });
});
