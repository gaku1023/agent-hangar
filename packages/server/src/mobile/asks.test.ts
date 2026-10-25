import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { aadAsk, aadReply, MOBILE_AGENT_LABEL_MAX, MOBILE_AGENT_MODELS_MAX, MOBILE_REPLY_MAX_BYTES, open, seal, type MobileAsk, type MobileReply, type OpencodeOptionsDto } from '@agent-hangar/shared';
import { testKey } from '../../test/cloudConfig.ts';
import { fixedPhoneKeys, PHONE_KEY_1, PHONE_KEY_2, phoneCryptoKey } from '../../test/phoneKeys.ts';
import { answerAsk, ASK_COMMANDS_MAX, ASK_DESCRIPTION_MAX, ASK_RECENT_FILES, ASK_SEARCH_FILES, replyTo, type AskDeps } from './asks.ts';

const mKey = (): Promise<CryptoKey> => phoneCryptoKey(PHONE_KEY_1);
const ROOT = path.join(os.tmpdir(), 'hangar-asks-root');

function deps(o: Partial<AskDeps> = {}): AskDeps {
  return {
    phoneKeys: fixedPhoneKeys({ 1: PHONE_KEY_1, 2: PHONE_KEY_2 }),
    deviceId: 'pc-a',
    projectPath: (id) => (id === 'p1' ? ROOT : null),
    accountDir: (id) => (id === 'primary' ? '/claude-dir' : null),
    files: {
      recent: vi.fn(async () => [{ path: 'b.ts', changed: true }, { path: 'a.ts', changed: false }]),
      search: vi.fn(async () => ['src/a.ts', 'src/b.ts']),
      changed: vi.fn(async () => new Set(['src/b.ts'])),
    },
    commands: vi.fn(() => [
      { name: 'goal', description: '長く走る', kind: 'skill' as const, uses: 0 },
      { name: 'init', description: '始める', kind: 'command' as const, uses: 0 },
    ]),
    ...o,
  };
}

const ask = (a: MobileAsk) => replyTo(deps(), a);

describe('replyTo（files）', () => {
  it('q が空なら、最近のファイルを変更ありの印つきで 30 件まで返す', async () => {
    const d = deps();
    expect(await replyTo(d, { v: 1, kind: 'files', projectId: 'p1', q: '' })).toEqual({ files: [{ path: 'b.ts', changed: true }, { path: 'a.ts', changed: false }] });
    expect(d.files!.recent).toHaveBeenCalledWith(ROOT, ASK_RECENT_FILES);
    expect(d.files!.search).not.toHaveBeenCalled();
  });

  it('q があれば PC の指示欄と同じ検索で 50 件まで返し、git の変更ありに印を付ける', async () => {
    const d = deps();
    expect(await replyTo(d, { v: 1, kind: 'files', projectId: 'p1', q: 'src' })).toEqual({ files: [{ path: 'src/a.ts', changed: false }, { path: 'src/b.ts', changed: true }] });
    expect(d.files!.search).toHaveBeenCalledWith(ROOT, 'src', ASK_SEARCH_FILES);
    expect(ASK_RECENT_FILES).toBe(30);
    expect(ASK_SEARCH_FILES).toBe(50);
  });

  it('空白だけの q は空として扱う', async () => {
    const d = deps();
    await replyTo(d, { v: 1, kind: 'files', projectId: 'p1', q: '   ' });
    expect(d.files!.recent).toHaveBeenCalled();
  });

  it('プロジェクトの外に出るパスは返さない', async () => {
    const bad = ['../up.ts', '/etc/passwd', 'a/../../b.ts', 'C:/x.ts', 'a\\..\\..\\b.ts', '', './a.ts', 'ok/fine.ts'];
    const d = deps({
      files: {
        recent: async () => bad.map((p) => ({ path: p, changed: false })),
        search: async () => bad,
        changed: async () => new Set<string>(),
      },
    });
    expect(await replyTo(d, { v: 1, kind: 'files', projectId: 'p1', q: '' })).toEqual({ files: [{ path: 'ok/fine.ts', changed: false }] });
    expect(await replyTo(d, { v: 1, kind: 'files', projectId: 'p1', q: 'x' })).toEqual({ files: [{ path: 'ok/fine.ts', changed: false }] });
  });

  it('手元に無いプロジェクトは project-missing', async () => {
    expect(await ask({ v: 1, kind: 'files', projectId: 'p-none', q: '' })).toEqual({ error: 'project-missing' });
  });
});

