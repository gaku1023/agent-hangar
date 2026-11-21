import { serve } from '@hono/node-server';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { which } from '../config/tools.ts';
import { openDb, type Db } from '../db/open.ts';
import { ensureSession } from '../indexer/write.ts';
import { createMcpApp } from '../mcp/app.ts';
import { claudeAsks } from '../provider/claude-code/hooks/asks.ts';
import { hookSettingsJson } from '../provider/claude-code/launch/hookSettings.ts';
import { issueMcpSecret } from '../runs/secrets.ts';
import { HookDecisions, type HookAsk, type HookChoice } from '../sessions/hookDecisions.ts';
import { PermissionAsks } from '../sessions/permissionAsks.ts';
import { startFakeAnthropic, type FakeAnthropic } from '../../test/fakeAnthropic.ts';
import { TMUX, testSocketPath, removeTestSocket, waitFor } from '../../test/tmux.ts';
import { ensureHookScript } from './hookScript.ts';

/**
 * 本物の claude（偽の Anthropic API につないだもの）で、PermissionRequest の同期の hook が答えを運ぶことを確かめる。
 * hangar の本物の hook の設定と台本と受け口（/hook と /decision）を使い、札に答える手は HookDecisions.decide を直に呼ぶ。
 * claude が PATH に無い環境（CI）と、tmux が無い環境では飛ばす。モデルは使わないので、料金はかからない。
 * 利用者の ~/.claude には触れず、使い捨ての HOME と CLAUDE_CONFIG_DIR で動かす。
 */
const CLAUDE = process.platform === 'win32' ? null : which('claude');
const API_KEY = 'sk-ant-api03-fakefakefakefakefakefakefakefakefake-AAAAAAAAAAAAAAAAAAAA';

