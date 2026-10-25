import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureOutputSync } from '../src/platform/capture.ts';
import { formQuestionOf } from '../src/provider/opencode/asks.ts';
import { formOf, OpencodeClient, permissionRequestOf } from '../src/provider/opencode/client.ts';
import { BUILTIN_OPENCODE_VALUE_FLAGS, opencodeSubcommandsFromHelp, parseOpencodeHelp } from '../src/provider/opencode/compat/cli.ts';
import { judgeOpencodeVersion, opencodeProbeEnv, opencodeVersionOf } from '../src/provider/opencode/compat/version.ts';
import type { ServeProcess } from '../src/provider/opencode/serve/spawn.ts';
import { convertMessages } from '../src/provider/opencode/transcript/convert.ts';
import { newestOpencodeFixture, readOpencodeFixture } from './opencodeFixtures.ts';
import {
  LIVE_ECHO, LIVE_QUESTION, liveEnv, makeWorld, opencodeBin, PROMPT_TURN, runCli, serveApi, startLiveServe, startMockLlm, startMockMcp,
  stopLiveServe, tapEvents, until, writeUserConfig, type EventTap, type LiveWorld,
} from './opencodeHarness.ts';

/**
 * 週に 1 度の照合（.github/workflows/opencode-compat.yml）だけが HANGAR_LIVE_OPENCODE=1 を立てる。ふだんの npm test では飛ぶ。
 * 本物の opencode を、試しの置き場（XDG_*_HOME を一時ディレクトリへ）と空の環境で動かし、hangar が頼る形が残っているかを見る（docs/design.md「opencode との互換」）。
 * - --help：サブコマンドとフラグ（値を取るかも）が、最も新しい見本の help.txt と同じか。外のターミナルの横取りに使うフラグもここで見る。
 * - serve：hangar が使う道（provider/opencode/client.ts）が、応答の形ごと残っているか。包みの読み方（client.ts、asks.ts、transcript/convert.ts）をそのまま通して確かめる。
 * - CLI の session export と import（同期とほかの PC での再開）が ID を保つか。
 * LLM は呼ばない。OpenAI 互換の模擬を手元に立て、決まった並びで道具を呼ばせる（opencodeHarness.ts）。
 * どれかが落ちたら、見本を採り直す合図である（npm run capture-opencode-fixtures）。版が新しいだけなら落とさない。
 */
