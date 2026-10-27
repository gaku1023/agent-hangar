import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinSubcommandDrifts, helpDrifts, parseCodexHelp } from '../src/provider/codex/compat/help.ts';
import { shapeOfRollout } from '../src/provider/codex/compat/rolloutShape.ts';
import { diffJson, extractSchemaSubset, type SchemaSubset } from '../src/provider/codex/compat/schemaSubset.ts';
import { appendOnlyDrifts, COMPRESSION_FEATURE, compressionDrifts, parseFeatureList, type FeatureRow } from '../src/provider/codex/compat/storage.ts';
import { codexVersionOf, judgeCodexVersion } from '../src/provider/codex/compat/version.ts';
import { readCodexBatch } from '../src/provider/codex/transcript/batch.ts';
import { newestCodexFixture, readCodexFixture, readCodexFixtureJson } from './codexCompatFixtures.ts';
import {
  codexBin, codexFeaturesText, codexHelpText, codexVersionText, dropWorld, generateSchemaBundle, makeCodexWorld, MOCK_REPLY, probeAppServer, PROMPT_TOOL, rolloutNamesOf,
  runMockExec, runMockResume, startMockLlm, StdioRpc, type CodexWorld, type MockLlm,
} from './codexHarness.ts';

/**
 * 週に 1 度の照合（.github/workflows/codex-compat.yml）だけが HANGAR_LIVE_CODEX=1 を立てる。ふだんの npm test では飛ぶ。
 * 本物の codex を、試しの置き場（HOME と CODEX_HOME を一時ディレクトリへ）と空の環境で動かし、hangar が頼る形が残っているかを見る（docs/design.md「Codex の互換の見張り」）。
 * - 版：確かめた範囲（CODEX_VERIFIED_RANGE）の中か。CI が入れる版は同じ範囲から決まるので、外れたら入れ方がずれている。
 * - --help：サブコマンドと別名が、最も新しい見本と同じか、横取りの一覧（D1 の compat/cli.ts があれば）と同じか。
 * - app-server：JSON Schema のうち hangar が使う要求と通知の形が、見本と同じか。ログイン無しで話した答えのキーと、ターンの前は rollout が無いことも。
 * - rollout：模擬のモデルで codex exec を走らせてできた記録の形が見本と同じか。hangar の読み手（transcript/）で読めるか。
 * - rollout の置かれ方：resume しても前の行が書き換わらず追記だけで伸びるか（本文の同期が頼る）。rollout を zst に切り替える local_thread_store_compression の既定が見本と同じか、7 日より古い会話が実際に zst にならないか。
 * モデルは使わず、ログインもしない（Responses API の模擬を手元に立てる）。
 * どれかが落ちたら、見本を採り直す合図である（npm run capture-codex-fixtures）。差分は落ちたときの文に出る。
 */
const LIVE = process.env.HANGAR_LIVE_CODEX === '1';
const STEP_MS = 180_000;