describe.skipIf(!CLAUDE || !TMUX)('本物の claude：PermissionRequest の hook で答える', () => {
  let dir: string;
  let db: Db;
  let sock: string;
  let fake: FakeAnthropic | null = null;
  let server: ReturnType<typeof serve> | null = null;
  let decisions: HookDecisions;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-hookwait-')));
    db = openDb(':memory:');
    decisions = new HookDecisions();
    sock = testSocketPath();
  });
  afterEach(async () => {
    spawnSync(TMUX!, ['-S', sock, 'kill-server']);
    removeTestSocket(sock);
    server?.close();
    await fake?.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fake = null;
    server = null;
  });

  /** claude を起こし、合言葉を送る。hangar 側は本物の受け口を、1 本の HTTP で立てる。 */
  async function start(command: string, word: string): Promise<{ sid: string; capture: () => string; work: string }> {
    fake = await startFakeAnthropic(command);
    const psid = randomUUID();
    const sid = ensureSession(db, psid, path.join(dir, 'work'), 'd');
    const mcp = createMcpApp({ db, deviceId: 'd', port: 0, token: 'main', live: () => [], runs: { start: () => { throw new Error('unused'); } },
      usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: null }), permissionAsks: new PermissionAsks(), hookDecisions: decisions, asksOf: () => claudeAsks });
    const port = await new Promise<number>((resolve) => { server = serve({ fetch: new Hono().route('/mcp', mcp).fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => resolve(info.port)); });
    const config = path.join(dir, 'mcp.json');
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { hangar: { type: 'http', url: `http://127.0.0.1:${port}/mcp/s/${sid}`, headers: { Authorization: `Bearer ${issueMcpSecret(db, sid, 1)}` } } } }));
    const settings = path.join(dir, 'settings.json');
    fs.writeFileSync(settings, hookSettingsJson({ node: process.execPath, script: ensureHookScript(path.join(dir, 'hangar')), mcpConfigPath: config }));
    const work = path.join(dir, 'work');
    const cfg = path.join(dir, 'home', '.claude');
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ theme: 'light', hasCompletedOnboarding: true, customApiKeyResponses: { approved: [API_KEY.slice(-20)], rejected: [] }, projects: { [work]: { hasTrustDialogAccepted: true } } }));
    const env = ['HOME=' + path.join(dir, 'home'), 'CLAUDE_CONFIG_DIR=' + cfg, 'ANTHROPIC_BASE_URL=' + fake.url, 'ANTHROPIC_API_KEY=' + API_KEY, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'DISABLE_AUTOUPDATER=1', 'TERM=xterm-256color', 'LANG=en_US.UTF-8', 'PATH=' + process.env.PATH];
    const t = (...a: string[]) => spawnSync(TMUX!, ['-S', sock, ...a], { encoding: 'utf8' });
    t('new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', work, 'env', '-i', ...env, CLAUDE!, '--settings', settings, '--model', 'claude-sonnet-4-5', '--session-id', psid);
    const capture = () => t('capture-pane', '-p', '-t', 't').stdout;
    await waitFor(() => capture().includes('❯'), 30_000, 200);
    t('send-keys', '-t', 't', '-l', word);
    t('send-keys', '-t', 't', 'Enter');
    return { sid, capture, work };
  }

  /** 待ちが開くまで待って、答えを決める。決められたら true。 */
  async function decideWhenOpen(sid: string, ask: HookAsk, choice: HookChoice): Promise<void> {
    let ok = false;
    await waitFor(() => { ok = decisions.decide(sid, ask, choice) !== null; return ok; }, 30_000, 200);
  }

  it('Bash の許可に allow を返すと、札を出さずに道具が走る', async () => {
    const t = await start('echo hello > out.txt', 'BASH');
    await decideWhenOpen(t.sid, { kind: 'permission', tool: 'Bash', input: 'echo hello > out.txt' }, { kind: 'permission', behavior: 'allow' });
    await waitFor(() => fs.existsSync(path.join(t.work, 'out.txt')), 20_000, 200);
    expect(fs.readFileSync(path.join(t.work, 'out.txt'), 'utf8')).toBe('hello\n');
  }, 90_000);

  it('Bash の許可に No（interrupt つきの deny）を返すと、道具は走らず、画面の No と同じく中断になる', async () => {
    const t = await start('echo hello > out.txt', 'BASH');
    await decideWhenOpen(t.sid, { kind: 'permission', tool: 'Bash', input: 'echo hello > out.txt' }, { kind: 'permission', behavior: 'deny' });
    await waitFor(() => /Interrupted/.test(t.capture()), 20_000, 200);
    expect(fs.existsSync(path.join(t.work, 'out.txt'))).toBe(false);
  }, 90_000);

  it('AskUserQuestion の答えを返すと、札を出さずに、その答えがモデルへの道具の結果になる', async () => {
    const t = await start('true', 'ASK');
    await decideWhenOpen(t.sid, { kind: 'question', tool: 'AskUserQuestion', input: 'Which color?' }, { kind: 'question', value: 'Blue' });
    await waitFor(() => fake!.results.some((r) => /Which color\?.{0,12}Blue/.test(r)), 20_000, 200);
  }, 90_000);

  it('画面で先に答えられたら、待ちが閉じて台本が抜ける（後から決められる答えは無い）', async () => {
    const t = await start('true', 'ASK');
    await waitFor(() => decisions.pending(t.sid) === 1, 30_000, 200);
    await waitFor(() => /Which color\?/.test(t.capture()), 20_000, 200);
    // 札が出た直後のキーは、claude が受けない（実測）。少し置いてから打つ。
    await new Promise((r) => setTimeout(r, 2500));
    spawnSync(TMUX!, ['-S', sock, 'send-keys', '-t', 't', '2']);
    await waitFor(() => fake!.results.some((r) => /Which color\?.{0,12}Blue/.test(r)), 20_000, 200);
    await waitFor(() => decisions.pending(t.sid) === 0, 10_000, 100);
    expect(decisions.decide(t.sid, { kind: 'question', tool: 'AskUserQuestion', input: 'Which color?' }, { kind: 'question', value: 'Red' })).toBeNull();
  }, 90_000);
});