const LIVE = process.env.HANGAR_LIVE_OPENCODE === '1';
const CLI_TIMEOUT_MS = 60_000;
const STEP_MS = 120_000;
/** 横取り（config/shellHook.ts の opencode()）が写すフラグ。消えるか値の取り方が変わると、横取りした起動が壊れる。 */
const INTERCEPT_FLAGS = ['--auto', '--prompt', '--session', '-s'];
/** chat/completions の要求の本文から、system の発言を 1 つの文にする。 */
function systemOf(body: string): string {
  try {
    const msgs = (JSON.parse(body) as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
    return msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  } catch {
    return '';
  }
}
/** システムプロンプトへの追記の試しの文。 */
const INSTRUCTION = 'Hangar live check: the instructions entry reached the model.';

describe.skipIf(!LIVE)('いまの opencode と最も新しい見本', () => {
  it('サブコマンドとフラグが、最も新しい見本の --help と同じ', () => {
    const f = newestOpencodeFixture();
    expect(f, '見本がありません。npm run capture-opencode-fixtures で採ってください').not.toBeNull();
    const bin = opencodeBin();
    expect(bin, 'opencode が見つかりません').not.toBeNull();
    const env = opencodeProbeEnv(bin!);
    const version = opencodeVersionOf(captureOutputSync(bin!, ['--version'], { env, timeoutMs: CLI_TIMEOUT_MS }).stdout);
    const text = captureOutputSync(bin!, ['--help'], { env, timeoutMs: CLI_TIMEOUT_MS }).stdout;
    console.log(`opencode ${version ?? '(版を読めない)'}（${judgeOpencodeVersion(version)}）、最も新しい見本 ${f!.version}`);
    const now = parseOpencodeHelp(text);
    const want = parseOpencodeHelp(readOpencodeFixture(f!, 'help.txt'))!;
    expect(now).not.toBeNull();
    expect(now!.subcommands).toEqual(want.subcommands);
    expect(now!.flags).toEqual(want.flags);
    expect(now!.valueFlags).toEqual(want.valueFlags);
    // 組み込みの一覧（provider/opencode/compat/cli.ts）との差は、ずれとして記録されるものである。
    expect(opencodeSubcommandsFromHelp(text).drifts).toEqual([]);
    for (const flag of INTERCEPT_FLAGS) {
      expect(now!.flags, flag).toContain(flag);
      expect(now!.valueFlags.includes(flag), flag).toBe(BUILTIN_OPENCODE_VALUE_FLAGS.includes(flag));
    }
  });

  describe('serve の道', () => {
    let bin: string;
    let world: LiveWorld;
    let llm: Awaited<ReturnType<typeof startMockLlm>>;
    let mcp: Awaited<ReturnType<typeof startMockMcp>>;
    let serve: ServeProcess | null = null;
    let tap: EventTap | null = null;
    let client: OpencodeClient;
    let sid = '';
    const of = (s: string | null) => (e: { sessionID: string | null; type: string }) => e.sessionID === sid && e.type === s;

    beforeAll(async () => {
      bin = opencodeBin()!;
      world = makeWorld();
      llm = await startMockLlm({ repo: world.repo });
      mcp = await startMockMcp();
      writeUserConfig(world, llm.url);
      serve = await startLiveServe(bin, world, mcp.url);
      client = new OpencodeClient(serve, { timeoutMs: 30_000 });
      tap = await tapEvents((signal) => client.events(signal));
    }, STEP_MS);

    afterAll(async () => {
      await tap?.close();
      if (serve) await stopLiveServe(serve);
      await llm?.close();
      await mcp?.close();
      // 試しの会話と設定は、置き場ごと消える（利用者の置き場には書いていない）。
      if (world) fs.rmSync(world.root, { recursive: true, force: true });
    }, STEP_MS);

    it('/api/event はつないだ直後に server.connected を流す', async () => {
      await tap!.waitFor((e) => e.type === 'server.connected');
    });

    it('/api/session/active は動いている会話だけを鍵に持つ（何も動いていなければ空）', async () => {
      const raw = await serveApi(serve!, 'GET', '/api/session/active');
      expect(raw.status).toBe(200);
      expect(raw.body).toEqual({ data: {} });
      expect((await client.active()).size).toBe(0);
    });

    it('モードとモデルとプロバイダーと integration と設定のモデルを、hangar の読む形で返す', async () => {
      // 2.1.4 は場所ごとの最初の問いに空の一覧を返すことがあるので、聞き直す。
      const agents = await until(() => client.agents(world.repo), (a) => a.length > 0, '/api/agent');
      expect(agents).toContainEqual(expect.objectContaining({ id: 'build', mode: 'primary' }));
      const models = await until(() => client.models(world.repo), (m) => m.some((x) => x.providerID === 'mock'), '/api/model');
      expect(models.find((m) => m.providerID === 'mock' && m.id === 'mock')).toMatchObject({ name: 'Mock', context: 65536, tools: true });
      expect(await client.providers(world.repo)).toContainEqual({ id: 'mock', name: 'Mock', host: '127.0.0.1' });
      expect((await client.providerRows(world.repo)).find((p) => p.id === 'mock')).toMatchObject({ baseURL: `${llm.url}/v1` });
      const integrations = await client.integrations(world.repo);
      expect(integrations.length).toBeGreaterThan(0);
      expect(integrations.some((i) => i.key)).toBe(true);
      const one = integrations.find((i) => i.key)!;
      expect((await client.integration(one.id, world.repo))?.id).toBe(one.id);
      expect(await client.configuredModel(world.repo)).toBe('mock/mock');
    }, STEP_MS);

    it('hangar の MCP（OPENCODE_CONFIG_CONTENT で渡したもの）が /api/mcp で connected になる', async () => {
      const rows = await until(() => client.mcpStatus(world.repo), (r) => r.some((x) => x.name === 'hangar' && x.status === 'connected'), '/api/mcp connected', 60_000, 500);
      expect(rows.find((x) => x.name === 'hangar')?.status).toBe('connected');
    }, STEP_MS);

    it('会話を ID なしで作り、システムプロンプトへの追記を差し込める', async () => {
      sid = await client.createSession({ directory: world.repo });
      expect(sid).toMatch(/^ses_/);
      await tap!.waitFor(of('session.created'));
      // 差し込んだだけでは出来事は流れない。モデルまで届いたかは、次のターンの要求の本文で見る。
      await client.putInstruction(sid, 'hangar', INSTRUCTION);
    }, STEP_MS);

    it('1 ターン：許可と form を出し、答えると終わる。状態の出来事と取り直しの道が同じ形で答える', async () => {
      const pr = await serveApi(serve!, 'POST', `/api/session/${sid}/prompt`, { text: PROMPT_TURN });
      expect(pr.status, JSON.stringify(pr.body)).toBeLessThan(300);
      await tap!.waitFor(of('session.execution.started'), 60_000);
      expect((await client.active()).has(sid)).toBe(true);

      const perms = await until(() => client.permissionRequests(world.repo), (p) => p.some((x) => x.sessionID === sid), '/api/permission/request', 60_000);
      const perm = perms.find((x) => x.sessionID === sid)!;
      expect(perm).toMatchObject({ action: 'shell' });
      expect(perm.resources).toContain(LIVE_ECHO);
      const asked = await tap!.waitFor(of('permission.asked'));
      expect(permissionRequestOf(asked.data)).toEqual(perm);

      // 待ちの途中でつなぎ直すと、頭は server.connected だけで、それまでの状態は流れない（取り直しの道で埋める）。
      const again = await tapEvents((signal) => client.events(signal));
      try {
        await again.waitFor((e) => e.type === 'server.connected');
        await new Promise((r) => setTimeout(r, 1000));
        expect(again.events.filter((e) => e.type === 'permission.asked')).toEqual([]);
      } finally {
        await again.close();
      }

      const rp = await serveApi(serve!, 'POST', `/api/session/${sid}/permission/${perm.id}/reply`, { decision: 'once' });
      expect(rp.status, JSON.stringify(rp.body)).toBeLessThan(300);
      await tap!.waitFor(of('permission.replied'));

      const forms = await until(() => client.forms(world.repo), (f) => f.some((x) => x.sessionID === sid), '/api/form', 60_000);
      const form = forms.find((x) => x.sessionID === sid)!;
      expect(form.metadata?.kind).toBe('question');
      expect(form.metadata?.tool?.id).toBeTruthy();
      expect(formQuestionOf(form)).toBe(LIVE_QUESTION);
      const created = await tap!.waitFor((e) => e.type === 'form.created');
      expect(formOf((created.data as { form?: unknown }).form)).toEqual(form);

      const fr = await serveApi(serve!, 'POST', `/api/session/${sid}/form/${form.id}/reply`, { answer: { [form.fields[0]!.key]: 'Red' } });
      expect(fr.status, JSON.stringify(fr.body)).toBeLessThan(300);
      await tap!.waitFor((e) => e.type === 'form.replied');
      await tap!.waitFor(of('session.execution.succeeded'), 60_000);
      await until(() => client.active(), (a) => !a.has(sid), '/api/session/active idle');
      expect(await client.permissionRequests(world.repo)).toEqual([]);
      expect(await client.forms(world.repo)).toEqual([]);

      // 本文の写し（transcript/source.ts）が契機にする出来事。
      for (const t of ['session.step.ended', 'session.text.ended', 'session.usage.updated']) await tap!.waitFor(of(t));
      // 差し込んだ追記が、システムプロンプトの `<context key="hangar">` としてモデルまで届く。
      expect(llm.chats.some((b) => systemOf(b).includes(`<context key="hangar">\n${INSTRUCTION}\n</context>`))).toBe(true);
      // Code Mode の execute の中から hangar の MCP の道具を呼べる。
      expect(mcp.calls.map((c) => c.name)).toContain('set_turn_intent');
    }, STEP_MS * 2);

    it('本文：新しい順のページを送れ、共通の形に知らない種類なしで直せる', async () => {
      const all = await client.messages(sid, { limit: 100 });
      expect(all.data.length).toBeGreaterThan(0);
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const p = await client.messages(sid, { limit: 2, cursor });
        ids.push(...p.data.map((m) => (m as { id: string }).id));
        cursor = p.next;
        if (!cursor) break;
      }
      expect(ids).toEqual(all.data.map((m) => (m as { id: string }).id));

      const events = convertMessages([...all.data].reverse()).flatMap((r) => r.events);
      expect(events.filter((e) => e.kind === 'meta')).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'user', text: PROMPT_TURN }));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'All done.' }));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'thinking' }));
      expect(events).toContainEqual(expect.objectContaining({ kind: 'system', subtype: 'idle' }));
      const calls = events.flatMap((e) => (e.kind === 'tool_call' ? [e.name] : []));
      for (const name of ['Bash', 'mcp__hangar__set_turn_intent', 'Write', 'Edit', 'Read', 'AskUserQuestion']) expect(calls, name).toContain(name);
      // 道具の引数の名前が変わると、opencode が道具の呼び出しを断る。
      expect(events.filter((e) => e.kind === 'tool_result' && e.isError)).toEqual([]);
      expect(fs.readFileSync(path.join(world.repo, 'notes.txt'), 'utf8')).toBe('alpha\ngamma\n');
    }, STEP_MS);

    it('interrupt：許可の待ちの途中で止めると interrupted で終わり、待ちが消える', async () => {
      const other = await client.createSession({ directory: world.repo });
      const pr = await serveApi(serve!, 'POST', `/api/session/${other}/prompt`, { text: PROMPT_TURN });
      expect(pr.status).toBeLessThan(300);
      await until(() => client.permissionRequests(world.repo), (p) => p.some((x) => x.sessionID === other), '/api/permission/request', 60_000);
      const stop = await serveApi(serve!, 'POST', `/api/session/${other}/interrupt`, {});
      expect(stop.status, JSON.stringify(stop.body)).toBeLessThan(300);
      await tap!.waitFor((e) => e.sessionID === other && e.type === 'session.execution.interrupted', 60_000);
      await until(() => client.active(), (a) => !a.has(other), '/api/session/active idle');
      expect((await client.permissionRequests(world.repo)).filter((p) => p.sessionID === other)).toEqual([]);
      const d = await runCli(bin, ['session', 'delete', '--server', serve!.url, other], liveEnv(bin, world), { password: serve!.password, timeoutMs: CLI_TIMEOUT_MS });
      expect(d.code, d.stderr).toBe(0);
    }, STEP_MS);

    it('session export と import（同期の単位）で ID と場所と本文が保たれる', async () => {
      const env = liveEnv(bin, world);
      const o = { password: serve!.password, timeoutMs: CLI_TIMEOUT_MS };
      const ex = await runCli(bin, ['session', 'export', '--server', serve!.url, sid], env, o);
      expect(ex.code, ex.stderr).toBe(0);
      const exported = JSON.parse(ex.stdout) as { info?: { id?: unknown }; messages?: unknown[] };
      expect(exported.info?.id).toBe(sid);
      expect(Array.isArray(exported.messages)).toBe(true);
      const before = (await client.messages(sid, { limit: 100 })).data.length;
      const file = path.join(world.root, 'export.json');
      fs.writeFileSync(file, ex.stdout);

      // 同じ ID へ import しても入れ替わらない（Session already exists）。消してから入れる（sync の再開と同じ順）。
      const del = await runCli(bin, ['session', 'delete', '--server', serve!.url, sid], env, o);
      expect(del.code, del.stderr).toBe(0);
      expect((await serveApi(serve!, 'GET', `/api/session/${sid}`)).status).toBe(404);
      const im = await runCli(bin, ['session', 'import', '--server', serve!.url, '--directory', world.repo, file], env, o);
      expect(im.code, im.stderr).toBe(0);
      expect(im.stderr).not.toMatch(/already exists/i);
      const info = await serveApi(serve!, 'GET', `/api/session/${sid}`);
      expect(info.status).toBe(200);
      const d = (info.body as { data?: { location?: { directory?: unknown }; directory?: unknown } }).data;
      expect(d?.location?.directory ?? d?.directory).toBe(world.repo);
      expect((await client.messages(sid, { limit: 100 })).data.length).toBe(before);
      const del2 = await runCli(bin, ['session', 'delete', '--server', serve!.url, sid], env, o);
      expect(del2.code, del2.stderr).toBe(0);
    }, STEP_MS);
  });
});
