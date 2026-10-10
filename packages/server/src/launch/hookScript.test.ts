import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureHookScript, HOOK_SCRIPT_NAME } from './hookScript.ts';

/**
 * hook の台本（hangar-hook.mjs）を、本物の node で走らせて確かめる。
 * claude はこの台本を shell を通さずに起こし（exec の形）、標準入力に hook の入力を流す。
 * 台本は MCP の設定ファイルから宛先と鍵を読んで、入力をそのままサーバへ送る。
 * hangar が止まっていても、claude の画面を汚さないよう、何も言わずに 0 で抜ける。
 */
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-hookscript-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function runScript(script: string, args: string[], stdin: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}

function config(url: string): string {
  const file = path.join(home, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { hangar: { type: 'http', url, headers: { Authorization: 'Bearer s3cret' } } } }));
  return file;
}

describe('ensureHookScript', () => {
  it('<home>/bin に置き、中身が同じなら書き直さない', () => {
    const file = ensureHookScript(home);
    expect(file).toBe(path.join(home, 'bin', HOOK_SCRIPT_NAME));
    const before = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, new Date(1000), new Date(1000));
    expect(ensureHookScript(home)).toBe(file);
    expect(fs.statSync(file).mtimeMs).toBe(1000);
    fs.writeFileSync(file, 'old');
    ensureHookScript(home);
    expect(fs.readFileSync(file, 'utf8')).not.toBe('old');
    expect(before).toBeGreaterThan(0);
  });
});

describe('hangar-hook.mjs', () => {
  it('標準入力を、設定の宛先の /hook へ鍵付きで送り、0 で抜ける', async () => {
    const got: { url?: string; auth?: string; body?: string } = {};
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { Object.assign(got, { url: req.url, auth: req.headers.authorization, body }); res.writeHead(204).end(); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '色は？' }] } });
      const r = await runScript(ensureHookScript(home), [config(`http://127.0.0.1:${port}/mcp/s/abc`)], input);
      expect(r).toEqual({ code: 0, out: '', err: '' });
      expect(got).toEqual({ url: '/mcp/s/abc/hook', auth: 'Bearer s3cret', body: input });
    } finally {
      server.close();
    }
  });

  it('サーバが止まっていても、設定が無くても、何も言わずに 0 で抜ける', async () => {
    const script = ensureHookScript(home);
    // 一度開いて閉じたポートなら、誰も待ち受けていない。
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    expect(await runScript(script, [config(`http://127.0.0.1:${port}/mcp/s/abc`)], '{}')).toEqual({ code: 0, out: '', err: '' });
    expect(await runScript(script, [path.join(home, 'missing.json')], '{}')).toEqual({ code: 0, out: '', err: '' });
    expect(await runScript(script, [], '{}')).toEqual({ code: 0, out: '', err: '' });
  });
});
