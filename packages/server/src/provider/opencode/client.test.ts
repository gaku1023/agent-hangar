import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFakeOpencodeRequests, writeFakeOpencode } from '../../../test/fake-opencode.ts';
import { OpencodeClient } from './client.ts';
import { serveEnv } from './serve/env.ts';
import { killGroup, startServe, type ServeProcess } from './serve/spawn.ts';

// opencode 2.1.4 は、場所（`location[directory]` の問いか `x-opencode-directory` の header）の無い要求を serve の作業フォルダに寄せ、
// そこで初めて見る場所なら、設定を読み MCP をつなぎ直して見張りを始める。
// hangar からの要求は、場所を問いで渡すもの以外も、serve の会話のフォルダを header で指す。
describe('OpencodeClient の場所', () => {
  let dir: string;
  let work: string;
  let other: string;
  let serve: ServeProcess | null = null;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-client-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-client-work-'));
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-client-other-'));
  });
  afterEach(async () => {
    if (serve) { killGroup(serve.pid, 'SIGKILL'); await serve.exited; serve = null; }
    for (const d of [dir, work, other]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('場所を問いで渡さない要求も、serve の会話のフォルダを指す。問いで渡した場所はそのまま効く', async () => {
    const { bin, requestsFile } = writeFakeOpencode(dir, { activeIds: ['ses_a'] });
    serve = await startServe({ bin, env: serveEnv(bin), directory: work });
    const c = new OpencodeClient({ url: serve.url, password: serve.password, directory: work });
    const before = readFakeOpencodeRequests(requestsFile).length;
    await c.active();
    await c.session('ses_a').catch(() => undefined);
    await c.interrupt('ses_a');
    await c.messages('ses_a', { limit: 10 });
    await c.putInstruction('ses_a', 'hangar', 'x');
    await c.deleteCredential('cred_x').catch(() => undefined);
    await c.events(AbortSignal.timeout(2000)).catch(() => undefined);
    await c.mcpStatus(other);
    const reqs = readFakeOpencodeRequests(requestsFile).slice(before);
    const at = (p: string) => reqs.filter((r) => r.path === p).map((r) => r.directory);
    expect(at('/api/session/active')).toEqual([work]);
    expect(at('/api/session/ses_a')).toEqual([work]);
    expect(at('/api/session/ses_a/interrupt')).toEqual([work]);
    expect(at('/api/session/ses_a/message')).toEqual([work]);
    expect(at('/api/experimental/session/ses_a/instructions/entries/hangar')).toEqual([work]);
    expect(at('/api/credential/cred_x')).toEqual([work]);
    expect(at('/api/event')).toEqual([work]);
    // 問いで渡した場所は header より先に効く（options の問い合わせが、ほかの会話の serve を借りるとき）。
    expect(reqs.filter((r) => r.path === '/api/mcp').map((r) => [r.directory, r.via])).toEqual([[other, 'query']]);
  });

  it('日本語と空白を含む場所も、符号にして渡し、そのまま読める', async () => {
    const odd = path.join(work, 'さんぷる dir');
    fs.mkdirSync(odd);
    const { bin, requestsFile } = writeFakeOpencode(dir);
    serve = await startServe({ bin, env: serveEnv(bin), directory: odd });
    await new OpencodeClient({ url: serve.url, password: serve.password, directory: odd }).active();
    expect(readFakeOpencodeRequests(requestsFile).filter((r) => r.path === '/api/session/active').at(-1)?.directory).toBe(odd);
  });
});