describe('replyTo（commands）', () => {
  it('アカウントの設定フォルダとプロジェクトのフォルダで候補を読み、名前、説明、種類を返す', async () => {
    const d = deps();
    expect(await replyTo(d, { v: 1, kind: 'commands', projectId: 'p1', accountId: 'primary' })).toEqual({
      commands: [{ name: 'goal', description: '長く走る', kind: 'skill' }, { name: 'init', description: '始める', kind: 'command' }],
    });
    expect(d.commands).toHaveBeenCalledWith({ claudeDir: '/claude-dir', projectPath: ROOT });
  });

  it('projectId が null ならプロジェクトのものは読まない', async () => {
    const d = deps();
    await replyTo(d, { v: 1, kind: 'commands', projectId: null, accountId: 'primary' });
    expect(d.commands).toHaveBeenCalledWith({ claudeDir: '/claude-dir', projectPath: null });
  });

  it('200 件で切り、説明は 120 字で切る。よく使うものを先に残す', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `c${i}`, description: 'あ'.repeat(300), kind: 'command' as const, uses: i === 249 ? 5 : 0 }));
    const d = deps({ commands: () => many });
    const r = (await replyTo(d, { v: 1, kind: 'commands', projectId: null, accountId: 'primary' })) as Extract<MobileReply, { commands: unknown }>;
    expect(r.commands).toHaveLength(ASK_COMMANDS_MAX);
    expect(ASK_COMMANDS_MAX).toBe(200);
    expect(r.commands[0]!.name).toBe('c249');
    expect(r.commands[1]!.name).toBe('c0');
    expect([...r.commands[0]!.description]).toHaveLength(ASK_DESCRIPTION_MAX);
    expect(ASK_DESCRIPTION_MAX).toBe(120);
  });

  it('手元に無いアカウントは account-missing、手元に無いプロジェクトは project-missing', async () => {
    expect(await ask({ v: 1, kind: 'commands', projectId: null, accountId: 'nobody' })).toEqual({ error: 'account-missing' });
    expect(await ask({ v: 1, kind: 'commands', projectId: 'p-none', accountId: 'primary' })).toEqual({ error: 'project-missing' });
  });
});