describe.skipIf(!LIVE)('いまの codex と最も新しい見本', () => {
  const f = newestCodexFixture();
  let bin: string;
  let world: CodexWorld;
  let llm: MockLlm;

  beforeAll(async () => {
    bin = codexBin()!;
    expect(bin, 'codex が見つかりません').toBeTruthy();
    expect(f, '見本がありません。npm run capture-codex-fixtures で採ってください').not.toBeNull();
    world = makeCodexWorld(bin);
    llm = await startMockLlm();
  });
  afterAll(async () => {
    await llm?.close();
    if (world) dropWorld(world);
  });

  it('版が確かめた範囲の中', () => {
    const version = codexVersionOf(codexVersionText(bin, world.env));
    console.log(`codex ${version ?? '(版を読めない)'}、最も新しい見本 ${f!.version}`);
    expect(judgeCodexVersion(version)).toBe('verified');
  });

  it('サブコマンドと別名が、見本の --help と同じ（横取りの一覧とも）', async () => {
    const now = parseCodexHelp(codexHelpText(bin, world.env));
    const want = parseCodexHelp(readCodexFixture(f!, 'help.txt'));
    expect(now).not.toBeNull();
    expect(want).not.toBeNull();
    expect(helpDrifts(now!, want!)).toEqual([]);
    const cli = new URL('../src/provider/codex/compat/cli.ts', import.meta.url);
    if (fs.existsSync(cli)) {
      const mod = (await import(cli.href)) as { BUILTIN_CODEX_SUBCOMMANDS: readonly string[] };
      expect(builtinSubcommandDrifts(now!, mod.BUILTIN_CODEX_SUBCOMMANDS)).toEqual([]);
    }
  });

  it('app-server の JSON Schema のうち、hangar が使う分が見本と同じ', () => {
    const now = extractSchemaSubset(generateSchemaBundle(bin, world));
    const want = readCodexFixtureJson<SchemaSubset>(f!, 'app-server-schema.json');
    expect(diffJson(want.methods, now.methods)).toEqual([]);
    expect(diffJson(want.definitions, now.definitions)).toEqual([]);
  }, STEP_MS);

  it('ログイン無しの app-server の答えのキーと、ターンの前は rollout が無いことが見本と同じ', async () => {
    const now = await probeAppServer(bin, world);
    expect(diffJson(readCodexFixtureJson(f!, 'app-server-probe.json'), now)).toEqual([]);
  }, STEP_MS);

  it('rollout の形が見本と同じで、hangar の読み手で読める', async () => {
    const turn = await runMockExec(bin, world, llm.port, 'say hi');
    const tool = await runMockExec(bin, makeCodexWorld(bin), llm.port, PROMPT_TOOL);
    const now = shapeOfRollout([...turn.lines, ...tool.lines]);
    expect(diffJson(readCodexFixtureJson(f!, 'rollout-shape.json'), now)).toEqual([]);
    // 読み手（B5）が、行を捨てずに読めて、利用者の発言と codex の返事が出てくること。
    for (const run of [turn, tool]) {
      const batch = readCodexBatch({ path: run.path, sessionId: 'live', agentId: null, deviceId: null }, 0);
      expect(batch.badLines).toBe(0);
      const events = batch.records.flatMap((r) => r.events);
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).toContain(MOCK_REPLY);
    }
  }, STEP_MS);

  it('resume しても rollout は追記だけで伸びる（前の行が書き換わらない）', async () => {
    const w = makeCodexWorld(bin);
    try {
      const first = await runMockExec(bin, w, llm.port, 'say hi');
      const before = fs.readFileSync(first.path);
      await runMockResume(bin, w, llm.port, first.path, 'say hi again');
      const after = fs.readFileSync(first.path);
      expect(appendOnlyDrifts(before, after)).toEqual([]);
      expect(rolloutNamesOf(w.codexHome)).toHaveLength(1);
    } finally {
      dropWorld(w);
    }
  }, STEP_MS);

  it('rollout を zst にする local_thread_store_compression の既定が見本と同じ', () => {
    const want = readCodexFixtureJson<Record<string, FeatureRow>>(f!, 'features.json')[COMPRESSION_FEATURE]!;
    expect(compressionDrifts(want, parseFeatureList(codexFeaturesText(bin, world))[COMPRESSION_FEATURE])).toEqual([]);
  });

  it('7 日より古い会話も、既定のままでは zst に切り替わらない', async () => {
    const w = makeCodexWorld(bin);
    let rpc: StdioRpc | null = null;
    try {
      const run = await runMockExec(bin, w, llm.port, 'say hi');
      const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
      fs.utimesSync(run.path, old, old);
      const before = rolloutNamesOf(w.codexHome);
      rpc = new StdioRpc(bin, w);
      await rpc.request('initialize', { clientInfo: { name: 'hangar-compat', version: '0' } });
      rpc.notify('initialized');
      // 圧縮は起動後の背景の仕事なので、少し待ってから見る。
      await new Promise((r) => { setTimeout(r, 5000); });
      expect(rolloutNamesOf(w.codexHome)).toEqual(before);
    } finally {
      await rpc?.stop();
      dropWorld(w);
    }
  }, STEP_MS);
});
