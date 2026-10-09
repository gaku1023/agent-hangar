import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
import { writeFakeTool } from '../../test/fake-bin.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { posixIt } from '../../test/platform.ts';
import { errorText } from '../i18n/message.ts';
import { bootDelivery, type DeliveryParts } from './delivery.ts';
import { bootHome, type HomeParts } from './home.ts';
import { bootRuns, panesOf, tmuxOf, type RunsParts } from './runs.ts';

/**
 * セッションを起こして見張る持ち場の組み立て（boot/runs.ts）だけを起こして確かめる。
 * 待ち受けは起こさず、決まったポート番号を渡す。tmux には触らない（start を呼ばない）。
 * 手元の本物の claude を起こさないよう、claude は無いパスか偽のコマンドに向ける。
 */

/** 見本の登録の pid は実在しない。Windows の既定は動いていない pid の登録を読まないので、試験では全部読ませる。 */
const ALL_ALIVE = (): boolean => false;
const PORT = 45_678;

let home: string;
let claudeDir: string;
let prevClaudeBin: string | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = copyFixtureClaudeDir();
  prevClaudeBin = process.env.HANGAR_CLAUDE_BIN;
  process.env.HANGAR_CLAUDE_BIN = path.join(home, 'no-claude');
});

type Booted = { h: HomeParts; d: DeliveryParts; r: RunsParts; close(): void };
const booted: Booted[] = [];
afterEach(() => {
  for (const b of booted.splice(0)) b.close();
  if (prevClaudeBin === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prevClaudeBin;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

function boot(): Booted {
  const h = bootHome({ home, claudeDir });
  const d = bootDelivery(h, { registryIsGone: ALL_ALIVE });
  const r = bootRuns(h, d, { host: '127.0.0.1', port: PORT }, { serverDir: home });
  let closed = false;
  const b: Booted = {
    h, d, r,
    close: () => {
      if (closed) return;
      closed = true;
      // 全体を閉じるときと同じ順である。閉じた印、周期、実行中の一覧、配る層、記録、DB。
      h.life.closed = true;
      r.stopParkTimer();
      r.stopPresence();
      r.runs.stop();
      d.registry.stop();
      d.publisher.stop();
      d.compatLog.stop();
      h.stop();
    },
  };
  booted.push(b);
  return b;
}

/** 条件が満たされるまで一定間隔で試す。 */
async function until<T>(fn: () => T | null | Promise<T | null>, ms = 8000): Promise<T> {
  const limit = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > limit) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const script = () => fs.readFileSync(path.join(home, 'shell', 'claude.zsh'), 'utf8');
const savedCompat = () => JSON.parse(fs.readFileSync(path.join(home, 'compat.json'), 'utf8')) as { localVersion: unknown; entries: { value: string }[] };

describe('言語', () => {
  it('起動の管理は、置き場が作った言語の関数を受け取る', () => {
    // tmux に触らずに見るため、渡した依存をのぞく。
    // 言語が en のとき Claude に渡す指示とシェルタブの名前が英語になることは、tmux の上の試験（runs/manager.test.ts）が見ている。
    const b = boot();
    const given = (b.r.runs as unknown as { deps: { language: unknown } }).deps.language;
    expect(given).toBe(b.h.language);
    b.h.settings.current = { ...b.h.settings.current, language: 'en' };
    expect((given as () => string)()).toBe('en');
  });

  it('言語を en にすると、起動の失敗の中の理由も英語になる', () => {
    const b = boot();
    b.h.settings.current = { ...b.h.settings.current, language: 'en', tmuxPath: null };
    // ターミナルで開く口は、tmux の場所が無ければ断る。文は鍵のまま投げるので、境目が英語で出せる。
    let thrown: unknown = null;
    try { void b.r.external.openTerminal({ tmuxName: 'x' }); } catch (e) { thrown = e; }
    expect(errorText(b.h.language(), thrown)).toBe('tmux was not found. Enter the "tmux path" in Settings');
  });
});

describe('手元の claude と包み', () => {
  it('組んだ時点で、待ち受けているポートを埋めた包みの本体を書く', () => {
    boot();
    expect(script()).toContain(`http://127.0.0.1:${PORT}`);
  });

  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('claude --help のサブコマンドで包みを書き直し、互換の一覧と準備の確かめが版とずれを返す。閉じると compat.json に残る', async () => {
    process.env.HANGAR_CLAUDE_BIN = writeFakeTool(path.join(home, 'bin'), 'claude', {
      sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Usage: claude\\n\\nCommands:\\n  agents [options]  Manage background agents\\n  newcmd            Something new\\n" ;; esac',
      cmd: '',
    });
    const b = boot();
    await until(() => (script().includes('    agents|newcmd) command claude') ? true : null));
    const body = await b.r.compat();
    expect(body.verifiedVersion).toBe(VERIFIED_CLAUDE_VERSION);
    expect(body.localVersion).toBe('9.9.9');
    expect(body.drifts.map((d) => d.value)).toEqual(expect.arrayContaining(['subcommand.added=newcmd', 'subcommand.removed=purge']));
    // 確認リストが読む要約にも、同じずれの件数が載る。
    const ready = await b.r.readiness();
    expect(ready.compat.verifiedVersion).toBe(VERIFIED_CLAUDE_VERSION);
    expect(ready.compat.driftCount).toBeGreaterThanOrEqual(body.drifts.length);
    b.close();
    expect(savedCompat().entries.map((e) => e.value)).toContain('subcommand.added=newcmd');
    // until の上限（8 秒）より長くし、失敗したときに until の言葉で落ちるようにする。
  }, 15_000);

  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('前の記録と手元の claude の版が違えば、読んだ版で記録を空にし、その版を compat.json に残す', async () => {
    fs.writeFileSync(path.join(home, 'compat.json'), JSON.stringify({
      version: 1, localVersion: '1.0.0',
      entries: [{ contract: 'transcript', value: 'type=old', version: '1.0.0', count: 3, firstSeenAt: 1, lastSeenAt: 1 }],
    }));
    process.env.HANGAR_CLAUDE_BIN = writeFakeTool(path.join(home, 'bin'), 'claude', { sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; esac', cmd: '' });
    const b = boot();
    const body = await b.r.compat();
    expect(body.localVersion).toBe('9.9.9');
    expect(body.drifts.map((d) => d.value)).not.toContain('type=old');
    b.close();
    expect(savedCompat().localVersion).toBe('9.9.9');
    expect(savedCompat().entries.map((e) => e.value)).not.toContain('type=old');
  }, 15_000);

  // 偽の claude は sh の case と sleep を使うので、Windows では飛ばす。
  posixIt('版の変化で記録を空にしても、先に読み終えた claude --help のずれは数え直して残す', async () => {
    fs.writeFileSync(path.join(home, 'compat.json'), JSON.stringify({
      version: 1, localVersion: '1.0.0',
      entries: [{ contract: 'transcript', value: 'type=old', version: '1.0.0', count: 3, firstSeenAt: 1, lastSeenAt: 1 }],
    }));
    // --help が先に終わり、そのずれを記録した後で --version が届いて記録を空にする順にする。
    process.env.HANGAR_CLAUDE_BIN = writeFakeTool(path.join(home, 'bin'), 'claude', {
      sh: 'case "$1" in --version) sleep 1; echo "9.9.9 (Claude Code)" ;; --help) printf "Usage: claude\\n\\nCommands:\\n  agents [options]  Manage background agents\\n  newcmd            Something new\\n" ;; esac',
      cmd: '',
    });
    const b = boot();
    await until(() => (script().includes('    agents|newcmd) command claude') ? true : null));
    // 版の読み取り（1 秒）が終わり、記録を空にし終えるのを待つ。
    await until(() => (b.d.claudeVersion.current === '9.9.9' ? true : null));
    const body = await b.r.compat();
    expect(body.localVersion).toBe('9.9.9');
    const values = body.drifts.map((d) => d.value);
    expect(values).not.toContain('type=old');
    expect(values).toContain('subcommand.added=newcmd');
  }, 15_000);

  // 偽の claude は sh の case で引数を見るので、Windows では飛ばす。
  posixIt('設定の claudePath が空でも、準備の確かめの手元の版は互換の一覧と同じ引き方（環境変数）で読む', async () => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ claudePath: null }));
    process.env.HANGAR_CLAUDE_BIN = writeFakeTool(path.join(home, 'bin'), 'claude', { sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; esac', cmd: '' });
    const b = boot();
    // 設定の claudePath は、置き場を用意するときに探して書き戻される。ここでは空のままにして、引き方の違いだけを見る。
    b.h.settings.current = { ...b.h.settings.current, claudePath: null };
    const ready = await b.r.readiness();
    const compat = await b.r.compat();
    // 道具の行は設定の claudePath を見るので空のまま。互換の要約だけがサーバの引き方に従う。
    expect(ready.tools.claude.path).toBeNull();
    expect(compat.localVersion).toBe('9.9.9');
    expect(ready.compat.localVersion).toBe(compat.localVersion);
  }, 15_000);

  it('試験の準備は claude を無いパスに向け、手元の本物の claude を起こさない', async () => {
    const b = boot();
    expect(b.r.claudeBin()).toBe(path.join(home, 'no-claude'));
    expect((await b.r.compat()).localVersion).toBeNull();
  });

  it('claude のパスが普通のファイルの下を指しても（ENOTDIR）、落ちずに、互換の一覧は手元の版を null で返す', async () => {
    const plain = path.join(home, 'plain');
    fs.writeFileSync(plain, 'not a directory\n');
    process.env.HANGAR_CLAUDE_BIN = path.join(plain, 'claude');
    const b = boot();
    // 組んだときの裏の読み取り（--help と --version）が終わるのを待つ。ここで投げると、捕まらない拒否で Node ごと落ちる。
    await new Promise((res) => setTimeout(res, 500));
    expect((await b.r.compat()).localVersion).toBeNull();
    // ほかの口も答える。
    await expect(b.r.readiness()).resolves.toBeDefined();
  }, 15_000);

  // 偽の claude は sh の case と sleep を使うので、Windows では飛ばす。
  posixIt('claude のパスを変えた後に、前のパスの遅い読み取りが届いても、包みと手元の版は新しいパスのまま', async () => {
    const slow = writeFakeTool(path.join(home, 'slow'), 'claude', {
      sh: 'case "$1" in --version) sleep 2; echo "1.0.0 (Claude Code)" ;; --help) sleep 2; printf "Commands:\\n  oldcmd  Old\\n" ;; esac',
      cmd: '',
    });
    const fast = writeFakeTool(path.join(home, 'fast'), 'claude', {
      sh: 'case "$1" in --version) echo "9.9.9 (Claude Code)" ;; --help) printf "Commands:\\n  newcmd  New\\n" ;; esac',
      cmd: '',
    });
    // claudePath を設定で渡す。HANGAR_CLAUDE_BIN があると設定より先に効くので外す。
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ claudePath: slow }));
    delete process.env.HANGAR_CLAUDE_BIN;
    const b = boot();
    expect(b.r.claudeBin()).toBe(slow);
    // 設定の書き替え（config/settingsUpdate.ts の onClaudePath）がやるのと同じ読み直しを頼む。
    b.h.settings.current = { ...b.h.settings.current, claudePath: fast };
    void b.r.localClaude.refreshSubcommands();
    void b.r.localClaude.refreshVersion();
    await until(() => (script().includes('    newcmd) command claude') ? true : null));
    // 前のパスの読み取り（2 秒）が終わるのを待ってから確かめる。
    await new Promise((res) => setTimeout(res, 3_000));
    expect(script()).toContain('    newcmd) command claude');
    expect(script()).not.toContain('oldcmd');
    expect((await b.r.compat()).localVersion).toBe('9.9.9');
  }, 20_000);

  it('閉じた後に届いた裏の読み取りは、消えた置き場に書かない', async () => {
    const b = boot();
    b.close();
    const before = script();
    await b.r.localClaude.refreshSubcommands();
    await b.r.localClaude.refreshVersion();
    expect(script()).toBe(before);
  });
});

