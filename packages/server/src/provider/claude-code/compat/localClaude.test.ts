import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFakeTool } from '../../../../test/fake-bin.ts';
import { posixIt } from '../../../../test/platform.ts';
import { BUILTIN_SUBCOMMANDS } from './cli.ts';
import { CompatLog } from './log.ts';
import { claudeBinOf, LocalClaude } from './localClaude.ts';
import { VERIFIED_CLAUDE_VERSION } from './version.ts';

/**
 * 手元の claude を裏で読む係。
 * 包みの本体や準備の確かめまで結んだ確かめは boot/runs.test.ts にある。ここは係だけを見る。
 */
describe('手元の claude の読み取り', () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-claude-'));
    prev = process.env.HANGAR_CLAUDE_BIN;
    delete process.env.HANGAR_CLAUDE_BIN;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const setup = (o: { bin: string | null; closed?: () => boolean }) => {
    const version = { current: null as string | null };
    const log = new CompatLog({ file: path.join(dir, 'compat.json'), localVersion: () => version.current });
    const calls: string[] = [];
    let bin = o.bin;
    const local = new LocalClaude({
      bin: () => bin, closed: o.closed ?? (() => false), version, log,
      renote: () => { calls.push('renote'); },
      onSubcommands: (list) => { calls.push(`subcommands ${list.join(',')}`); },
      beforeList: () => { calls.push('beforeList'); },
      errorLog: () => {},
    });
    return { local, version, log, calls, setBin: (b: string | null) => { bin = b; } };
  };

  it('claude の場所は、環境変数、設定の順に引く', () => {
    expect(claudeBinOf({ claudePath: '/from/settings' })).toBe('/from/settings');
    process.env.HANGAR_CLAUDE_BIN = '/from/env';
    expect(claudeBinOf({ claudePath: '/from/settings' })).toBe('/from/env');
  });

  it('claude が無ければ、版は null で、サブコマンドは組み込みの一覧のままにする', async () => {
    const t = setup({ bin: path.join(dir, 'no-claude') });
    expect(await t.local.refreshVersion()).toBeNull();
    expect(t.version.current).toBeNull();
    await t.local.refreshSubcommands();
    expect(t.local.subcommands).toEqual(BUILTIN_SUBCOMMANDS);
    const dto = await t.local.compat();
    expect(dto.verifiedVersion).toBe(VERIFIED_CLAUDE_VERSION);
    expect(dto.localVersion).toBeNull();
    expect(t.calls).toContain('beforeList');
  });

  it('claude のパスが普通のファイルの下を指しても（ENOTDIR）、拒否せずに null を返す', async () => {
    // 裏で void で走らせるので、ここで投げると捕まらない拒否で Node ごと落ちる。
    const plain = path.join(dir, 'plain');
    fs.writeFileSync(plain, 'not a directory\n');
    const t = setup({ bin: path.join(plain, 'claude') });
    await expect(t.local.refreshVersion()).resolves.toBeNull();
    await expect(t.local.refreshSubcommands()).resolves.toBeUndefined();
  });

  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('読めた版を置き場に書き、版が変わって記録が空になったら、1 度しか数えない元から数え直させる', async () => {
    fs.writeFileSync(path.join(dir, 'compat.json'), JSON.stringify({
      version: 1, localVersion: '1.0.0',
      entries: [{ contract: 'transcript', value: 'type=old', version: '1.0.0', count: 3, firstSeenAt: 1, lastSeenAt: 1 }],
    }));
    const bin = writeFakeTool(path.join(dir, 'bin'), 'claude', {
      sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Commands:\\n  agents  Manage\\n  newcmd  New\\n" ;; esac',
      cmd: '',
    });
    const t = setup({ bin });
    await t.local.refreshSubcommands();
    expect(t.calls).toEqual(['subcommands agents,newcmd']);
    expect(t.log.list().map((d) => d.value)).toContain('subcommand.added=newcmd');
    expect(await t.local.refreshVersion()).toBe('9.9.9');
    expect(t.version.current).toBe('9.9.9');
    expect(t.calls).toContain('renote');
    const values = t.log.list().map((d) => d.value);
    // 前の版の記録は空にする。先に読み終えた claude --help のずれは、数え直して残す。
    expect(values).not.toContain('type=old');
    expect(values).toContain('subcommand.added=newcmd');
    // 同じ版をもう一度読んでも、数え直さない。
    t.calls.length = 0;
    await t.local.refreshVersion();
    expect(t.calls).toEqual([]);
  });

  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('閉じた後に届いた読み取りは、置き場にも包みにも書かない', async () => {
    const bin = writeFakeTool(path.join(dir, 'bin'), 'claude', {
      sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Commands:\\n  newcmd  New\\n" ;; esac',
      cmd: '',
    });
    const t = setup({ bin, closed: () => true });
    // 呼び手には読めた版を返す。置き場と記録には触らない。
    expect(await t.local.refreshVersion()).toBe('9.9.9');
    expect(t.version.current).toBeNull();
    await t.local.refreshSubcommands();
    expect(t.calls).toEqual([]);
    expect(t.local.subcommands).toEqual(BUILTIN_SUBCOMMANDS);
  });

  // 偽の claude は sh の case と sleep を使うので、Windows では飛ばす。
  posixIt('待つ間に claude のパスが変わったら、遅れて届いた前のパスの結果で上書きしない', async () => {
    const slow = writeFakeTool(path.join(dir, 'slow'), 'claude', {
      sh: 'case "$1" in --version) sleep 1; echo "1.0.0 (Claude Code)" ;; --help) sleep 1; printf "Commands:\\n  oldcmd  Old\\n" ;; esac',
      cmd: '',
    });
    const fast = writeFakeTool(path.join(dir, 'fast'), 'claude', {
      sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Commands:\\n  newcmd  New\\n" ;; esac',
      cmd: '',
    });
    const t = setup({ bin: slow });
    const oldVersion = t.local.refreshVersion();
    const oldHelp = t.local.refreshSubcommands();
    t.setBin(fast);
    await t.local.refreshSubcommands();
    await t.local.refreshVersion();
    await Promise.all([oldVersion, oldHelp]);
    expect(t.version.current).toBe('9.9.9');
    expect(t.local.subcommands).toContain('newcmd');
    expect(t.local.subcommands).not.toContain('oldcmd');
    expect(t.calls.filter((c) => c.startsWith('subcommands'))).toEqual(['subcommands newcmd']);
  }, 15_000);
});
