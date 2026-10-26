import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinSubcommandDrifts, parseCodexHelp } from '../src/provider/codex/compat/help.ts';
import { shapeOfRollout } from '../src/provider/codex/compat/rolloutShape.ts';
import { diffJson, extractSchemaSubset, type SchemaSubset } from '../src/provider/codex/compat/schemaSubset.ts';
import { codexVersionOf, judgeCodexVersion } from '../src/provider/codex/compat/version.ts';
import { readCodexBatch } from '../src/provider/codex/transcript/batch.ts';
import { newestCodexFixture, readCodexFixture, readCodexFixtureJson } from './codexCompatFixtures.ts';
import {
  codexBin, codexHelpText, codexVersionText, dropWorld, generateSchemaBundle, makeCodexWorld, MOCK_REPLY, probeAppServer, PROMPT_TOOL, runMockExec,
  startMockLlm, type CodexWorld, type MockLlm,
} from './codexHarness.ts';

/**
 * 週に 1 度の照合（.github/workflows/codex-compat.yml）だけが HANGAR_LIVE_CODEX=1 を立てる。ふだんの npm test では飛ぶ。
 * 本物の codex を、試しの置き場（HOME と CODEX_HOME を一時ディレクトリへ）と空の環境で動かし、hangar が頼る形が残っているかを見る（docs/design.md「Codex の互換の見張り」）。
 * - 版：確かめた範囲（CODEX_VERIFIED_RANGE）の中か。CI が入れる版は同じ範囲から決まるので、外れたら入れ方がずれている。
 * - --help：サブコマンドと別名が、最も新しい見本と同じか、横取りの一覧（D1 の compat/cli.ts があれば）と同じか。
 * - app-server：JSON Schema のうち hangar が使う要求と通知の形が、見本と同じか。ログイン無しで話した答えのキーと、ターンの前は rollout が無いことも。
 * - rollout：模擬のモデルで codex exec を走らせてできた記録の形が見本と同じか。hangar の読み手（transcript/）で読めるか。
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
    expect(now).toEqual(want);
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
});