describe('run とアカウントと使用量', () => {
  it('hangar の外で実行中のセッションは、実行中の一覧を引いて見分ける', () => {
    // 見本の登録ファイルが alpha を実行中にしている。
    const b = boot();
    expect(b.d.registry.current()).toEqual([]);
    b.d.registry.start();
    b.r.primeLive();
    expect(b.d.registry.current().map((l) => l.sessionId)).toContain(SESSION_ALPHA);
    expect(b.r.runs.listAlive()).toEqual({ runs: [], tabs: [] });
  });

  it('アカウントは最初の 1 つだけがあり、分からない payload の使用量は最初のアカウントに数える', () => {
    const b = boot();
    expect(b.r.accounts.store.list().length).toBe(1);
    expect(b.r.accounts.primaryDir).toBe(claudeDir);
    expect(b.r.usage.current()).toBeDefined();
  });

  it('自端末の生存を刻む。包み方の状態も同じ行に載る', () => {
    const b = boot();
    const row = () => b.h.db.prepare('select name, shell_hook from devices where id = ?').get(b.h.device.id) as { name: string; shell_hook: string } | undefined;
    expect(row()).toBeUndefined();
    b.r.startPresence();
    expect(row()).toEqual({ name: b.h.device.name, shell_hook: b.r.shellHook().state });
  });

  it('tmux のパスが無ければ、tmux の口も画面の口も作らない', () => {
    expect(tmuxOf({ tmuxPath: null })).toBeNull();
    expect(panesOf(null)).toBeNull();
    expect(panesOf(tmuxOf({ tmuxPath: '/opt/tmux' }))).not.toBeNull();
  });

  it('外のターミナルは、いまの設定の tmux のパスを読む', () => {
    const b = boot();
    b.h.settings.current = { ...b.h.settings.current, tmuxPath: null };
    expect(() => b.r.external.openTerminal({ tmuxName: 'hangar-r1' })).toThrow(/tmux が見つかりません/);
  });
});
