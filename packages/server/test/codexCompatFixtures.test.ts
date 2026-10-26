import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_VERIFIED_RANGE } from '@agent-hangar/shared';
import { builtinSubcommandDrifts, parseCodexHelp } from '../src/provider/codex/compat/help.ts';
import { HANGAR_CODEX_METHODS, type SchemaSubset } from '../src/provider/codex/compat/schemaSubset.ts';
import { judgeCodexVersion } from '../src/provider/codex/compat/version.ts';
import { newestCodexFixture, readCodexFixture, readCodexFixtureJson } from './codexCompatFixtures.ts';

/**
 * 控え（test/fixtures/codex-compat/<版>/）の自己点検。ふだんの npm test で走る（codex は起こさない）。
 * 本物の codex との突き合わせは codexLive.test.ts（週に 1 度の .github/workflows/codex-compat.yml）。
 */
describe('codex の見本', () => {
  const f = newestCodexFixture();
  it('確かめた範囲（CODEX_VERIFIED_RANGE）の版の見本がある', () => {
    expect(f, '見本がありません。npm run capture-codex-fixtures で採ってください').not.toBeNull();
    expect(judgeCodexVersion(f!.version)).toBe('verified');
    expect(readCodexFixture(f!, 'version.txt')).toContain(f!.version);
  });

  it('使う要求と通知を全部含む（HANGAR_CODEX_METHODS に足したら、見本を採り直す）', () => {
    const s = readCodexFixtureJson<SchemaSubset>(f!, 'app-server-schema.json');
    for (const m of HANGAR_CODEX_METHODS) {
      const entry = s.methods[`${m.kind} ${m.method}`];
      expect(entry, `${m.kind} ${m.method}`).toBeDefined();
      if (m.response) expect(s.definitions[m.response], m.response).toBeDefined();
    }
  });

  it('見本に、試しの置き場のパスや利用者のホームが残っていない', () => {
    for (const name of ['app-server-schema.json', 'app-server-probe.json', 'rollout-shape.json', 'help.txt']) {
      const text = readCodexFixture(f!, name);
      expect(text, name).not.toMatch(/\/(Users|home)\/[^/\s"]+\//);
      expect(text, name).not.toMatch(/hangar-codex-/);
    }
  });

  it('控えの --help は、横取りの一覧（D1 の compat/cli.ts があれば）と同じ', async () => {
    const help = parseCodexHelp(readCodexFixture(f!, 'help.txt'));
    expect(help).not.toBeNull();
    expect(help!.commands).toContain('exec');
    const cli = new URL('../src/provider/codex/compat/cli.ts', import.meta.url);
    // 横取り（D1）が入るまで、一覧は無い。入ったら、同じ一覧をここでも見る。
    if (!fs.existsSync(cli)) return;
    const mod = (await import(cli.href)) as { BUILTIN_CODEX_SUBCOMMANDS: readonly string[] };
    expect(builtinSubcommandDrifts(help!, mod.BUILTIN_CODEX_SUBCOMMANDS)).toEqual([]);
  });
});

describe('CI が入れる codex の版（scripts/codex-compat-version.mjs）', () => {
  it('npm の指定は、確かめた範囲の x より前だけ（0.164.x なら 0.164）', () => {
    const out = execFileSync(process.execPath, [path.join(import.meta.dirname, '../../../scripts/codex-compat-version.mjs')], { encoding: 'utf8' }).trim();
    expect(out).toBe(CODEX_VERIFIED_RANGE.split('.').slice(0, CODEX_VERIFIED_RANGE.split('.').indexOf('x')).join('.'));
    expect(judgeCodexVersion(`${out}.0`)).toBe('verified');
  });
});