/** PC が手元に持った opencode の選択肢（C2 の OpencodeOptionsDto）。 */
const ocDto = (over: Partial<OpencodeOptionsDto> = {}): OpencodeOptionsDto => ({
  version: '2.1.4',
  verified: true,
  modes: [{ id: 'build', description: 'The default agent.' }, { id: 'plan', description: null }],
  models: [
    { id: 'opencode/glm-5.3-flash-free', label: 'GLM-5.3-Flash Free', group: 'OpenCode Zen', provider: 'opencode', tools: true, context: 200_000, cost: { input: 0, output: 0 } },
    { id: 'opencode/big-pickle', label: 'Big Pickle', group: 'OpenCode Zen', provider: 'opencode', tools: true, context: null, cost: { input: 0, output: 0 } },
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', group: 'DeepSeek', provider: 'deepseek', tools: true, context: null, cost: { input: 0.15, output: 0.6 } },
    { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B', group: 'LM Studio', provider: 'lmstudio', tools: true, context: null, cost: null },
    { id: 'lmstudio/embed', label: 'Embed', group: 'LM Studio', provider: 'lmstudio', tools: false, context: null, cost: null },
  ],
  providers: [{ id: 'opencode', name: 'OpenCode Zen', where: 'remote' }, { id: 'deepseek', name: 'DeepSeek', where: 'remote' }, { id: 'lmstudio', name: 'LM Studio', where: 'device' }],
  defaultModel: 'lmstudio/qwen/qwen3-coder-30b',
  pricesAt: null,
  fetchedAt: 1_000,
  stale: false,
  ...over,
});

const ocCommands = [
  { name: 'init', description: 'create/update AGENTS.md', kind: 'command' as const },
  { name: 'frontend-design', description: 'Distinctive visual design.', kind: 'skill' as const },
];

function ocDeps(o: { ready?: boolean; dto?: OpencodeOptionsDto | null; commands?: typeof ocCommands | null } = {}) {
  const options = vi.fn((_dir: string | null) => (o.dto === undefined ? ocDto() : o.dto));
  const commands = vi.fn((_dir: string | null) => (o.commands === undefined ? ocCommands : o.commands));
  return deps({ opencode: { ready: () => o.ready ?? true, options, commands } });
}

describe('replyTo（agent-options）', () => {
  it('手元に持った opencode の選択肢を、スマホの形に縮めて返す。費用の型とデータの扱いを付け、ツール非対応のモデルは載せない', async () => {
    const d = ocDeps();
    expect(await replyTo(d, { v: 1, kind: 'agent-options', agent: 'opencode', projectId: 'p1' })).toEqual({
      agentOptions: {
        version: '2.1.4',
        verified: true,
        modes: [{ id: 'build', description: 'The default agent.' }, { id: 'plan', description: null }],
        models: [
          { id: 'opencode/glm-5.3-flash-free', label: 'GLM-5.3-Flash Free', group: 'OpenCode Zen', cost: 'free', data: 'no-training' },
          { id: 'opencode/big-pickle', label: 'Big Pickle', group: 'OpenCode Zen', cost: 'free', data: 'may-train' },
          { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', group: 'DeepSeek', cost: 'metered', data: 'no-training' },
          { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B', group: 'LM Studio', cost: 'local', data: 'on-device' },
        ],
        defaultModel: 'lmstudio/qwen/qwen3-coder-30b',
        stale: false,
        fetchedAt: 1_000,
      },
    });
    // 一覧はプロジェクトの場所のものを読む（opencode.json の重なりが場所で変わる）。
    expect(d.opencode!.options).toHaveBeenCalledWith(ROOT);
  });

  it('PC の一覧が古ければ stale を立てたまま返す', async () => {
    const r = await replyTo(ocDeps({ dto: ocDto({ stale: true }) }), { v: 1, kind: 'agent-options', agent: 'opencode', projectId: null });
    expect(r).toMatchObject({ agentOptions: { stale: true } });
  });

  it('プロジェクトが無い（すぐ始める）なら場所を省いて読む', async () => {
    const d = ocDeps();
    await replyTo(d, { v: 1, kind: 'agent-options', agent: 'opencode', projectId: null });
    expect(d.opencode!.options).toHaveBeenCalledWith(null);
  });

  it('PC がまだ一覧を持っていなければ agentOptions は null', async () => {
    expect(await replyTo(ocDeps({ dto: null }), { v: 1, kind: 'agent-options', agent: 'opencode', projectId: 'p1' })).toEqual({ agentOptions: null });
  });

  it('opencode を使えない PC（無効、見つからない、口が無い）は agent-missing。手元に無いプロジェクトは project-missing', async () => {
    expect(await replyTo(ocDeps({ ready: false }), { v: 1, kind: 'agent-options', agent: 'opencode', projectId: 'p1' })).toEqual({ error: 'agent-missing' });
    expect(await replyTo(deps(), { v: 1, kind: 'agent-options', agent: 'opencode', projectId: 'p1' })).toEqual({ error: 'agent-missing' });
    expect(await replyTo(ocDeps(), { v: 1, kind: 'agent-options', agent: 'opencode', projectId: 'p-none' })).toEqual({ error: 'project-missing' });
  });

  it('送れない形のモードとモデル（引数に読まれる、空白入り）は落とす。既定のモデルも同じ', async () => {
    const dto = ocDto({
      modes: [{ id: 'build', description: null }, { id: '--x', description: null }, { id: 'my mode', description: null }],
      models: [{ id: 'cf/@cf/llama', label: 'L', group: 'CF', provider: 'cf', tools: true, context: null, cost: null }, ...ocDto().models.slice(0, 1)],
      defaultModel: 'cf/@cf/llama',
    });
    const r = (await replyTo(ocDeps({ dto }), { v: 1, kind: 'agent-options', agent: 'opencode', projectId: null })) as { agentOptions: { modes: { id: string }[]; models: { id: string }[]; defaultModel: string | null } };
    expect(r.agentOptions.modes.map((m) => m.id)).toEqual(['build']);
    expect(r.agentOptions.models.map((m) => m.id)).toEqual(['opencode/glm-5.3-flash-free']);
    expect(r.agentOptions.defaultModel).toBeNull();
  });

  it('モデルは 100 件で、名前は 60 字で切る', async () => {
    const models = Array.from({ length: 130 }, (_, i) => ({ id: `opencode/m${i}`, label: 'あ'.repeat(90), group: 'OpenCode Zen', provider: 'opencode', tools: true, context: null, cost: null }));
    const r = (await replyTo(ocDeps({ dto: ocDto({ models }) }), { v: 1, kind: 'agent-options', agent: 'opencode', projectId: null })) as { agentOptions: { models: { label: string }[] } };
    expect(r.agentOptions.models).toHaveLength(MOBILE_AGENT_MODELS_MAX);
    expect([...r.agentOptions.models[0]!.label]).toHaveLength(MOBILE_AGENT_LABEL_MAX);
  });
});

describe('replyTo（opencode の / の候補）', () => {
  it('agent が opencode なら、アカウントを見ずに opencode のコマンドとスキルを返す', async () => {
    const d = ocDeps();
    expect(await replyTo(d, { v: 1, kind: 'commands', projectId: 'p1', accountId: '', agent: 'opencode' })).toEqual({ commands: ocCommands });
    expect(d.opencode!.commands).toHaveBeenCalledWith(ROOT);
    expect(d.commands).not.toHaveBeenCalled();
  });

  it('PC がまだ候補を持っていなければ空。opencode を使えなければ agent-missing', async () => {
    expect(await replyTo(ocDeps({ commands: null }), { v: 1, kind: 'commands', projectId: null, accountId: '', agent: 'opencode' })).toEqual({ commands: [] });
    expect(await replyTo(ocDeps({ ready: false }), { v: 1, kind: 'commands', projectId: null, accountId: '', agent: 'opencode' })).toEqual({ error: 'agent-missing' });
  });

  it('知らない agent の問い合わせは bad-request', async () => {
    expect(await replyTo(ocDeps(), { v: 1, kind: 'commands', projectId: null, accountId: '', agent: 'codex' })).toEqual({ error: 'bad-request' });
    expect(await replyTo(ocDeps(), { v: 1, kind: 'agent-options', agent: 'codex', projectId: null })).toEqual({ error: 'bad-request' });
  });
});

describe('replyTo（形の検査）', () => {
  it('形の違う問い合わせは bad-request', async () => {
    for (const bad of [null, 'x', {}, { v: 2, kind: 'files', projectId: 'p1', q: '' }, { v: 1, kind: 'files', projectId: 1, q: '' }, { v: 1, kind: 'files', projectId: 'p1' }, { v: 1, kind: 'commands', projectId: 'p1' }, { v: 1, kind: 'other' }]) {
      expect(await replyTo(deps(), bad)).toEqual({ error: 'bad-request' });
    }
  });

  it('読み取りが投げても bad-request にせず、空の答えを返して落ちない', async () => {
    const d = deps({ files: { recent: async () => { throw new Error('boom'); }, search: async () => [], changed: async () => new Set() } });
    expect(await replyTo(d, { v: 1, kind: 'files', projectId: 'p1', q: '' })).toEqual({ files: [] });
  });
});

describe('answerAsk', () => {
  it('ask の封を自分宛ての AAD で開き、答えを reply の AAD で封じて返す', async () => {
    const key = await mKey();
    const sealed = await seal(key, aadAsk('q1', 'pc-a'), { v: 1, kind: 'files', projectId: 'p1', q: '' } satisfies MobileAsk);
    const out = await answerAsk(deps(), 'q1', sealed, 1);
    expect(out).not.toBeNull();
    expect(await open(key, aadReply('q1'), out!)).toEqual({ files: [{ path: 'b.ts', changed: true }, { path: 'a.ts', changed: false }] });
  });

  it('問い合わせの世代（呼び鈴の epoch）の M で開き、答えも同じ世代で封じる', async () => {
    const key2 = await phoneCryptoKey(PHONE_KEY_2);
    const sealed = await seal(key2, aadAsk('q1', 'pc-a'), { v: 1, kind: 'files', projectId: 'p1', q: '' } satisfies MobileAsk);
    expect(await answerAsk(deps(), 'q1', sealed, 1)).toBeNull();
    const out = await answerAsk(deps(), 'q1', sealed, 2);
    expect(await open(key2, aadReply('q1'), out!)).toMatchObject({ files: expect.any(Array) });
    await expect(open(await mKey(), aadReply('q1'), out!)).rejects.toThrow();
    // 鍵の無い世代には答えない。
    expect(await answerAsk(deps(), 'q1', sealed, 3)).toBeNull();
  });

  it('開けないものには答えない（別の宛先、別の ID、別の鍵、壊れた封）', async () => {
    const key = await mKey();
    const body: MobileAsk = { v: 1, kind: 'files', projectId: 'p1', q: '' };
    expect(await answerAsk(deps(), 'q1', await seal(key, aadAsk('q1', 'pc-b'), body), 1)).toBeNull();
    expect(await answerAsk(deps(), 'q2', await seal(key, aadAsk('q1', 'pc-a'), body), 1)).toBeNull();
    expect(await answerAsk(deps(), 'q1', await seal(await phoneCryptoKey(testKey(11)), aadAsk('q1', 'pc-a'), body), 1)).toBeNull();
    expect(await answerAsk(deps(), 'q1', 'not-a-seal', 1)).toBeNull();
  });

  it('答えは 64 KiB（呼び鈴の 1 通）に収まるまで後ろから落とす', async () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `${String(i).padStart(2, '0')}/${'あ'.repeat(480)}.ts`, changed: false }));
    const d = deps({ files: { recent: async () => files, search: async () => [], changed: async () => new Set() } });
    const key = await mKey();
    const out = await answerAsk(d, 'q1', await seal(key, aadAsk('q1', 'pc-a'), { v: 1, kind: 'files', projectId: 'p1', q: '' } satisfies MobileAsk), 1);
    const frame = JSON.stringify({ t: 'reply', id: 'q1', sealed: out });
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MOBILE_REPLY_MAX_BYTES);
    const r = await open<Extract<MobileReply, { files: unknown }>>(key, aadReply('q1'), out!);
    expect(r.files.length).toBeGreaterThan(20);
    expect(r.files.length).toBeLessThan(50);
    expect(r.files).toEqual(files.slice(0, r.files.length));
  });
});

describe('既定の読み取り（本物のフォルダ）', () => {
  it('files は実際のフォルダの相対パスを返す', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-asks-'));
    fs.writeFileSync(path.join(root, 'one.ts'), 'x');
    const d: AskDeps = { phoneKeys: fixedPhoneKeys(), deviceId: 'pc-a', projectPath: () => root, accountDir: () => null };
    expect(await replyTo(d, { v: 1, kind: 'files', projectId: 'p1', q: '' })).toEqual({ files: [{ path: 'one.ts', changed: false }] });
    expect(await replyTo(d, { v: 1, kind: 'files', projectId: 'p1', q: 'one' })).toEqual({ files: [{ path: 'one.ts', changed: false }] });
  });
});
